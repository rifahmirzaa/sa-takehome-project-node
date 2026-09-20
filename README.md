# Stripe Press

A small bookshop built with Node.js, Express, Handlebars, and Stripe's Payment Element. Choose one of three books, pay without leaving the shop for a hosted checkout page, and see a verified receipt with the charged amount, currency, and Stripe PaymentIntent ID.

The app uses direct PaymentIntents and the Payment Element. It does not use Stripe Checkout. There is no cart, account system, database, or fulfillment service.

## Quick start with webhooks

On macOS, Linux, or WSL, install Node.js with npm and the [Stripe CLI](https://docs.stripe.com/stripe-cli#install) first. Clone this repository, then run:

```bash
npm run dev
```

On the first run, the launcher creates a private `.env` file and asks you to add `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` from the same sandbox. Save those values and run `npm run dev` again. If `.env` is already configured, the launcher continues immediately.

The launcher installs missing project dependencies, rejects live keys, checks CLI access, and validates the sandbox key with a read-only API request. It starts webhook forwarding, takes the signing secret from that listener, and starts the app with the secret in its environment. Existing `.env` contents are preserved. Keys are never printed, and temporary CLI logs are removed when the launcher exits.

The CLI uses the app's sandbox key through `STRIPE_API_KEY`, so a separate `stripe login` is not required and a saved CLI session cannot point forwarding at a different sandbox. A restricted key needs permissions for account retrieval, webhook listening, and the application's payment operations. The publishable key must still be copied from that same sandbox; checking its format cannot prove that the pair matches.

Open the URL printed by the launcher. Payment event summaries appear in the same terminal. Press **Ctrl+C** to stop both processes. If the app or listener exits unexpectedly, the launcher stops the other process too. Existing processes are never stopped by the launcher.

To check configuration and authentication without starting the app:

```bash
npm run dev -- --check
```

If port 3000 is occupied, stop the earlier app or choose another port:

```bash
PORT=3001 npm run dev
```

`--check` may install missing dependencies and create a blank `.env`; it does not start a listener or server. The manual setup below also works without Bash.

## Manual setup

You need Node.js 18 or newer, npm, and a Stripe sandbox account. Use a currently supported Node.js release; the submission was tested with Node.js 26.3.0. Internet access is required for Stripe.js and the page's CDN assets. The Stripe CLI is needed only for forwarding webhook events.

1. Clone the repository and enter its root directory:

   ```bash
   git clone https://github.com/rifahmirzaa/sa-takehome-project-node.git
   cd sa-takehome-project-node
   ```
2. Install dependencies and create a local configuration file:

   ```bash
   npm ci
   cp sample.env .env
   ```

3. Add the publishable and secret API keys from the **same Stripe sandbox** to `.env`:

   ```dotenv
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PUBLISHABLE_KEY=pk_test_...
   STRIPE_WEBHOOK_SECRET=
   ```

   Replace the examples with your own keys. The secret key stays on the server; the publishable key is passed to Stripe.js. `.env` is ignored by Git and is not included in the submission.
4. Start the app:

   ```bash
   npm start
   ```

5. Open [localhost:3000](http://localhost:3000). Select a book to reach checkout.

There is no compilation or separate build step. Restart the server after editing `.env`. Configuration, templates, and static assets resolve relative to `app.js`, so the repository can be moved without editing file paths. Browser requests use the current site, and the payment return URL is built from `window.location.origin`.

### Webhook forwarding

In a second terminal, authenticate the [Stripe CLI](https://docs.stripe.com/stripe-cli) against the same account and sandbox used by the app:

```bash
stripe login
stripe listen --events payment_intent.succeeded,payment_intent.processing,payment_intent.payment_failed --forward-to localhost:3000/webhook
```

Copy the listener's `whsec_...` signing secret into `STRIPE_WEBHOOK_SECRET` in `.env`, then restart the app. Keep the listener running. A sandbox payment should produce a forwarded event with an HTTP 200 response and a short event log in the app terminal.

Checkout and receipt verification work without the listener. The webhook endpoint demonstrates signature verification and event observation; it does not ship a book or send email. A Dashboard endpoint's signing secret is different from the local listener's secret.

## How it works

The server owns the catalog and prices: $23.00, $25.00, and $28.00 USD, with quantity fixed at one. The browser submits a book ID and checkout attempt ID, never a trusted amount.

1. Express renders the selected book and order summary.
2. The browser saves an attempt ID before asking the server to create a PaymentIntent. The server uses the catalog price and an idempotency key derived from the book and attempt.
3. Stripe.js mounts the Payment Element using the returned client secret. Payment details go directly to Stripe.
4. `stripe.confirmPayment` submits the payment and handles any required authentication or redirect.
5. The return page sends the client secret to the server. The server retrieves the intent, checks the secret and application metadata, and returns its verified status. Only `succeeded` produces a purchase confirmation with `amount_received`, currency, and the `pi_` ID.

[Design and sequence diagrams](docs/design.md) describe the component boundaries, payment flow, recovery flow, and webhook handling.

### Stripe APIs used

| Operation | Purpose |
| --- | --- |
| `stripe.paymentIntents.create` — `POST /v1/payment_intents` | Create the payment with the server-owned amount, currency, metadata, automatic capture, and an idempotency key |
| `stripe.elements` and `elements.create('payment')` | Mount Stripe's Payment Element with available payment methods |
| `stripe.confirmPayment` | Submit payment details and handle further customer authentication |
| `stripe.paymentIntents.retrieve` — `GET /v1/payment_intents/:id` | Verify status and charged amount for receipts and resumed checkouts |
| `stripe.webhooks.constructEvent` | Verify the raw webhook body and signature locally using the Stripe SDK |

The server pins Stripe API version `2026-08-26.dahlia`; `package-lock.json` locks the installed SDK and other dependencies.

## Approach and challenges

The implementation keeps the starter application's Express and Handlebars structure. Book selection came first, with a shared catalog used for both the display and payment amount. The next step added PaymentIntent creation, the Payment Element, and a receipt based on a fresh server-side retrieval. Payment code lives in `lib/payments.js` so additional Stripe operations can be added without changing the catalog or templates.

The main challenge was handling uncertainty after a network failure. A failed request does not prove that Stripe failed to create the payment. Checkout therefore saves the attempt before sending the request, retries with the same idempotency key, and preserves the attempt when a status check fails. An unresolved attempt older than 24 hours stops for manual reconciliation because Stripe can prune old idempotency keys.

A second challenge was separating successful payment from a successful redirect. The receipt ignores `redirect_status` as evidence and displays pending, failed, and incomplete states separately. Refreshing an old receipt must also leave a newer purchase attempt intact. Verified success or cancellation clears only the matching stored attempt.

Initialization errors and declined payments need different recovery actions. Pay remains disabled until the Payment Element is ready; initialization failures offer a separate retry. A declined card can be corrected and retried on the same intent. Webhook verification also requires care: its raw-body route must run before Express's JSON parser.

## Verify the demo

### Automated checks

```bash
npm test
```

The automated tests cover server-owned pricing, input validation, payment-status checks, webhook routing, receipt handling, retry recovery, cancellation, running a relocated copy from another working directory, and the launcher’s configuration, authentication, startup, and cleanup behavior. They use Node's built-in test runner with controlled Stripe and browser boundaries. They do not contact Stripe or require API keys. There is no separate test dependency installation.

### Sandbox walkthrough

Use only sandbox keys and Stripe test cards. Enter any future expiry date, any three-digit CVC, and a valid postal code where requested.

| Scenario | Test card or action | Expected result |
| --- | --- | --- |
| Selection | Select each book | Correct title and USD price on checkout |
| Successful payment | `4242 4242 4242 4242` | Receipt shows the charged amount, currency, and `pi_` ID |
| Decline and retry | `4000 0000 0000 9995`, then the success card | Insufficient-funds error, then success using the same PaymentIntent |
| 3D Secure | `4000 0025 0000 3155` | Complete the sandbox challenge, then see a verified receipt |
| Receipt refresh | Refresh a successful receipt | Same amount and intent; no additional payment |
| Invalid selection | Visit `/checkout?item=999` | Error with a way back to the catalog |
| Cancellation | Cancel an unpaid intent in the sandbox Dashboard, then reload checkout | Canceled receipt; selecting that book again starts a new attempt |

Compare the receipt's ID, amount, currency, and status with the PaymentIntent in the same sandbox Dashboard. With the CLI listener running, check that the webhook receives HTTP 200.

Separate browser verification exercised successful payment, decline followed by retry, 3D Secure, receipt refresh, a dropped creation response, a temporary status outage, and cancellation followed by a new checkout for the same book. These checks are separate from `npm test`.

### Troubleshooting

- **Configuration unavailable:** fill in both API keys and restart the server. The blank sample configuration intentionally leaves checkout disabled.
- **Payment form fails to load:** check the network, browser blockers, and that both keys belong to the same sandbox. Retry initialization without clearing the saved attempt.
- **Status cannot be verified:** retry the status check. Do not assume the customer was not charged.
- **Old checkout needs reconciliation:** inspect Stripe request logs and intent metadata for the stored `bookId` and `attemptId` before resetting the attempt. This demo has no support console or automatic reconciliation service.
- **Webhook returns 400:** check the active CLI listener's signing secret, restart after changing `.env`, and confirm the listener is using the same sandbox.
- **Port 3000 is occupied:** stop the previous local app or run `PORT=3001 npm run dev`.
- **Launcher cannot authenticate:** check the sandbox key and network access. Restricted keys also need the permissions used by the CLI and the app.
- **Stripe CLI is missing:** install it using the linked Stripe CLI guide. The launcher checks prerequisites but does not install system tools.

## What a production version would add

The first extension would be persistent orders, recording the book, agreed price, PaymentIntent ID, and payment state on the server. That would allow recovery across tabs and devices and provide a proper support workflow for unresolved attempts.

Fulfillment would run from verified webhook events, with duplicate-event handling and state checks so retries cannot ship or email twice. It would not depend on the customer returning to the receipt page. A queue could handle shipping and receipt delivery with retries.

Further work would depend on the shop's needs: inventory reservations, shipping addresses, tax calculation, refunds, and customer accounts. Deployment would also need HTTPS, managed secrets, rate limits, and operational monitoring. The current demo uses only USD, has no inventory enforcement, and observes webhooks without fulfilling orders.

## Documentation consulted

- [Payment Element](https://docs.stripe.com/payments/payment-element) — the embedded payment UI
- [PaymentIntents](https://docs.stripe.com/payments/payment-intents) — the payment lifecycle, client secrets, and reuse
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests) — retry behavior and key retention
- [Webhooks](https://docs.stripe.com/webhooks) — raw-body signature verification and event delivery
- [Testing](https://docs.stripe.com/testing) — sandbox cards, declines, and authentication

The project builds on the supplied [Node.js starter](https://github.com/mattmitchell6/sa-takehome-project-node).
