(function() {
  const checkoutData = document.getElementById('checkout-data');
  if (!checkoutData) return;

  const bookId = checkoutData.getAttribute('data-book-id');
  const publishableKey = checkoutData.getAttribute('data-publishable-key');

  if (!bookId || !publishableKey) return;

  const form = document.getElementById('payment-form');
  const loadingIndicator = document.getElementById('loading-indicator');
  const initError = document.getElementById('init-error');
  const initErrorMessage = document.getElementById('init-error-message');
  const retryInitButton = document.getElementById('retry-init-button');
  const submitButton = document.getElementById('submit-button');
  const spinner = document.getElementById('spinner');
  const paymentMessage = document.getElementById('payment-message');

  let stripe = null;
  let elements = null;
  let isSubmitting = false;
  let isInitializing = false;
  let isReady = false;
  let paymentElement = null;

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
      if (!data || typeof data.attemptId !== 'string' ||
          !Number.isFinite(data.createdAt) || data.createdAt <= 0) {
        throw new Error('Invalid stored attempt');
      }
      return data;
    } catch (err) {
      throw new Error('Unable to read your previous checkout. Please restore browser storage or contact support before trying another payment.');
    }
  }

  function saveAttempt(data) {
    try {
      sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(data));
    } catch (err) {
      throw new Error('Unable to save your checkout. Please enable browser storage and try again.');
    }
  }

  function showInitError(message) {
    isReady = false;
    if (loadingIndicator) loadingIndicator.classList.add('d-none');
    if (form) form.classList.add('d-none');
    if (submitButton) submitButton.disabled = true;
    if (initError && initErrorMessage) {
      initErrorMessage.textContent = message;
      initError.classList.remove('d-none');
    }
  }

  function hideInitError() {
    if (initError) initError.classList.add('d-none');
  }

  function showSubmissionError(message) {
    if (paymentMessage) {
      paymentMessage.textContent = message;
      paymentMessage.classList.remove('d-none');
    }
    if (submitButton) submitButton.disabled = false;
    if (spinner) spinner.classList.add('d-none');
    isSubmitting = false;
  }

  async function resolvePaymentIntent() {
    const attempt = getStoredAttempt() || { attemptId: generateUUID(), createdAt: Date.now() };

    if (attempt.clientSecret) {
      const checkRes = await fetch('/payment-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientSecret: attempt.clientSecret })
      });
      if (!checkRes.ok) {
        throw new Error('Unable to verify your previous payment. Please try checking again before making another payment.');
      }
      const data = await checkRes.json();
      if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(data.status)) {
        window.location.href = '/success?payment_intent_client_secret=' + encodeURIComponent(attempt.clientSecret);
        return null;
      }
      return attempt.clientSecret;
    }

    // Stripe can forget idempotency keys after 24 hours, so do not retry an unresolved old request
    if (Date.now() - attempt.createdAt >= EXPIRATION_WINDOW_MS) {
      throw new Error('This checkout is too old to retry safely. Please contact support to check the previous payment before starting another checkout.');
    }

    // Save before requesting an intent so a lost response can be retried with the same key
    saveAttempt(attempt);

    const res = await fetch('/create-payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: bookId, attemptId: attempt.attemptId })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Unable to initialize checkout');
    }

    const { clientSecret } = await res.json();
    saveAttempt({ ...attempt, clientSecret: clientSecret });
    return clientSecret;
  }

  async function init() {
    if (isInitializing) return;
    isInitializing = true;
    isReady = false;
    if (retryInitButton) retryInitButton.disabled = true;
    hideInitError();
    if (loadingIndicator) loadingIndicator.classList.remove('d-none');
    if (form) form.classList.add('d-none');
    if (submitButton) submitButton.disabled = true;

    try {
      if (paymentElement) paymentElement.destroy();
      paymentElement = null;
      elements = null;
      if (typeof Stripe !== 'function') {
        throw new Error('Unable to load Stripe. Please check your connection and reload this page.');
      }
      const clientSecret = await resolvePaymentIntent();
      if (!clientSecret) return;

      stripe = Stripe(publishableKey);
      elements = stripe.elements({ clientSecret: clientSecret });

      const mountedElement = elements.create('payment');
      paymentElement = mountedElement;

      mountedElement.on('ready', function() {
        if (paymentElement !== mountedElement) return;
        isReady = true;
        hideInitError();
        if (loadingIndicator) loadingIndicator.classList.add('d-none');
        if (form) form.classList.remove('d-none');
        if (submitButton) submitButton.disabled = false;
      });

      mountedElement.on('loaderror', function() {
        if (paymentElement !== mountedElement) return;
        showInitError('Unable to load payment details. Please check your connection and try again.');
      });

      mountedElement.on('change', function() {
        if (paymentMessage && !paymentMessage.classList.contains('d-none')) {
          paymentMessage.classList.add('d-none');
          paymentMessage.textContent = '';
        }
      });
      mountedElement.mount('#payment-element');
    } catch (err) {
      showInitError(err.message || 'Unable to load payment form. Please try again.');
    } finally {
      isInitializing = false;
      if (retryInitButton) retryInitButton.disabled = false;
    }
  }

  if (retryInitButton) retryInitButton.addEventListener('click', init);

  if (form) {
    form.addEventListener('submit', async function(event) {
      event.preventDefault();
      if (isSubmitting || !isReady || !stripe || !elements) return;

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

        // Customer-facing validation or card decline errors return here
        if (error) {
          showSubmissionError(error.message || 'An error occurred during payment.');
        }
      } catch (networkErr) {
        showSubmissionError('Network connection error. Please check your connection and try again.');
      }
    });
  }

  init();
})();
