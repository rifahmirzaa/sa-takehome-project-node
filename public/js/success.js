(function() {
  const loadingEl = document.getElementById('status-loading');
  const resultEl = document.getElementById('status-result');
  const iconEl = document.getElementById('status-icon');
  const titleEl = document.getElementById('status-title');
  const detailsEl = document.getElementById('status-details');
  const amountEl = document.getElementById('status-amount');
  const currencyEl = document.getElementById('status-currency');
  const paymentIdEl = document.getElementById('status-payment-id');
  const messageEl = document.getElementById('status-message');
  const actionsEl = document.getElementById('status-actions');

  function renderState(options) {
    if (loadingEl) loadingEl.classList.add('d-none');
    if (!resultEl) return;
    resultEl.classList.remove('d-none');

    iconEl.innerHTML = options.iconHtml || '';
    titleEl.textContent = options.title || '';
    messageEl.textContent = options.message || '';

    if (options.details) {
      detailsEl.classList.remove('d-none');
      amountEl.textContent = options.details.amount;
      currencyEl.textContent = options.details.currency;
      paymentIdEl.textContent = options.details.id;
    } else {
      detailsEl.classList.add('d-none');
    }

    actionsEl.innerHTML = '';
    if (Array.isArray(options.actions)) {
      options.actions.forEach(function(action) {
        if (action.tag === 'a') {
          const a = document.createElement('a');
          a.href = action.href;
          a.className = action.className || 'btn btn-primary';
          a.textContent = action.text;
          actionsEl.appendChild(a);
        } else if (action.tag === 'button') {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = action.className || 'btn btn-primary';
          btn.textContent = action.text;
          btn.addEventListener('click', action.onClick);
          actionsEl.appendChild(btn);
        }
      });
    }
  }

  function formatCurrency(amountCents, currencyCode) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currencyCode || 'USD').toUpperCase()
    }).format(amountCents / 100);
  }

  async function checkPaymentStatus() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');

    // Reject missing or malformed session references before requesting status
    if (!sessionId || !/^cs_(?:test_|live_)?[a-zA-Z0-9]{1,200}$/.test(sessionId)) {
      renderState({
        iconHtml: '<i class="fas fa-exclamation-circle text-warning fa-3x"></i>',
        title: 'No payment reference found',
        message: 'We could not find a valid payment transaction to check. Please select a book to purchase.',
        actions: [
          { tag: 'a', href: '/', className: 'btn btn-primary', text: 'Browse catalog' }
        ]
      });
      return;
    }

    try {
      const res = await fetch('/checkout-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId })
      });

      if (res.status === 404) {
        renderState({
          iconHtml: '<i class="fas fa-question-circle text-secondary fa-3x"></i>',
          title: 'Payment record not found',
          message: 'This payment could not be verified with Stripe.',
          actions: [
            { tag: 'a', href: '/', className: 'btn btn-outline-secondary', text: 'Return to catalog' }
          ]
        });
        return;
      }

      if (!res.ok) {
        renderState({
          iconHtml: '<i class="fas fa-exclamation-triangle text-warning fa-3x"></i>',
          title: 'Payment status unavailable',
          message: 'Unable to reach Stripe to verify your transaction. Please try checking again.',
          actions: [
            { tag: 'button', onClick: checkPaymentStatus, className: 'btn btn-primary mr-2', text: 'Check again' },
            { tag: 'a', href: '/', className: 'btn btn-outline-secondary', text: 'Return to catalog' }
          ]
        });
        return;
      }

      const data = await res.json();
      const status = data.status;
      const paid = status === 'complete' && data.paymentStatus === 'paid' &&
        data.paymentIntentStatus === 'succeeded' && /^pi_[a-zA-Z0-9]+$/.test(data.id || '') &&
        Number.isInteger(data.amountReceived) && data.amountReceived > 0;
      const failed = status === 'complete' && data.paymentStatus === 'unpaid' &&
        ['requires_payment_method', 'canceled'].includes(data.paymentIntentStatus);

      if (paid || status === 'expired' || failed) {
        // Clear only the matching attempt after Stripe reports a final outcome
        if (data.bookId && data.attemptId) {
          try {
            const storedRaw = sessionStorage.getItem('checkout_attempt_' + data.bookId);
            if (storedRaw) {
              const stored = JSON.parse(storedRaw);
              if (stored && stored.sessionId === sessionId && stored.attemptId === data.attemptId) {
                sessionStorage.removeItem('checkout_attempt_' + data.bookId);
              }
            }
          } catch (e) {}
        }
      }

      if (paid) {
        renderState({
          iconHtml: '<i class="far fa-check-circle text-success fa-3x"></i>',
          title: 'Payment successful',
          message: 'Your payment was confirmed. Thank you for your purchase!',
          details: {
            amount: formatCurrency(data.amountReceived, data.currency),
            currency: (data.currency || 'USD').toUpperCase(),
            id: data.id
          },
          actions: [
            { tag: 'a', href: '/', className: 'btn btn-primary', text: 'Continue shopping' }
          ]
        });
      } else if (status === 'expired') {
        renderState({
          iconHtml: '<i class="fas fa-clock text-secondary fa-3x"></i>',
          title: 'Checkout expired',
          message: 'This checkout has expired. Select your book again to start a new checkout.',
          actions: [{ tag: 'a', href: '/', className: 'btn btn-primary', text: 'Browse books' }]
        });
      } else if (failed) {
        renderState({
          iconHtml: '<i class="fas fa-times-circle text-danger fa-3x"></i>',
          title: 'Payment failed',
          message: 'The payment did not complete. You can start a new checkout.',
          actions: [{ tag: 'a', href: '/', className: 'btn btn-primary', text: 'Browse books' }]
        });
      } else if (status === 'complete') {
        renderState({
          iconHtml: '<div class="spinner-border text-info my-2" role="status"><span class="sr-only">Processing…</span></div>',
          title: 'Payment processing',
          message: 'Your payment has not been confirmed yet. Check again for the latest status.',
          actions: [{ tag: 'button', onClick: checkPaymentStatus, className: 'btn btn-primary', text: 'Check again' }]
        });
      } else if (status === 'open') {
        renderState({
          iconHtml: '<i class="fas fa-exclamation-circle text-warning fa-3x"></i>',
          title: 'Payment incomplete',
          message: 'Return to checkout to finish your payment.',
          actions: [{ tag: 'a', href: data.bookId ? '/checkout?item=' + encodeURIComponent(data.bookId) : '/',
            className: 'btn btn-primary', text: 'Return to checkout' }]
        });
      } else {
        renderState({
          iconHtml: '<i class="fas fa-info-circle text-secondary fa-3x"></i>',
          title: 'Payment not completed',
          message: 'This payment is not completed.',
          actions: [
            { tag: 'a', href: '/', className: 'btn btn-outline-secondary', text: 'Return to catalog' }
          ]
        });
      }
    } catch (networkErr) {
      renderState({
        iconHtml: '<i class="fas fa-wifi text-warning fa-3x"></i>',
        title: 'Connection error',
        message: 'Unable to reach the server to verify your payment status.',
        actions: [
          { tag: 'button', onClick: checkPaymentStatus, className: 'btn btn-primary mr-2', text: 'Check again' },
          { tag: 'a', href: '/', className: 'btn btn-outline-secondary', text: 'Return to catalog' }
        ]
      });
    }
  }

  checkPaymentStatus();
})();
