const express = require('express');
const path = require('path');
const exphbs = require('express-handlebars');
require('dotenv').config();

const { books, getBookById } = require('./lib/catalog');
const payments = require('./lib/payments');

const app = express();

// View engine setup (Handlebars)
app.engine('hbs', exphbs({
  defaultLayout: 'main',
  extname: '.hbs'
}));
app.set('view engine', 'hbs');
app.use(express.static(path.join(__dirname, 'public')));

// Webhook requires raw body for cryptographic signature verification before body parsers
app.post('/webhook', express.raw({ type: 'application/json' }), function(req, res) {
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).send('Webhook signature missing');
  }

  let event;
  try {
    event = payments.constructWebhookEvent(req.body, signature);
  } catch (err) {
    return res.status(400).send('Webhook signature verification failed');
  }

  // Event observation only; no fulfillment side effects in this demo
  switch (event.type) {
    case 'payment_intent.succeeded':
    case 'payment_intent.processing':
    case 'payment_intent.payment_failed': {
      const intent = event.data && event.data.object;
      if (intent) {
        console.log(`Payment event ${event.id}: intent ${intent.id} status is ${intent.status}`);
      }
      break;
    }
    default:
      break;
  }

  return res.status(200).json({ received: true });
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json({}));

const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://js.stripe.com https://*.js.stripe.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "frame-src 'self' https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com",
  "connect-src 'self' https://api.stripe.com https://*.stripe.com https://maps.googleapis.com",
  "img-src 'self' data: https://*.stripe.com",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://pro.fontawesome.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com https://pro.fontawesome.com",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

function setSecurePaymentHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', CSP_POLICY);
}

function formatPrice(amount, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase()
  }).format(amount / 100);
}

function toBookViewData(book) {
  return {
    ...book,
    formattedPrice: formatPrice(book.amount, book.currency),
    currencyDisplay: book.currency.toUpperCase()
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Home route
 */
app.get('/', function(req, res) {
  res.render('index', {
    books: books.map(toBookViewData)
  });
});

/**
 * Checkout route
 */
app.get('/checkout', function(req, res) {
  setSecurePaymentHeaders(res);

  const item = req.query.item;

  // Reject missing, empty, or multi-value query items before catalog lookup
  if (typeof item !== 'string' || item === '') {
    return res.status(400).render('checkout', {
      error: 'Select a book to continue.'
    });
  }

  const book = getBookById(item);
  if (!book) {
    return res.status(404).render('checkout', {
      error: 'That book is not available.'
    });
  }

  const configured = payments.isConfigured();

  return res.status(200).render('checkout', {
    book: toBookViewData(book),
    stripeConfigured: configured,
    publishableKey: configured ? payments.getPublishableKey() : null
  });
});

/**
 * Create PaymentIntent endpoint
 */
app.post('/create-payment-intent', async function(req, res) {
  res.set('Cache-Control', 'no-store');

  if (!payments.isConfigured()) {
    return res.status(503).json({ error: 'Payment processing is not configured' });
  }

  const { itemId, attemptId } = req.body || {};

  if (typeof itemId !== 'string' || itemId === '') {
    return res.status(400).json({ error: 'Invalid book selection' });
  }

  const book = getBookById(itemId);
  if (!book) {
    return res.status(400).json({ error: 'Invalid book selection' });
  }

  if (typeof attemptId !== 'string' || !UUID_REGEX.test(attemptId)) {
    return res.status(400).json({ error: 'Invalid attempt ID' });
  }

  try {
    const clientSecret = await payments.createPaymentIntent({ book, attemptId });
    return res.status(200).json({ clientSecret });
  } catch (err) {
    return res.status(500).json({ error: 'Unable to initialize payment' });
  }
});

/**
 * Verified payment status endpoint
 */
app.post('/payment-status', async function(req, res) {
  res.set('Cache-Control', 'no-store');

  const { clientSecret } = req.body || {};

  if (!payments.isValidClientSecret(clientSecret)) {
    return res.status(400).json({ error: 'Invalid payment reference' });
  }

  const intentId = payments.extractPaymentIntentId(clientSecret);

  try {
    const intent = await payments.retrievePaymentIntent(intentId);

    // Verify secret possession and application metadata match the retrieved record
    if (!intent || intent.client_secret !== clientSecret || intent.metadata?.integration !== 'sa-takehome-demo') {
      return res.status(404).json({ error: 'Payment record not found' });
    }

    return res.status(200).json({
      id: intent.id,
      status: intent.status,
      amountReceived: intent.amount_received,
      currency: intent.currency,
      bookId: intent.metadata?.bookId || null,
      attemptId: intent.metadata?.attemptId || null
    });
  } catch (err) {
    // Nonexistent payment intents return 404; transient failures return 502
    if (err.statusCode === 404 || err.code === 'resource_missing') {
      return res.status(404).json({ error: 'Payment record not found' });
    }
    return res.status(502).json({ error: 'Payment status temporarily unavailable' });
  }
});

/**
 * Success confirmation route
 */
app.get('/success', function(req, res) {
  setSecurePaymentHeaders(res);
  res.render('success');
});

// Guard app.listen so tests can import the Express application directly
if (require.main === module) {
  app.listen(3000, () => {
    console.log('Getting served on port 3000');
  });
}

module.exports = app;
