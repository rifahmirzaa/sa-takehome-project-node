# Stripe Press

A bookshop with embedded Stripe payments: **choose a book → pay → receive a verified confirmation** with the charged amount, currency, and PaymentIntent ID (`pi_…`).

[Run locally](#start-here-extract-to-first-payment) · [Payment flow](#how-it-works) · [Design and diagrams](docs/design.md) · [Approach](#approach-and-decisions) · [Testing](#test-the-payment-flow) · [Next steps](#next-steps)

## What's included

- Three books, one per purchase, priced in USD
- Stripe **Payment Element** with PaymentIntents; no Stripe Checkout
- Card declines, bank authentication, and retry recovery
- Server-verified receipts and signed webhook handling
- A startup script that runs the app and local webhook listener together

## Start here: extract to first payment

**Prerequisites:** a supported [Node.js release with npm](https://nodejs.org/en/download), [Stripe CLI](https://docs.stripe.com/stripe-cli#install), and a Stripe sandbox. Use Bash on macOS, Linux, or WSL. The app requires Node.js 18+; it was tested with 26.3.0.

1. **Extract and configure.** Unzip the project, then open a terminal in the extracted folder containing `package.json`, `sample.env`, and `app.js`. Run all commands below from that folder.

   ```bash
   cp sample.env .env
   ```

   If `.env` already exists, keep it and edit its values instead.

2. **Add matching sandbox keys** to `.env`:

   ```dotenv
   STRIPE_SECRET_KEY=sk_test_replace_with_your_key
   STRIPE_PUBLISHABLE_KEY=pk_test_replace_with_your_key
   STRIPE_WEBHOOK_SECRET=
   ```

   Use keys from the **same sandbox**. Keep `.env` private and exclude it from any ZIP you share. Leave the webhook secret blank—the launcher supplies it. [Restricted-key configuration](docs/setup.md#configuration) is also supported.

3. **Check and start:**

   ```bash
   bash scripts/dev.sh --check
   bash scripts/dev.sh
   ```

   The script installs missing npm dependencies, checks Stripe access, and starts the listener and server. It does not install Node.js or Stripe CLI. No separate build, `stripe login`, or `npm start` is needed.

4. **Open [localhost:3000](http://localhost:3000)** and select a book. Use card `4242 4242 4242 4242`, a future expiry, CVC `123`, and valid test billing details. The receipt should show the amount, currency, and `pi_` ID.

Keep the terminal open while using the app. **Ctrl+C** stops both processes; run `bash scripts/dev.sh` to restart. See [setup and troubleshooting](docs/setup.md) for installation help, another port, or manual startup.

## How it works

1. **Select:** Express renders the catalog and the selected book's price using Handlebars.
2. **Create:** The browser sends a book ID and saved attempt ID. The server looks up the price and creates a PaymentIntent, Stripe's record of the payment lifecycle.
3. **Pay:** Stripe.js mounts the Payment Element using the intent's client secret. Payment details go directly to Stripe. `confirmPayment` submits the payment and handles bank authentication.
4. **Confirm:** The server retrieves the intent and checks its client secret and application metadata. Only `succeeded` produces a receipt, using Stripe's `amount_received`, currency, and ID.

Separately, Stripe CLI forwards events to `/webhook`. The server verifies signatures and logs payment status. **Webhooks currently observe payments; they do not fulfill orders.**

### Stripe APIs

| Interface | Purpose |
| --- | --- |
| `paymentIntents.create` — `POST /v1/payment_intents` | Create the payment with server-owned pricing and an idempotency key |
| `stripe.elements` → `elements.create('payment')` | Display the Payment Element in the browser |
| `stripe.confirmPayment` | Submit payment details and handle authentication |
| `paymentIntents.retrieve` — `GET /v1/payment_intents/:id` | Verify receipts and resume an existing payment |
| `webhooks.constructEvent` | Verify webhook signatures locally in the SDK |

The server uses Stripe API version `2026-08-26.dahlia`. The launcher also calls `GET /v1/account` to check sandbox access.

Metadata (`integration`, `bookId`, `attemptId`) connects each PaymentIntent to its checkout. Stripe copies this metadata to the Charge when it is created. [Metadata reference](https://docs.stripe.com/metadata)

## Architecture

One Express process serves Handlebars pages and payment endpoints. Browser JavaScript manages the payment form and receipt updates. Stripe holds payment records; session storage keeps the current tab's checkout attempt. There is no database or front-end build pipeline.

| Location | Responsibility |
| --- | --- |
| [app.js](app.js) | Routes, validation, rendering, and webhook handling |
| [lib/catalog.js](lib/catalog.js) | Books and prices in cents |
| [lib/payments.js](lib/payments.js) | Stripe client and payment operations |
| [views/](views/) | Catalog, checkout, receipt, and shared layout |
| [public/js/checkout.js](public/js/checkout.js) | Form initialization, confirmation, and retry recovery |
| [public/js/success.js](public/js/success.js) | Verified receipt states |
| [scripts/dev.sh](scripts/dev.sh) | Local startup and cleanup |
| [test/](test/) | Route, browser-script, portability, and launcher tests |

See [architecture and sequence diagrams](docs/design.md) for request flow, endpoints, and recovery states.

## Approach and decisions

I built the basic purchase flow first, then tested declines, authentication, refreshes, and interrupted requests. Most of the extra code came from making those cases recoverable.

### Front end

I kept Handlebars and Bootstrap from the starter because three pages did not need a separate front-end framework or build step.

- **Page rendering:** Express fills the templates with the catalog and selected book. Browser JavaScript handles payment interactions.
- **Checkout:** [checkout.js](public/js/checkout.js) loads the Payment Element, submits payment, and manages retries.
- **Confirmation:** [success.js](public/js/success.js) requests verified status and displays the result.
- **Saved state:** session storage keeps the attempt through a refresh in the same tab. It does not provide recovery across devices or after storage is cleared.

### Back end

I kept the routes in one file and separated the catalog and Stripe calls into small modules. This is enough structure for the current application without making it harder to follow.

- **Routes:** [app.js](app.js) validates requests, renders pages, and handles webhooks.
- **Pricing:** [catalog.js](lib/catalog.js) supplies both the displayed price and payment amount. The browser sends a book ID; the server looks up its price.
- **Payments:** [payments.js](lib/payments.js) creates and retrieves PaymentIntents and verifies webhook signatures. New Stripe operations can be added here.
- **Payment flow:** I used PaymentIntents with the Payment Element for embedded checkout and explicit payment-status handling. The receipt retrieves the intent again before confirming success.
- **Storage:** I kept the three fixed products in code. Persistent orders would need a database; the current webhook handler only verifies and logs events.

### Challenges encountered

**Lost responses and payment retries**

- The first version saved the attempt after receiving the creation response. If that response was lost, a refresh could create another PaymentIntent.
- I moved the save before the request and reused the attempt's idempotency key on retry. Failed status checks now preserve the attempt too.
- I checked this by dropping a sandbox creation response, reloading, and confirming that the same PaymentIntent was recovered.

**Old receipts and canceled purchases**

- An old receipt could delete a newer checkout for the same book. Separately, a canceled attempt stayed in storage and kept sending the customer back to the canceled receipt.
- I changed cleanup to require both a verified successful or canceled status and a matching attempt ID. Tests cover reopening an old receipt and buying again after cancellation.

**Pay became clickable before the form was ready**

- Loading errors and submission errors shared a handler that enabled Pay, even when initialization had failed.
- I separated the handlers. Pay now waits for the Element's ready event; loading failures offer initialization retry, while declined cards can be corrected on the existing payment.

**Missing payments looked like temporary outages**

- Every Stripe retrieval error initially returned 502, encouraging retries even when the payment did not exist.
- I changed missing or mismatched records to 404 and kept 502 for temporary failures. Route tests check both cases.

**Local setup blocked the first browser run**

- The publishable key was missing. Adding the matching sandbox key allowed payment testing to proceed.
- I later added the launcher to check configuration, use the app's key for CLI authentication, and pass the active listener's signing secret to the server. The [manual steps](docs/setup.md#manual-startup) remain available.

These fixes are covered by the [browser-script tests](test/browser-payments.test.js) and [route tests](test/payments.test.js), with setup checks in the [launcher tests](test/dev.test.js).

One limit remains: an attempt older than 24 hours without a saved client secret needs reconciliation, because Stripe can prune its idempotency key. Known intents can still be retrieved. See the [recovery diagram](docs/design.md#retry-and-recovery).

## Test the payment flow

After dependencies are installed, run `npm test`. Tests use controlled Stripe and browser substitutes; they need no API keys and make no Stripe requests.

| Sandbox scenario | Card | Expected result |
| --- | --- | --- |
| Success | `4242 4242 4242 4242` | Verified amount, currency, and `pi_` ID |
| Decline, then retry | `4000 0000 0000 9995` | Error; retry with the success card on the same intent |
| Bank authentication | `4000 0025 0000 3155` | Complete the challenge, then see the receipt |

Use a future expiry and CVC `123`. After paying:

- Compare the receipt with the sandbox Dashboard.
- Check the payment event in the terminal.
- Refresh the receipt and confirm the same payment remains visible.

Development checks also covered lost responses, status outages, and cancellation followed by another purchase. Automated tests cover recovery logic; a sandbox browser run checks the actual Stripe integration.

## Next steps

I would start with persistent orders so recovery no longer depends on one browser tab. Then I would add:

1. **Reliable orders:** persist the book, price, PaymentIntent ID, and state; use verified webhooks to trigger fulfillment with duplicate-event protection.
2. **Merchant support:** add an authorized charges page with pagination and refunds, then customer order history as needed.
3. **Customer experience:** customize the Payment Element's appearance and show the purchased book from verified metadata on the receipt. The current Element uses its default appearance; the receipt shows amount, currency, and payment ID.
4. **Public operation:** add inventory, shipping and tax as needed, plus HTTPS, managed secrets, rate limits, and monitoring.

## References used

- [Payment Element](https://docs.stripe.com/payments/payment-element), [PaymentIntents](https://docs.stripe.com/payments/payment-intents), [confirmation](https://docs.stripe.com/js/payment_intents/confirm_payment), and [retrieval](https://docs.stripe.com/api/payment_intents/retrieve): payment UI and lifecycle
- [Idempotency](https://docs.stripe.com/api/idempotent_requests) and [metadata](https://docs.stripe.com/metadata): retries and tracing payments to a checkout
- [Webhooks](https://docs.stripe.com/webhooks) and [Stripe CLI](https://docs.stripe.com/stripe-cli): signature verification and local event delivery
- [Testing](https://docs.stripe.com/testing): successful, declined, and authenticated sandbox payments

Built on the supplied [Node.js starter](https://github.com/mattmitchell6/sa-takehome-project-node), retaining its Express, Handlebars, and page styling.
