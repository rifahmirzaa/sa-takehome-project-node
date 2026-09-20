const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const key = 'checkout_attempt_1';
const attempt = {
  attemptId: '550e8400-e29b-41d4-a716-446655440000',
  clientSecret: 'pi_old_secret_valid',
  createdAt: Date.now()
};
const ok = data => ({ ok: true, status: 200, json: async () => data });
const saved = data => new Map([[key, JSON.stringify(data)]]);
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

function element() {
  const classes = new Set(['d-none']);
  return {
    disabled: true, textContent: '', innerHTML: '', children: [], listeners: {},
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name)
    },
    getAttribute: name => name === 'data-book-id' ? '1' : 'pk_test_fake',
    addEventListener(type, handler) { this.listeners[type] = handler; },
    appendChild(child) { this.children.push(child); }
  };
}

// Run the shipped scripts with a small DOM and controllable Stripe and network boundaries
async function load(file, { storage = new Map(), fetcher, storageError = false, search = '' } = {}) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const requests = [];
  const paymentElements = [];
  let confirmations = 0;
  const context = {
    document: { getElementById: get, createElement: element },
    window: { location: { origin: 'http://localhost:3000', href: '', search } },
    sessionStorage: {
      getItem: name => storage.get(name) || null,
      setItem(name, value) {
        if (storageError) throw new Error('Storage disabled');
        storage.set(name, value);
      },
      removeItem: name => storage.delete(name)
    },
    crypto: { randomUUID }, Date, Math, URLSearchParams, Intl, encodeURIComponent,
    Stripe: () => ({
      elements: () => ({
        create() {
          const handlers = {};
          const paymentElement = {
            handlers, destroyed: false,
            mount() {},
            on(type, handler) { handlers[type] = handler; },
            destroy() { this.destroyed = true; }
          };
          paymentElements.push(paymentElement);
          return paymentElement;
        }
      }),
      confirmPayment: async () => { confirmations++; return { error: { message: 'Card declined' } }; }
    }),
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      return fetcher(url, body);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
  await settle();
  return { get, requests, storage, paymentElements, context, confirmations: () => confirmations };
}

test('lost creation response survives reload with the same attempt and timestamp', async () => {
  const storage = new Map();
  const first = await load('checkout.js', {
    storage,
    fetcher: async () => { assert.ok(storage.has(key)); throw new Error('Response lost'); }
  });
  const original = JSON.parse(storage.get(key));
  assert.equal(first.get('submit-button').disabled, true);
  assert.equal(first.get('init-error').classList.contains('d-none'), false);
  const second = await load('checkout.js', {
    storage, fetcher: async () => ok({ clientSecret: attempt.clientSecret })
  });
  assert.equal(second.requests[0].body.attemptId, original.attemptId);
  assert.equal(JSON.parse(storage.get(key)).createdAt, original.createdAt);
  assert.equal(second.get('submit-button').disabled, true);
  second.paymentElements[0].handlers.ready();
  assert.equal(second.get('submit-button').disabled, false);
});

for (const failure of [404, 502, 'network']) {
  test(`status failure ${failure} preserves the attempt without creating another intent`, async () => {
    const storage = saved(attempt);
    const page = await load('checkout.js', { storage, fetcher: async () => {
      if (failure === 'network') throw new Error('Offline');
      return { ok: false, status: failure };
    } });
    assert.deepEqual(page.requests.map(r => r.url), ['/payment-status']);
    assert.equal(storage.get(key), JSON.stringify(attempt));
    assert.equal(page.get('submit-button').disabled, true);
    assert.equal(page.get('init-error').classList.contains('d-none'), false);
  });
}

test('expired unknown attempt remains blocked even after retry', async () => {
  const expired = { attemptId: attempt.attemptId, createdAt: Date.now() - 25 * 3600000 };
  const page = await load('checkout.js', { storage: saved(expired) });
  await page.get('retry-init-button').listeners.click();
  assert.equal(page.requests.length, 0);
  assert.equal(page.storage.get(key), JSON.stringify(expired));
  assert.match(page.get('init-error-message').textContent, /too old to retry safely/);
});

