const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Stripe = require('stripe');
const app = require('../app');
const payments = require('../lib/payments');

const attemptId = '550e8400-e29b-41d4-a716-446655440000';
const sessionId = 'cs_test_book1';
const metadata = { integration: payments.INTEGRATION, bookId: '1', attemptId };
const intent = { id: 'pi_book1', status: 'succeeded', amount_received: 2300, currency: 'usd' };
const session = { id: sessionId, mode: 'payment', status: 'complete', payment_status: 'paid',
  metadata, currency: 'usd', payment_intent: intent };

async function server(t, client = {}) {
  const previous = { secret: process.env.STRIPE_SECRET_KEY, publishable: process.env.STRIPE_PUBLISHABLE_KEY,
    webhook: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fixture';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture';
  payments.setStripeClientForTest(client);
  const listener = http.createServer(app);
  await new Promise(resolve => listener.listen(0, resolve));
  t.after(async () => {
    await new Promise(resolve => listener.close(resolve));
    payments.setStripeClientForTest(null);
    for (const [name, value] of Object.entries({ STRIPE_SECRET_KEY: previous.secret,
      STRIPE_PUBLISHABLE_KEY: previous.publishable, STRIPE_WEBHOOK_SECRET: previous.webhook })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const base = `http://localhost:${listener.address().port}`;
  return {
    base,
    post: (url, body) => fetch(base + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
  };
}

test('checkout resolves catalog prices and provides payment security headers', async t => {
  const { base } = await server(t);
  for (const path of ['/checkout?item=1', '/success']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy'), /js\.stripe\.com/);
  }
  const html = await (await fetch(base + '/checkout?item=1')).text();
  assert.match(html, /\$23\.00/);
  assert.match(html, /checkout-email/);
  assert.match(html, /js\.stripe\.com\/dahlia\/stripe.js/);
  assert.equal((await fetch(base + '/checkout?item=999')).status, 404);
  assert.equal((await fetch(base + '/checkout?item=1&item=2')).status, 400);
});

test('session creation rejects incomplete configuration and invalid selections or attempts', async t => {
  const { post, base } = await server(t);
  for (const body of [{}, { itemId: '999', attemptId }, { itemId: 1, attemptId },
    { itemId: '1', attemptId: 'invalid' }]) {
    assert.equal((await post('/create-checkout-session', body)).status, 400);
  }
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  assert.equal((await post('/create-checkout-session', { itemId: '1', attemptId })).status, 503);
  assert.match(await (await fetch(base + '/checkout?item=1')).text(), /configuration is incomplete/);
});

test('session creation uses catalog line items, stable retries, and metadata on Session and PaymentIntent', async t => {
  const calls = [];
  const { post, base } = await server(t, { checkout: { sessions: {
    create: async (params, options) => {
      calls.push({ params, options });
      return { id: sessionId, client_secret: 'cs_test_book1_secret_fixture' };
    }
  } } });
  for (let i = 0; i < 2; i++) {
    const res = await post('/create-checkout-session', { itemId: '1', attemptId, amount: 1,
      currency: 'jpy', returnUrl: 'https://untrusted.example', quantity: 99 });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { sessionId, clientSecret: 'cs_test_book1_secret_fixture' });
  }
  const { params, options } = calls[0];
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(params.mode, 'payment');
  assert.equal(params.ui_mode, 'elements');
  assert.equal(params.line_items[0].price_data.unit_amount, 2300);
  assert.equal(params.line_items[0].price_data.currency, 'usd');
  assert.match(params.line_items[0].price_data.product_data.name, /Science and Engineering/);
  assert.equal(params.line_items[0].quantity, 1);
  assert.deepEqual(params.metadata, metadata);
  assert.deepEqual(params.payment_intent_data.metadata, metadata);
  assert.equal(params.return_url, base + '/success?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(params.payment_method_types, undefined);
  assert.equal(params.adaptive_pricing.enabled, false);
  assert.match(params.integration_identifier, /^book-nook-[a-z]{8}$/);
  assert.match(options.idempotencyKey, new RegExp(attemptId));
  await post('/create-checkout-session', { itemId: '2', attemptId });
  assert.notEqual(calls[2].options.idempotencyKey, options.idempotencyKey);
});

test('creation errors do not expose Stripe credentials or raw error details', async t => {
  const { post } = await server(t, { checkout: { sessions: {
    create: async () => { throw new Error('sk_test_private fixture failure'); }
  } } });
  const res = await post('/create-checkout-session', { itemId: '1', attemptId });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'Unable to initialize payment' });
});

test('receipt retrieves the session with its payment and returns only verified display fields', async t => {
  const { post } = await server(t, { checkout: { sessions: { retrieve: async (id, options) => {
    assert.equal(id, sessionId);
    assert.deepEqual(options, { expand: ['payment_intent'] });
    return { ...session, client_secret: 'private', customer_details: { email: 'private@example.com' } };
  } } } });
  const res = await post('/checkout-status', { sessionId });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { sessionId, status: 'complete', paymentStatus: 'paid',
    paymentIntentStatus: 'succeeded', id: 'pi_book1', amountReceived: 2300, currency: 'usd', bookId: '1', attemptId });
});

test('receipt rejects malformed, unrelated, and non-payment session references', async t => {
  let record = session;
  const { post } = await server(t, { checkout: { sessions: { retrieve: async () => record } } });
  for (const value of [null, '', 'pi_old', ['cs_test_book1'], 'cs_test_x?expand=customer']) {
    assert.equal((await post('/checkout-status', { sessionId: value })).status, 400);
  }
  for (const other of [{ ...session, metadata: {} }, { ...session, mode: 'subscription' }, null]) {
    record = other;
    assert.equal((await post('/checkout-status', { sessionId })).status, 404);
  }
});

test('paid receipt waits for a verified successful underlying PaymentIntent', async t => {
  let record = session;
  const { post } = await server(t, { checkout: { sessions: { retrieve: async () => record } } });
  for (const payment_intent of [null, 'pi_unexpanded', { ...intent, status: 'processing' }]) {
    record = { ...session, payment_intent };
    assert.equal((await post('/checkout-status', { sessionId })).status, 502);
  }
});

test('open, expired, and delayed sessions never claim successful payment', async t => {
  let record;
  const { post } = await server(t, { checkout: { sessions: { retrieve: async () => record } } });
  for (const state of ['open', 'expired', 'complete']) {
    record = { ...session, status: state, payment_status: 'unpaid', payment_intent: null };
    const res = await post('/checkout-status', { sessionId });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, state);
    assert.equal(data.paymentStatus, 'unpaid');
    assert.equal(data.amountReceived, null);
  }
});

test('missing sessions return 404 while temporary retrieval failures return 502', async t => {
  let missing = true;
  const { post } = await server(t, { checkout: { sessions: { retrieve: async () => {
    throw missing ? { code: 'resource_missing' } : new Error('Temporary connection failure');
  } } } });
  assert.equal((await post('/checkout-status', { sessionId })).status, 404);
  missing = false;
  assert.equal((await post('/checkout-status', { sessionId })).status, 502);
});

test('webhook verifies raw signatures and observes paid, unpaid, failed, and expired session events', async t => {
  const stripe = new Stripe('sk_test_fixture');
  const { base } = await server(t, { webhooks: stripe.webhooks });
  const logs = [];
  const originalLog = console.log;
  console.log = message => logs.push(message);
  t.after(() => { console.log = originalLog; });
  const send = (payload, signature) => fetch(base + '/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'Stripe-Signature': signature } : {}) }, body: payload });
  for (const [type, payment_status] of [['checkout.session.completed', 'paid'],
    ['checkout.session.completed', 'unpaid'], ['checkout.session.async_payment_succeeded', 'paid'],
    ['checkout.session.async_payment_failed', 'unpaid'], ['checkout.session.expired', 'unpaid']]) {
    const payload = JSON.stringify({ id: 'evt_fixture', type, data: { object: { ...session, payment_status } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_fixture' });
    assert.equal((await send(payload, signature)).status, 200);
    assert.match(logs.at(-1), new RegExp(type.replaceAll('.', '\\.')));
    assert.match(logs.at(-1), new RegExp('payment ' + payment_status));
    assert.equal((await send(payload + ' ', signature)).status, 400);
    assert.equal((await send(payload)).status, 400);
  }
  const ignored = JSON.stringify({ id: 'evt_other', type: 'checkout.session.completed', data: { object: { ...session, metadata: {} } } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload: ignored, secret: 'whsec_fixture' });
  assert.equal((await send(ignored, signature)).status, 200);
  assert.equal(logs.length, 5);
});
