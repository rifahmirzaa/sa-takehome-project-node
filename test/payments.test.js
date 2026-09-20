const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const app = require('../app');
const payments = require('../lib/payments');

// Helper to start the Express app on a dynamic ephemeral port
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const baseUrl = `http://localhost:${port}`;
      resolve({
        server,
        baseUrl,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

test('GET /checkout security headers and catalog resolution', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/checkout?item=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy'), /js\.stripe\.com/);
  } finally {
    await close();
  }
});

test('POST /create-payment-intent rejects when unconfigured or inputs are invalid', async () => {
  const { baseUrl, close } = await startServer();
  const prevSecretKey = process.env.STRIPE_SECRET_KEY;
  const prevPubKey = process.env.STRIPE_PUBLISHABLE_KEY;

  try {
    // Unconfigured returns 503
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    const resUnconfigured = await fetch(`${baseUrl}/create-payment-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: '1', attemptId: '550e8400-e29b-41d4-a716-446655440000' })
    });
    assert.equal(resUnconfigured.status, 503);

    // When configured, invalid inputs return 400
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake';

    // Missing itemId
    const res1 = await fetch(`${baseUrl}/create-payment-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId: '550e8400-e29b-41d4-a716-446655440000' })
    });
    assert.equal(res1.status, 400);

    // Invalid catalog ID
    const res2 = await fetch(`${baseUrl}/create-payment-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: '999', attemptId: '550e8400-e29b-41d4-a716-446655440000' })
    });
    assert.equal(res2.status, 400);

    // Non-UUID attempt ID
    const res3 = await fetch(`${baseUrl}/create-payment-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: '1', attemptId: 'not-a-uuid' })
    });
    assert.equal(res3.status, 400);
  } finally {
    process.env.STRIPE_SECRET_KEY = prevSecretKey;
    process.env.STRIPE_PUBLISHABLE_KEY = prevPubKey;
    await close();
  }
});

test('POST /create-payment-intent enforces catalog prices and returns client secret', async () => {
  let createdParams = null;
  let idempotencyHeader = null;

  const mockClient = {
    paymentIntents: {
      create: async (params, options) => {
        createdParams = params;
        idempotencyHeader = options && options.idempotencyKey;
        return { client_secret: 'pi_test123_secret_xyz456' };
      }
    }
  };

  payments.setStripeClientForTest(mockClient);

  const prevSecretKey = process.env.STRIPE_SECRET_KEY;
  const prevPubKey = process.env.STRIPE_PUBLISHABLE_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake';

  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/create-payment-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemId: '1',
        attemptId: '550e8400-e29b-41d4-a716-446655440000',
        amount: 1, // client attempts to override price
        currency: 'jpy' // client attempts to override currency
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.clientSecret, 'pi_test123_secret_xyz456');

    // Verify catalog values were used, ignoring client attempts
    assert.equal(createdParams.amount, 2300);
    assert.equal(createdParams.currency, 'usd');
    assert.equal(createdParams.capture_method, 'automatic');
    assert.equal(createdParams.metadata.bookId, '1');
    assert.equal(createdParams.metadata.attemptId, '550e8400-e29b-41d4-a716-446655440000');
    assert.equal(idempotencyHeader, 'demo-book-1-attempt-550e8400-e29b-41d4-a716-446655440000');
  } finally {
    process.env.STRIPE_SECRET_KEY = prevSecretKey;
    process.env.STRIPE_PUBLISHABLE_KEY = prevPubKey;
    payments.setStripeClientForTest(null);
    await close();
  }
});

test('POST /payment-status validates secret and returns verified status', async () => {
  const mockClient = {
    paymentIntents: {
      retrieve: async (id) => {
        if (id === 'pi_success123') {
          return {
            id: 'pi_success123',
            client_secret: 'pi_success123_secret_valid',
            status: 'succeeded',
            amount_received: 2300,
            currency: 'usd',
            metadata: {
              integration: 'sa-takehome-demo',
              bookId: '1',
              attemptId: '550e8400-e29b-41d4-a716-446655440000'
            }
          };
        }
        if (id === 'pi_unrelated') {
          return {
            id: 'pi_unrelated',
            client_secret: 'pi_unrelated_secret_valid',
            status: 'succeeded',
            amount_received: 5000,
            currency: 'usd',
            metadata: {}
          };
        }
        throw new Error('Not found');
      }
    }
  };

  payments.setStripeClientForTest(mockClient);

  const { baseUrl, close } = await startServer();
  try {
    // Malformed client secret
    const res1 = await fetch(`${baseUrl}/payment-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientSecret: 'invalid_secret' })
    });
    assert.equal(res1.status, 400);

    // Mismatched or non-demo intent
    const res2 = await fetch(`${baseUrl}/payment-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientSecret: 'pi_unrelated_secret_valid' })
    });
    assert.equal(res2.status, 404);

    // Verified intent
    const res3 = await fetch(`${baseUrl}/payment-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientSecret: 'pi_success123_secret_valid' })
    });
    assert.equal(res3.status, 200);
    const data = await res3.json();
    assert.equal(data.id, 'pi_success123');
    assert.equal(data.status, 'succeeded');
    assert.equal(data.amountReceived, 2300);
    assert.equal(data.currency, 'usd');
    assert.equal(data.bookId, '1');
    assert.equal(data.attemptId, '550e8400-e29b-41d4-a716-446655440000');
    // Ensure sensitive fields are not returned
    assert.equal(data.clientSecret, undefined);
    assert.equal(data.customer, undefined);
  } finally {
    payments.setStripeClientForTest(null);
    await close();
  }
});

test('POST /webhook verifies signature and handles events safely', async () => {
  let webhookPayload = null;
  let webhookSig = null;

  const mockClient = {
    webhooks: {
      constructEvent: (payload, signature, secret) => {
        webhookPayload = payload;
        webhookSig = signature;
        if (signature === 'valid_signature') {
          return {
            id: 'evt_test123',
            type: 'payment_intent.succeeded',
            data: {
              object: {
                id: 'pi_test123',
                status: 'succeeded'
              }
            }
          };
        }
        throw new Error('Invalid signature');
      }
    }
  };

  payments.setStripeClientForTest(mockClient);
  const prevWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

  const { baseUrl, close } = await startServer();
  try {
    // Missing signature
    const res1 = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'payment_intent.succeeded' })
    });
    assert.equal(res1.status, 400);

    // Invalid signature
    const res2 = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': 'invalid_signature'
      },
      body: JSON.stringify({ type: 'payment_intent.succeeded' })
    });
    assert.equal(res2.status, 400);

    // Valid signature
    const res3 = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': 'valid_signature'
      },
      body: JSON.stringify({ type: 'payment_intent.succeeded' })
    });
    assert.equal(res3.status, 200);
    const data = await res3.json();
    assert.equal(data.received, true);
    assert.ok(Buffer.isBuffer(webhookPayload));
  } finally {
    process.env.STRIPE_WEBHOOK_SECRET = prevWebhookSecret;
    payments.setStripeClientForTest(null);
    await close();
  }
});
