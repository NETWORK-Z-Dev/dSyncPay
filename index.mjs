import crypto from "crypto";

export default class dSyncPay {
    constructor({
        app = null,
        paypal = null,
        coinbase = null,
        onPaymentCreated = null,
        onPaymentCompleted = null,
        onPaymentFailed = null,
        onPaymentCancelled = null,
        onSubscriptionCreated = null,
        onSubscriptionActivated = null,
        onSubscriptionCancelled = null,
        onError = null
    } = {}) {
        if (!app) throw new Error("missing express app instance");

        this.app = app;
        this.callbacks = {
            onPaymentCreated,
            onPaymentCompleted,
            onPaymentFailed,
            onPaymentCancelled,
            onSubscriptionCreated,
            onSubscriptionActivated,
            onSubscriptionCancelled,
            onError
        };

        if (paypal) {
            if (!paypal.clientId) throw new Error("missing paypal.clientId");
            if (!paypal.clientSecret) throw new Error("missing paypal.clientSecret");
            this.paypal = new this.PayPal(this, paypal);
        }

        if (coinbase) {
            if (!coinbase.apiKey) throw new Error("missing coinbase.apiKey");
            this.coinbase = new this.Coinbase(this, coinbase);
        }
    }

    emit(event, data) {
        const callback = this.callbacks[event];
        if (callback) {
            try {
                callback(data);
            } catch (err) {
                console.error("callback error:", err);
            }
        }
    }

    generateId(length = 17) {
        let id = '';
        for (let i = 0; i < length; i++) {
            id += Math.floor(Math.random() * 10);
        }
        return id;
    }

    sha256(data) {
        return crypto.createHash("sha256").update(data).digest("hex");
    }

    async request(url, options = {}) {
        const {
            method = 'GET',
            headers = {},
            body = null,
            auth = null,
            params = null
        } = options;

        let finalUrl = url;
        if (params) {
            const query = new URLSearchParams(params).toString();
            finalUrl = `${url}?${query}`;
        }

        const fetchOptions = {
            method,
            headers: { ...headers }
        };

        if (auth) {
            const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
            fetchOptions.headers['Authorization'] = `Basic ${credentials}`;
        }

        if (body) {
            fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
            if (!fetchOptions.headers['Content-Type']) {
                fetchOptions.headers['Content-Type'] = 'application/json';
            }
        }

        const response = await fetch(finalUrl, fetchOptions);
        const text = await response.text();
        
        if (!response.ok) {
            const error = new Error(`http error: ${response.status}`);
            error.status = response.status;
            error.response = text ? JSON.parse(text) : null;
            throw error;
        }

        return text ? JSON.parse(text) : null;
    }

