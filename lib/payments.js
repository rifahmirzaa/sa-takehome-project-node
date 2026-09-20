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

const CLIENT_SECRET_REGEX = /^pi_[a-zA-Z0-9]+_secret_[a-zA-Z0-9]+$/;

function isValidClientSecret(clientSecret) {
  return typeof clientSecret === 'string' && CLIENT_SECRET_REGEX.test(clientSecret);
}

function extractPaymentIntentId(clientSecret) {
  if (!isValidClientSecret(clientSecret)) {
    return null;
  }
  return clientSecret.split('_secret_')[0];
}

async function createPaymentIntent({ book, attemptId }) {
  const stripe = getClient();
  if (!stripe) {
    throw new Error('Stripe client is not initialized');
  }

  // Idempotency key bounds retries to the specific book and checkout attempt
  const idempotencyKey = `demo-book-${book.id}-attempt-${attemptId}`;

  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: book.amount,
      currency: book.currency,
      capture_method: 'automatic',
      metadata: {
        integration: 'sa-takehome-demo',
        bookId: String(book.id),
        attemptId: String(attemptId)
      }
    },
    { idempotencyKey }
  );

  return paymentIntent.client_secret;
}

async function retrievePaymentIntent(id) {
  const stripe = getClient();
  if (!stripe) {
    throw new Error('Stripe client is not initialized');
  }
  return stripe.paymentIntents.retrieve(id);
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
  getClient,
  setStripeClientForTest,
  isConfigured,
  getPublishableKey,
  isValidClientSecret,
  extractPaymentIntentId,
  createPaymentIntent,
  retrievePaymentIntent,
  constructWebhookEvent
};