for (const status of ['succeeded', 'processing', 'canceled', 'requires_payment_method']) {
  test(`expired known intent is checked and handled as ${status}`, async () => {
    const page = await load('checkout.js', {
      storage: saved({ ...attempt, createdAt: Date.now() - 25 * 3600000 }),
      fetcher: async () => ok({ status })
    });
    assert.deepEqual(page.requests.map(r => r.url), ['/payment-status']);
    if (status === 'requires_payment_method') assert.equal(page.paymentElements.length, 1);
    else assert.match(page.context.window.location.href, /^\/success\?/);
  });
}

test('storage write failure or corrupt record prevents a payment request', async () => {
  for (const options of [{ storageError: true }, { storage: new Map([[key, '{broken']]) }]) {
    const page = await load('checkout.js', options);
    assert.equal(page.requests.length, 0);
    assert.equal(page.get('submit-button').disabled, true);
    assert.equal(page.get('init-error').classList.contains('d-none'), false);
  }
});

test('retry initializes once and Pay remains disabled until the element is ready', async () => {
  let recover = false;
  const page = await load('checkout.js', { fetcher: async () => {
    if (!recover) throw new Error('Offline');
    return ok({ clientSecret: attempt.clientSecret });
  } });
  await page.get('payment-form').listeners.submit({ preventDefault() {} });
  assert.equal(page.confirmations(), 0);
  recover = true;
  const retry = page.get('retry-init-button').listeners.click;
  await Promise.all([retry(), retry()]);
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[0].body.attemptId, page.requests[1].body.attemptId);
  await page.get('payment-form').listeners.submit({ preventDefault() {} });
  assert.equal(page.confirmations(), 0);
  page.paymentElements[0].handlers.ready();
  await page.get('payment-form').listeners.submit({ preventDefault() {} });
  assert.equal(page.confirmations(), 1);
  assert.equal(page.get('submit-button').disabled, false);
  assert.equal(page.get('payment-message').textContent, 'Card declined');
});

test('element loading failure can retry the same intent and destroys the old element', async () => {
  const page = await load('checkout.js', { fetcher: async url =>
    ok(url === '/payment-status' ? { status: 'requires_payment_method' } : { clientSecret: attempt.clientSecret })
  });
  const first = page.paymentElements[0];
  first.handlers.loaderror();
  assert.equal(page.get('submit-button').disabled, true);
  assert.equal(page.get('init-error').classList.contains('d-none'), false);
  await page.get('retry-init-button').listeners.click();
  assert.equal(first.destroyed, true);
  first.handlers.ready();
  assert.equal(page.get('submit-button').disabled, true);
  page.paymentElements[1].handlers.ready();
  assert.equal(page.get('submit-button').disabled, false);
  assert.deepEqual(page.requests.map(r => r.url), ['/create-payment-intent', '/payment-status']);
});

for (const receiptAttemptId of [attempt.attemptId, 'older-attempt', null]) {
  test(`receipt clears only its own stored attempt (${receiptAttemptId})`, async () => {
    const page = await load('success.js', {
      storage: saved(attempt), search: '?payment_intent_client_secret=' + attempt.clientSecret,
      fetcher: async () => ok({ id: 'pi_old', status: 'succeeded', amountReceived: 2300,
        currency: 'usd', bookId: '1', attemptId: receiptAttemptId })
    });
    assert.equal(page.storage.has(key), receiptAttemptId !== attempt.attemptId);
    assert.equal(page.get('status-title').textContent, 'Payment successful');
    assert.equal(page.get('status-amount').textContent, '$23.00');
    assert.equal(page.get('status-payment-id').textContent, 'pi_old');
  });
}

test('redirect status alone cannot display a successful receipt', async () => {
  const page = await load('success.js', { search: '?redirect_status=succeeded' });
  assert.equal(page.requests.length, 0);
  assert.equal(page.get('status-title').textContent, 'No payment reference found');
});
