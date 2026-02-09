# dSyncPay

As another part of the dSync library family this library is responsible for payment handling currently supporting PayPal and Coinbase Crypto payments. Its works independently and without any percentage cuts by using your own API keys.

> [!NOTE]
>
> Payment Providers may take a cut from your money or have other fees that are outside of this library's control. 

------

## Setup
```js
import dSyncPay from '@hackthedev/dsync-pay';

// const app = express();
const payments = new dSyncPay({
    app,
    domain: 'https://domain.com',
    basePath: '/payments', // optional, default is '/payments'
    paypal: {
        clientId: 'xxx',
        clientSecret: 'xxx',
        sandbox: true // or false for production
    },
    coinbase: {
        apiKey: 'xxx',
        webhookSecret: 'xxx' // optional
    },
    
    // events from the library
    onPaymentCreated: (data) => {},
    onPaymentCompleted: (data) => {},
    onPaymentFailed: (data) => {},
    onPaymentCancelled: (data) => {},
    onSubscriptionCreated: (data) => {},
    onSubscriptionActivated: (data) => {},
    onSubscriptionCancelled: (data) => {},
    onError: (error) => {}
});
```

------

## PayPal Usage

### Create an order

```js
// returnUrl and cancelUrl are auto-generated based on domain + basePath
const payment = await payments.paypal.createOrder({
    title: 'product name',
    price: 19.99
    // returnUrl automatically becomes https://domain.com/payments/paypal/verify
    // cancelUrl will become https://domain.com/payments/cancel
});

// or override manually
const payment = await payments.paypal.createOrder({
    title: 'product name',
    price: 19.99,
    returnUrl: 'https://custom.com/success',
    cancelUrl: 'https://custom.com/cancel',
    metadata: { userId: '123' }
});

// manual verify. result.status === 'COMPLETED'. see paypal api.
const result = await payments.paypal.verifyOrder(orderId);
```

### Managing subscriptions

```js
// requires you to setup a plan one time
const plan = await payments.paypal.createPlan({
    name: 'monthly premium',
    price: 9.99,
    interval: 'MONTH'
});	
// save plan.planId

// then you can create subscriptions based on that plan
const sub = await payments.paypal.createSubscription({
    planId: 'P-xxxxx'
    // returnUrl becomes https://domain.com/payments/paypal/subscription/verify
    // cancelUrl becomes https://domain.com/payments/cancel
});

// or override manually
const sub = await payments.paypal.createSubscription({
    planId: 'P-xxxxx',
    returnUrl: 'https://custom.com/success',
    cancelUrl: 'https://custom.com/cancel'
});

// redirect to sub.approvalUrl
// also returns sub.subscriptionId

// manually verify subscription
const result = await payments.paypal.verifySubscription(subscriptionId);
// result.status === 'ACTIVE'

// cancel subscription
await payments.paypal.cancelSubscription(subscriptionId, 'reason');
```

------

## Coinbase Usage

### Creating a charge

```js
// redirectUrl and cancelUrl are auto-generated
const charge = await payments.coinbase.createCharge({
    title: 'product name',
    price: 19.99
    // redirectUrl becomes  https://domain.com/payments/coinbase/verify
    // cancelUrl becomes https://domain.com/payments/cancel
});

// or override manually
const charge = await payments.coinbase.createCharge({
    title: 'product name',
    price: 19.99,
    redirectUrl: 'https://custom.com/success',
    cancelUrl: 'https://custom.com/cancel',
    metadata: { userId: '123' }
});

// redirect to: charge.hostedUrl

// manually verify
const result = await payments.coinbase.verifyCharge(chargeCode);
// result.status === 'COMPLETED'
```

------

## Routes

dSyncPay automatically creates verification routes for handling payment returns as well to make the entire payment process as simple and straight forward as possible.

### PayPal
* `GET /payments/paypal/verify?token=xxx`
* `GET /payments/paypal/subscription/verify?subscription_id=xxx`
* `GET /payments/cancel`

### Coinbase
* `GET /payments/coinbase/verify?code=xxx`
* `POST /payments/webhook/coinbase` (if webhookSecret set)
* `GET /payments/cancel`

### Usage Example

```javascript
const order = await payments.paypal.createOrder({
    title: 'premium plan',
    price: 19.99
});

// redirect user to order.approvalUrl
// paypal redirects back to /payments/paypal/verify?token=XXX
// route automatically verifies and triggers onPaymentCompleted
```

### Custom Base Path

```javascript
const payments = new dSyncPay({
    app,
    domain: 'https://domain.com',
    basePath: '/api/pay', // default is '/payments'
    paypal: { ... }
});

// routes: /api/pay/paypal/verify, /api/pay/coinbase/verify, etc.
// auto urls: https://domain.com/api/pay/paypal/verify
```