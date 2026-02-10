# dSyncPay

As another part of the dSync library family this library is responsible for payment handling currently supporting PayPal and Coinbase Crypto payments. It works independently and without any percentage cuts by using your own API keys.

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
    redirects: { // optional, customize redirect pages
        success: '/payment-success',
        error: '/payment-error',
        cancelled: '/payment-cancelled',
        subscriptionSuccess: '/subscription-success',
        subscriptionError: '/subscription-error'
    },
    paypal: {
        clientId: 'xxx',
        clientSecret: 'xxx',
        sandbox: true // or false for production
    },
    coinbase: {
        apiKey: 'xxx',        // coinbase commerce API key
        webhookSecret: 'xxx'  // optional, for webhook verification
    },

    // events
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

### Coinbase API Key

dSyncPay uses **Coinbase Commerce** for crypto payments - not the Coinbase exchange or developer platform. Get your API key at `https://commerce.coinbase.com/settings/security`.

------

## PayPal Usage

### Create an order

```js
const payment = await payments.paypal.createOrder({
    title: 'product name',
    price: 19.99,
    // optional params:
    description: 'product description',   // default: 'no description'
    quantity: 1,                           // default: 1
    currency: 'EUR',                       // default: 'EUR'
    customId: 'your-custom-id',           // default: auto-generated 17-digit id
    metadata: { userId: '123' },          // passed through to onPaymentCompleted
    returnUrl: 'https://custom.com/ok',   // default: https://domain.com/payments/paypal/verify
    cancelUrl: 'https://custom.com/no'    // default: https://domain.com/payments/cancel
});

// redirect user to:
payment.approvalUrl

// result object:
{
    provider: 'paypal',
    type: 'order',
    approvalUrl: '...',
    transactionId: 'customId',
    orderId: '...',
    amount: 19.99,
    currency: 'EUR',
    metadata: {},
    rawResponse: {}
}
```

> [!NOTE] 
>
> metadata is cached in memory for 1 hour and passed through to the payment callbacks automatically.

### Verify an order manually

```js
const result = await payments.paypal.verifyOrder(orderId);
// result.status === 'COMPLETED'
```

### Managing subscriptions

```js
// step 1: create a plan (one time setup)
const plan = await payments.paypal.createPlan({
    name: 'monthly premium',
    price: 9.99,
    interval: 'MONTH',       // MONTH, YEAR, WEEK, DAY
    // optional:
    description: '...',
    currency: 'EUR',         // default: 'EUR'
    frequency: 1             // default: 1
});
// save plan.planId for later use

// step 2: create a subscription
const sub = await payments.paypal.createSubscription({
    planId: 'P-xxxxx',
    // optional:
    customId: 'your-custom-id',
    metadata: { userId: '123' },
    returnUrl: 'https://custom.com/success',  // default: https://domain.com/payments/paypal/subscription/verify
    cancelUrl: 'https://custom.com/cancel'    // default: https://domain.com/payments/cancel
});

// redirect user to:
sub.approvalUrl
// also available: sub.subscriptionId

// step 3: verify subscription manually
const result = await payments.paypal.verifySubscription(subscriptionId);
// result.status === 'ACTIVE'

// cancel a subscription
await payments.paypal.cancelSubscription(subscriptionId, 'reason');
```

------

## Coinbase Usage

### Creating a charge

```js
const charge = await payments.coinbase.createCharge({
    title: 'product name',
    price: 19.99,
    // optional:
    description: 'product description',   // default: 'no description'
    quantity: 1,                           // default: 1
    currency: 'EUR',                       // default: 'EUR'
    metadata: { userId: '123' },
    redirectUrl: 'https://custom.com/ok', // default: https://domain.com/payments/coinbase/verify
    cancelUrl: 'https://custom.com/no'    // default: https://domain.com/payments/cancel
});

// redirect user to:
charge.hostedUrl

// result object:
{
    provider: 'coinbase',
    type: 'charge',
    hostedUrl: '...',
    chargeId: '...',
    chargeCode: '...',
    amount: 19.99,
    currency: 'EUR',
    metadata: {},
    rawResponse: {}
}
```

### Verify a charge manually

```js
const result = await payments.coinbase.verifyCharge(chargeCode);
// result.status === 'COMPLETED'
```

------

## Routes

dSyncPay automatically registers verification routes that handle payment returns from PayPal and Coinbase.

### Verification Routes

#### PayPal

- `GET /payments/paypal/verify?token=xxx`
- `GET /payments/paypal/subscription/verify?subscription_id=xxx`
- `GET /payments/cancel`

#### Coinbase

- `GET /payments/coinbase/verify?code=xxx`
- `POST /payments/webhook/coinbase` (only registered if `webhookSecret` is set)
- `GET /payments/cancel`

### Status Page

After a payment is completed, failed, or cancelled, the user is redirected to a built-in status page at:

```
GET /payments/payment-status.html?status=success&provider=paypal&amount=19.99&currency=EUR
```

The `status` query param controls what is shown:

| status      | description                       |
| ----------- | --------------------------------- |
| `success`   | payment or subscription completed |
| `error`     | payment failed                    |
| `cancelled` | user cancelled                    |

Additional query params (`payment_id`, `provider`, `amount`, `currency`, `type`) are passed through automatically and displayed on the page.

You can customize where users land before the status page using the `redirects` option in the constructor. These are intermediate routes that pass through query params and redirect to the status page.

------

## Custom Configuration

```js
const payments = new dSyncPay({
    app,
    domain: 'https://domain.com',
    basePath: '/api/pay',   // default: '/payments'
    redirects: {
        success: '/custom/success',
        error: '/custom/error',
        cancelled: '/custom/cancelled',
        subscriptionSuccess: '/custom/sub-success',
        subscriptionError: '/custom/sub-error'
    },
    paypal: { ... }
});

// verification routes: /api/pay/paypal/verify, /api/pay/coinbase/verify, etc.
// auto-generated return urls: https://domain.com/api/pay/paypal/verify
// status page: /api/pay/payment-status.html
```

------

## Events

All callbacks receive a data object with at minimum `provider`, `type`, `status`, `metadata`, and `rawResponse`.

| event                     | trigger                               |
| ------------------------- | ------------------------------------- |
| `onPaymentCreated`        | order or charge was created           |
| `onPaymentCompleted`      | payment verified as completed         |
| `onPaymentFailed`         | payment failed or expired             |
| `onPaymentCancelled`      | user cancelled payment                |
| `onSubscriptionCreated`   | subscription was created              |
| `onSubscriptionActivated` | subscription verified as active       |
| `onSubscriptionCancelled` | subscription was cancelled            |
| `onError`                 | internal error (auth, api call, etc.) |