    PayPal = class {
        constructor(parent, config) {
            this.parent = parent;
            this.config = config;
            this.baseUrl = config.sandbox
                ? 'https://api-m.sandbox.paypal.com'
                : 'https://api-m.paypal.com';
            this.tokenCache = null;
            this.tokenExpiry = null;
        }

        async getAccessToken() {
            if (this.tokenCache && this.tokenExpiry > Date.now()) {
                return this.tokenCache;
            }

            try {
                const response = await this.parent.request(
                    `${this.baseUrl}/v1/oauth2/token`,
                    {
                        method: 'POST',
                        auth: {
                            username: this.config.clientId,
                            password: this.config.clientSecret
                        },
                        params: {
                            grant_type: 'client_credentials'
                        },
                        headers: {
                            "Accept": "application/json",
                            "Accept-Language": "en_US"
                        }
                    }
                );

                this.tokenCache = response.access_token;
                this.tokenExpiry = Date.now() + (60 * 60 * 1000);
                return this.tokenCache;
            } catch (error) {
                this.parent.emit('onError', {
                    type: 'auth',
                    provider: 'paypal',
                    error: error.response || error.message
                });
                throw error;
            }
        }

        async createOrder({
            title,
            description = 'no description',
            price,
            quantity = 1,
            currency = 'EUR',
            returnUrl,
            cancelUrl,
            customId = this.parent.generateId(),
            metadata = {}
        }) {
            if (!title) throw new Error('missing title');
            if (!price) throw new Error('missing price');
            if (!returnUrl) throw new Error('missing returnUrl');
            if (!cancelUrl) throw new Error('missing cancelUrl');

            const accessToken = await this.getAccessToken();
            const totalAmount = (price * quantity).toFixed(2);

            const orderPayload = {
                intent: "CAPTURE",
                purchase_units: [{
                    amount: {
                        currency_code: currency,
                        value: totalAmount,
                        breakdown: {
                            item_total: {
                                currency_code: currency,
                                value: totalAmount
                            }
                        }
                    },
                    items: [{
                        name: title,
                        description: description,
                        unit_amount: {
                            currency_code: currency,
                            value: price.toFixed(2)
                        },
                        quantity: `${quantity}`
                    }],
                    custom_id: customId
                }],
                application_context: {
                    return_url: returnUrl,
                    cancel_url: cancelUrl
                }
            };

            try {
                const response = await this.parent.request(
                    `${this.baseUrl}/v2/checkout/orders`,
                    {
                        method: 'POST',
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${accessToken}`
                        },
                        body: orderPayload
                    }
                );

                const approvalUrl = response.links.find(link => link.rel === "approve").href;

                const result = {
                    provider: 'paypal',
                    type: 'order',
                    approvalUrl,
                    transactionId: customId,
                    orderId: response.id,
                    amount: parseFloat(totalAmount),
                    currency,
                    metadata,
                    rawResponse: response
                };

                this.parent.emit('onPaymentCreated', result);
                return result;
            } catch (error) {
                this.parent.emit('onError', {
                    type: 'order_creation',
                    provider: 'paypal',
                    error: error.response || error.message
                });
                throw error;
            }
        }

        async verifyOrder(orderId) {
            const accessToken = await this.getAccessToken();

            try {
                const orderResponse = await this.parent.request(
                    `${this.baseUrl}/v2/checkout/orders/${orderId}`,
                    {
                        headers: {
                            "Authorization": `Bearer ${accessToken}`
                        }
                    }
                );

                const orderStatus = orderResponse.status;

                if (orderStatus === "APPROVED") {
                    await this.parent.request(
                        `${this.baseUrl}/v2/checkout/orders/${orderId}/capture`,
                        {
                            method: 'POST',
                            headers: {
                                "Authorization": `Bearer ${accessToken}`
                            },
                            body: {}
                        }
                    );
                }

                const purchaseUnit = orderResponse.purchase_units[0];

                const result = {
                    provider: 'paypal',
                    type: 'order',
                    status: orderStatus,
                    transactionId: purchaseUnit.custom_id,
                    orderId: orderResponse.id,
                    amount: parseFloat(purchaseUnit.amount.value),
                    currency: purchaseUnit.amount.currency_code,
                    rawResponse: orderResponse
                };

                if (orderStatus === 'COMPLETED') {
                    this.parent.emit('onPaymentCompleted', result);
                } else if (orderStatus === 'VOIDED') {
                    this.parent.emit('onPaymentCancelled', result);
                }

                return result;
            } catch (error) {
                this.parent.emit('onError', {
                    type: 'order_verification',
                    provider: 'paypal',
                    orderId,
                    error: error.response || error.message
                });
                throw error;
            }
        }

        async createProduct(name, description) {
            const accessToken = await this.getAccessToken();

            const productData = {
                name: name,
                description: description || name,
                type: "SERVICE",
                category: "SOFTWARE"
            };

            const response = await this.parent.request(
                `${this.baseUrl}/v1/catalogs/products`,
                {
                    method: 'POST',
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${accessToken}`
                    },
                    body: productData
                }
            );

            return response.id;
        }

        async createPlan({
            name,
            description,
            price,
            currency = 'EUR',
            interval = 'MONTH',
            frequency = 1
        }) {
            if (!name) throw new Error('missing name');
            if (!price) throw new Error('missing price');

            const accessToken = await this.getAccessToken();
            const productId = await this.createProduct(name, description);

            const planData = {
                product_id: productId,
                name: name,
                description: description || name,
                billing_cycles: [{
                    frequency: {
                        interval_unit: interval,
                        interval_count: frequency
                    },
                    tenure_type: "REGULAR",
                    sequence: 1,
                    total_cycles: 0,
                    pricing_scheme: {
                        fixed_price: {
                            value: price.toFixed(2),
                            currency_code: currency
                        }
                    }
                }],
                payment_preferences: {
                    auto_bill_outstanding: true,
                    payment_failure_threshold: 3
                }
            };

            try {
                const response = await this.parent.request(
                    `${this.baseUrl}/v1/billing/plans`,
                    {
                        method: 'POST',
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${accessToken}`
                        },
                        body: planData
                    }
                );

                return {
                    provider: 'paypal',
                    type: 'subscription_plan',
                    planId: response.id,
                    name,
                    price: parseFloat(price),
                    currency,
                    interval,
                    frequency,
                    rawResponse: response
                };
            } catch (error) {
                this.parent.emit('onError', {
                    type: 'plan_creation',
                    provider: 'paypal',
                    error: error.response || error.message
                });
                throw error;
            }
        }

        async createSubscription({
            planId,
            returnUrl,
            cancelUrl,
            customId = this.parent.generateId(),
            metadata = {}
        }) {
            if (!planId) throw new Error('missing planId');
            if (!returnUrl) throw new Error('missing returnUrl');
            if (!cancelUrl) throw new Error('missing cancelUrl');

            const accessToken = await this.getAccessToken();

            const subscriptionData = {
                plan_id: planId,
                custom_id: customId,
                application_context: {
                    return_url: returnUrl,
                    cancel_url: cancelUrl
                }
            };

            try {
                const response = await this.parent.request(
                    `${this.baseUrl}/v1/billing/subscriptions`,
                    {
                        method: 'POST',
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${accessToken}`
                        },
                        body: subscriptionData
                    }
                );

                const approvalUrl = response.links.find(link => link.rel === "approve").href;

                const result = {
                    provider: 'paypal',
                    type: 'subscription',
                    approvalUrl,
                    transactionId: customId,
                    subscriptionId: response.id,
                    planId,
                    metadata,
                    rawResponse: response
                };

                this.parent.emit('onSubscriptionCreated', result);
                return result;
            } catch (error) {
                this.parent.emit('onError', {
                    type: 'subscription_creation',
                    provider: 'paypal',
                    error: error.response || error.message
                });
                throw error;
            }
        }

