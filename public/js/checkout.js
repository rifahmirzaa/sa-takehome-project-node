(function() {
  const checkoutData = document.getElementById('checkout-data');
  if (!checkoutData) return;

  const bookId = checkoutData.getAttribute('data-book-id');
  const publishableKey = checkoutData.getAttribute('data-publishable-key');

  if (!bookId || !publishableKey) return;

  const form = document.getElementById('payment-form');
  const loadingIndicator = document.getElementById('loading-indicator');
  const submitButton = document.getElementById('submit-button');
  const spinner = document.getElementById('spinner');
  const paymentMessage = document.getElementById('payment-message');

  let stripe = null;
  let elements = null;
  let isSubmitting = false;

  const ATTEMPT_KEY = 'checkout_attempt_' + bookId;
  const EXPIRATION_WINDOW_MS = 24 * 60 * 60 * 1000;

  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getStoredAttempt() {
    try {
      const item = sessionStorage.getItem(ATTEMPT_KEY);
      if (!item) return null;
      const data = JSON.parse(item);
      if (!data || !data.attemptId || !data.clientSecret || !data.createdAt) return null;
      if (Date.now() - data.createdAt > EXPIRATION_WINDOW_MS) {
        sessionStorage.removeItem(ATTEMPT_KEY);
        return null;
      }
      return data;
    } catch (err) {
      sessionStorage.removeItem(ATTEMPT_KEY);
      return null;
    }
  }

  function saveAttempt(attemptId, clientSecret) {
    try {
      sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({
        attemptId: attemptId,
        clientSecret: clientSecret,
        createdAt: Date.now()
      }));
    } catch (err) {
      // Storage errors should not block payment
    }
  }

  function showFormError(message) {
    if (loadingIndicator) loadingIndicator.classList.add('d-none');
    if (paymentMessage) {
      paymentMessage.textContent = message;
      paymentMessage.classList.remove('d-none');
    }
    if (form) form.classList.remove('d-none');
    if (submitButton) submitButton.disabled = false;
    if (spinner) spinner.classList.add('d-none');
    isSubmitting = false;
  }

  async function resolvePaymentIntent() {
    const existing = getStoredAttempt();
    if (existing) {
      // Check intent status before reusing to prevent duplicate charges on succeeded or in-flight intents
      try {
        const checkRes = await fetch('/payment-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientSecret: existing.clientSecret })
        });
        if (checkRes.ok) {
          const statusData = await checkRes.json();
          if (statusData.status === 'succeeded' || statusData.status === 'processing') {
            window.location.href = '/success?payment_intent_client_secret=' + encodeURIComponent(existing.clientSecret);
            return null;
          }
          return existing.clientSecret;
        }
      } catch (err) {
        // Fall through to creating a fresh intent if validation fails
      }
      sessionStorage.removeItem(ATTEMPT_KEY);
    }

    const attemptId = generateUUID();
    const res = await fetch('/create-payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: bookId, attemptId: attemptId })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Unable to initialize checkout');
    }

    const { clientSecret } = await res.json();
    saveAttempt(attemptId, clientSecret);
    return clientSecret;
  }

  async function init() {
    try {
      const clientSecret = await resolvePaymentIntent();
      if (!clientSecret) return;

      stripe = Stripe(publishableKey);
      elements = stripe.elements({ clientSecret: clientSecret });

      const paymentElement = elements.create('payment');
      paymentElement.mount('#payment-element');

      paymentElement.on('ready', function() {
        if (loadingIndicator) loadingIndicator.classList.add('d-none');
        if (form) form.classList.remove('d-none');
        if (submitButton) submitButton.disabled = false;
      });

      paymentElement.on('change', function(event) {
        if (paymentMessage && !paymentMessage.classList.contains('d-none')) {
          paymentMessage.classList.add('d-none');
          paymentMessage.textContent = '';
        }
      });
    } catch (err) {
      showFormError(err.message || 'Unable to load payment form. Please try again.');
    }
  }

  if (form) {
    form.addEventListener('submit', async function(event) {
      event.preventDefault();
      if (isSubmitting || !stripe || !elements) return;

      isSubmitting = true;
      submitButton.disabled = true;
      spinner.classList.remove('d-none');
      if (paymentMessage) {
        paymentMessage.classList.add('d-none');
        paymentMessage.textContent = '';
      }

      try {
        const returnUrl = window.location.origin + '/success';
        const { error } = await stripe.confirmPayment({
          elements: elements,
          confirmParams: {
            return_url: returnUrl
          }
        });

        // Unrecoverable or customer validation errors return here instead of redirecting
        if (error) {
          showFormError(error.message || 'An error occurred during payment.');
        }
      } catch (networkErr) {
        showFormError('Network connection error. Please check your connection and try again.');
      }
    });
  }

  init();
})();
