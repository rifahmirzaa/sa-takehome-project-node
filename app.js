const express = require('express');
const path = require('path');
const exphbs = require('express-handlebars');
require('dotenv').config();
const stripe = require('stripe');

const { books, getBookById } = require('./lib/catalog');

var app = express();

// view engine setup (Handlebars)
app.engine('hbs', exphbs({
  defaultLayout: 'main',
  extname: '.hbs'
}));
app.set('view engine', 'hbs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({}));

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

  return res.status(200).render('checkout', {
    book: toBookViewData(book)
  });
});

/**
 * Success route
 */
app.get('/success', function(req, res) {
  res.render('success');
});

/**
 * Start server
 */
app.listen(3000, () => {
  console.log('Getting served on port 3000');
});