        async verifySubscription(subscriptionId) {
            const accessToken = await this.getAccessToken();

            try {
                const response = await this.parent.request(
                    `${this.baseUrl}/v1/billing/subscriptions/${subscriptionId}`,
                    {
                        headers: {
                            "Authorization": `Bearer ${accessToken}`
                        }
                    }
                );

                const result = {
                    provider: 'paypal',
                    type: 'subscription',
                    status: response.status,
                    subscriptionId: response.id,
                    planId: response.plan_id,
                    customId: response.custom_id,
                    rawResponse: response
                };

                if (response.status === 'ACTIVE') {
                    this.parent.emit('onSubscriptionActivated', result);
                } else if (response.status === 'CANCELLED') {
                    this.parent.emit('onSubscriptionCancelled', result);
                }

                return result;
            } catch (error) {
                this.parent.emit('onError', {
                    type: 'subscription_verification',
                    provider: 'paypal',
                    subscriptionId,
                    error: error.response || error.message
                });
                throw error;
            }
        }

        async cancelSubscription(subscriptionId, reason = 'customer request') {
            const accessToken = await this.getAccessToken();

            try {
                await this.parent.request(
                    `${this.baseUrl}/v1/billing/subscriptions/${subscriptionId}/cancel`,
                    {
                        method: 'POST',
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${accessToken}`
                        },
                        body: { reason }
                    }
                );

                const result = {
                    provider: 'paypal',
                    type: 'subscription',
                    subscriptionId,
                    status: 'CANCELLED',
                    reason
                };

                this.parent.emit('onSubscriptionCancelled', result);
                return result;
            } catch (error) {
                this.parent.emit('onError', {
                    type: 'subscription_cancellation',
                    provider: 'paypal',
                    subscriptionId,
                    error: error.response || error.message
                });
                throw error;
            }
        }
    }

    Coinbase = class {
        constructor(parent, config) {
            this.parent = parent;
            this.config = config;
            this.baseUrl = 'https://api.commerce.coinbase.com';
        }

        async createCharge({
            title,
            description = 'no description',
            price,
            quantity = 1,
            currency = 'EUR',
            redirectUrl,
            cancelUrl,
            metadata = {}
        }) {
            if (!title) throw new Error('missing title');
            if (!price) throw new Error('missing price');
            if (!redirectUrl) throw new Error('missing redirectUrl');
            if (!cancelUrl) throw new Error('missing cancelUrl');

            const totalAmount = (price * quantity).toFixed(2);

            const chargeData = {
                name: title,
                description: description,
                pricing_type: "fixed_price",
                metadata: metadata,
                local_price: {
                    amount: totalAmount,
                    currency: currency
                },
                redirect_url: redirectUrl,
                cancel_url: cancelUrl
            };

            try {
                const response = await this.parent.request(
                    `${this.baseUrl}/charges`,
                    {
                        method: 'POST',
                        headers: {
                            "Content-Type": "application/json",
                            "X-CC-Api-Key": this.config.apiKey,
                            "X-CC-Version": "2018-03-22"
                        },
                        body: chargeData
                    }
                );

                const charge = response.data;

                const result = {
                    provider: 'coinbase',
                    type: 'charge',
                    hostedUrl: charge.hosted_url,
                    chargeId: charge.id,
                    chargeCode: charge.code,
                    amount: parseFloat(totalAmount),
                    currency,
                    metadata,
                    rawResponse: charge
                };

                this.parent.emit('onPaymentCreated', result);
                return result;
            } catch (error) {
                this.parent.emit('onError', {
                    type: 'charge_creation',
                    provider: 'coinbase',
                    error: error.response || error.message
                });
                throw error;
            }
        }

        async verifyCharge(chargeId) {
            try {
                const response = await this.parent.request(
                    `${this.baseUrl}/charges/${chargeId}`,
                    {
                        headers: {
                            "Content-Type": "application/json",
                            "X-CC-Api-Key": this.config.apiKey,
                            "X-CC-Version": "2018-03-22"
                        }
                    }
                );

                const charge = response.data;
                const latestStatus = charge.timeline[charge.timeline.length - 1]?.status;

                const result = {
                    provider: 'coinbase',
                    type: 'charge',
                    status: latestStatus,
                    chargeId: charge.id,
                    chargeCode: charge.code,
                    amount: parseFloat(charge.pricing.local.amount),
                    currency: charge.pricing.local.currency,
                    metadata: charge.metadata,
                    rawResponse: charge
                };

                if (latestStatus === 'COMPLETED') {
                    this.parent.emit('onPaymentCompleted', result);
                } else if (latestStatus === 'CANCELED') {
                    this.parent.emit('onPaymentCancelled', result);
                } else if (latestStatus === 'EXPIRED' || latestStatus === 'UNRESOLVED') {
                    this.parent.emit('onPaymentFailed', result);
                }

                return result;
            } catch (error) {
                this.parent.emit('onError', {
                    type: 'charge_verification',
                    provider: 'coinbase',
                    chargeId,
                    error: error.response || error.message
                });
                throw error;
            }
        }

        verifyWebhook(payload, signature, secret) {
            const hmac = crypto.createHmac('sha256', secret);
            hmac.update(payload);
            const computedSignature = hmac.digest('hex');
            return computedSignature === signature;
        }
    }

    registerRoutes({
        basePath = '/payments',
        canCreate = null,
        canVerify = null,
        onPaymentCreate = null,
        onPaymentVerify = null
    } = {}) {

        const createMw = canCreate
            ? async (req, res, next) => {
                try {
                    const allowed = await canCreate(req);
                    if (!allowed) return res.status(403).json({ ok: false, error: 'forbidden' });
                    next();
                } catch (e) {
                    return res.status(500).json({ ok: false, error: 'server_error' });
                }
            }
            : (req, res, next) => next();

        const verifyMw = canVerify
            ? async (req, res, next) => {
                try {
                    const allowed = await canVerify(req);
                    if (!allowed) return res.status(403).json({ ok: false, error: 'forbidden' });
                    next();
                } catch (e) {
                    return res.status(500).json({ ok: false, error: 'server_error' });
                }
            }
            : (req, res, next) => next();

        if (this.paypal) {
            this.app.post(`${basePath}/paypal/order`, createMw, async (req, res) => {
                try {
                    const result = await this.paypal.createOrder(req.body);
                    if (onPaymentCreate) await onPaymentCreate(req, result);
                    res.json({ ok: true, ...result });
                } catch (error) {
                    res.status(500).json({ ok: false, error: error.message });
                }
            });

            this.app.get(`${basePath}/paypal/verify`, verifyMw, async (req, res) => {
                try {
                    const orderId = req.query.token;
                    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_token' });
                    
                    const result = await this.paypal.verifyOrder(orderId);
                    if (onPaymentVerify) await onPaymentVerify(req, result);
                    res.json({ ok: true, ...result });
                } catch (error) {
                    res.status(500).json({ ok: false, error: error.message });
                }
            });

            this.app.post(`${basePath}/paypal/plan`, createMw, async (req, res) => {
                try {
                    const result = await this.paypal.createPlan(req.body);
                    res.json({ ok: true, ...result });
                } catch (error) {
                    res.status(500).json({ ok: false, error: error.message });
                }
            });

            this.app.post(`${basePath}/paypal/subscription`, createMw, async (req, res) => {
                try {
                    const result = await this.paypal.createSubscription(req.body);
                    if (onPaymentCreate) await onPaymentCreate(req, result);
                    res.json({ ok: true, ...result });
                } catch (error) {
                    res.status(500).json({ ok: false, error: error.message });
                }
            });

            this.app.get(`${basePath}/paypal/subscription/verify`, verifyMw, async (req, res) => {
                try {
                    const subscriptionId = req.query.subscription_id;
                    if (!subscriptionId) return res.status(400).json({ ok: false, error: 'missing_subscription_id' });
                    
                    const result = await this.paypal.verifySubscription(subscriptionId);
                    if (onPaymentVerify) await onPaymentVerify(req, result);
                    res.json({ ok: true, ...result });
                } catch (error) {
                    res.status(500).json({ ok: false, error: error.message });
                }
            });

            this.app.post(`${basePath}/paypal/subscription/cancel`, verifyMw, async (req, res) => {
                try {
                    const { subscriptionId, reason } = req.body;
                    if (!subscriptionId) return res.status(400).json({ ok: false, error: 'missing_subscription_id' });
                    
                    const result = await this.paypal.cancelSubscription(subscriptionId, reason);
                    res.json({ ok: true, ...result });
                } catch (error) {
                    res.status(500).json({ ok: false, error: error.message });
                }
            });
        }

        if (this.coinbase) {
            this.app.post(`${basePath}/coinbase/charge`, createMw, async (req, res) => {
                try {
                    const result = await this.coinbase.createCharge(req.body);
                    if (onPaymentCreate) await onPaymentCreate(req, result);
                    res.json({ ok: true, ...result });
                } catch (error) {
                    res.status(500).json({ ok: false, error: error.message });
                }
            });

            this.app.get(`${basePath}/coinbase/verify`, verifyMw, async (req, res) => {
                try {
                    const chargeCode = req.query.code;
                    if (!chargeCode) return res.status(400).json({ ok: false, error: 'missing_code' });
                    
                    const result = await this.coinbase.verifyCharge(chargeCode);
                    if (onPaymentVerify) await onPaymentVerify(req, result);
                    res.json({ ok: true, ...result });
                } catch (error) {
                    res.status(500).json({ ok: false, error: error.message });
                }
            });

            if (this.coinbase.config.webhookSecret) {
                this.app.post(`${basePath}/webhook/coinbase`, async (req, res) => {
                    try {
                        const signature = req.headers['x-cc-webhook-signature'];
                        const isValid = this.coinbase.verifyWebhook(
                            JSON.stringify(req.body),
                            signature,
                            this.coinbase.config.webhookSecret
                        );

                        if (!isValid) return res.status(401).json({ ok: false, error: 'invalid_signature' });

                        const event = req.body;
                        
                        if (event.event.type === 'charge:confirmed') {
                            const chargeId = event.event.data.id;
                            const result = await this.coinbase.verifyCharge(chargeId);
                        }

                        res.status(200).json({ ok: true });
                    } catch (error) {
                        res.status(500).json({ ok: false, error: 'webhook_error' });
                    }
                });
            }
        }

        return this;
    }
}
