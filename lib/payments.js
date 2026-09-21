const Stripe = require('stripe');

let stripeClient = null;

function getClient() {
  if (!stripeClient && process.env.STRIPE_SECRET_KEY) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-08-26.dahlia'
    });
  }
  return stripeClient;
}

// Allows injecting a mock client for deterministic route tests
function setStripeClientForTest(client) {
  stripeClient = client;
}

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY);
}

function getPublishableKey() {
  return process.env.STRIPE_PUBLISHABLE_KEY || null;
}

// Keep these identifiers stable so existing sessions and retries survive a shop rename
const INTEGRATION = 'book-nook';
const INTEGRATION_IDENTIFIER = 'book-nook-xhbkdpgs';

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && /^cs_(?:test_|live_)?[a-zA-Z0-9]{1,200}$/.test(sessionId);
}

async function createCheckoutSession({ book, attemptId, returnUrl }) {
  const stripe = getClient();
  if (!stripe) throw new Error('Stripe client is not initialized');

  const metadata = { integration: INTEGRATION, bookId: book.id, attemptId };
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ui_mode: 'elements',
    integration_identifier: INTEGRATION_IDENTIFIER,
    line_items: [{
      price_data: {
        currency: book.currency,
        unit_amount: book.amount,
        product_data: { name: book.title }
      },
      quantity: 1
    }],
    adaptive_pricing: { enabled: false },
    metadata,
    payment_intent_data: { metadata, capture_method: 'automatic' },
    return_url: returnUrl
  }, {
    idempotencyKey: `book-nook-session-${book.id}-${attemptId}`
  });

  return { sessionId: session.id, clientSecret: session.client_secret };
}

async function retrieveCheckoutSession(sessionId) {
  const stripe = getClient();
  if (!stripe) throw new Error('Stripe client is not initialized');
  return stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
}

function constructWebhookEvent(payload, signature) {
  const stripe = getClient();
  if (!stripe) {
    throw new Error('Stripe client is not initialized');
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('Stripe webhook secret is not configured');
  }
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

module.exports = {
  INTEGRATION,
  getClient,
  setStripeClientForTest,
  isConfigured,
  getPublishableKey,
  isValidSessionId,
  createCheckoutSession,
  retrieveCheckoutSession,
  constructWebhookEvent
};
