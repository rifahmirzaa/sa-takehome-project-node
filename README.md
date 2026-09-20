# Take home project — Stripe Press

An e-commerce book purchase demo built with Express, Handlebars, Bootstrap, and the Stripe Payment Element.

## Features

- **Catalog & Order Summary**: Browse the catalog of three books on `/` and view server-owned pricing on `/checkout?item=:id`.
- **Payment Element Checkout**: Purchase the selected book using Stripe's Payment Element with dynamic payment methods. Card data never touches the application server.
- **Verified Purchase Confirmation**: `/success` checks payment status against Stripe using the returned `payment_intent_client_secret`, displaying the exact `amount_received`, currency, and `pi_` ID.
- **Webhook Event Handling**: `POST /webhook` verifies `Stripe-Signature` using `express.raw()` and Stripe SDK, observing asynchronous payment lifecycle events.

## Architecture & Integration Decisions

### Direct PaymentIntents vs. Stripe Checkout
Direct PaymentIntents are used to keep the buyer on the customized checkout page with the order summary and book artwork, adhering to the integration requirement excluding Stripe Checkout.

### Client-Secret-Protected Status Retrieval
To prevent unauthenticated callers from inspecting arbitrary `pi_` payment intents, `POST /payment-status` requires the `payment_intent_client_secret`. The server checks that the secret matches the retrieved Stripe intent and verifies application metadata (`integration: 'sa-takehome-demo'`). The return URL parameter `redirect_status` is not trusted as proof of payment; only `amount_received` reported directly by Stripe is displayed.

### Single-Tab Attempt Tracking & Idempotency
Each purchase attempt generates a bounded UUID stored in `sessionStorage` alongside creation timestamp. Stripe API calls include an idempotency key derived from the book and attempt ID (`demo-book-<id>-attempt-<uuid>`).
- *Demo limitation*: Attempt storage is bounded to a 24-hour window in `sessionStorage`. This demo does not feature a persistent database, shopping cart, or cross-browser cart synchronization.

### Webhook Event Observation
The webhook endpoint at `/webhook` validates cryptographic signatures using the Stripe signing secret (`whsec_...`). Handled events include `payment_intent.succeeded`, `payment_intent.processing`, and `payment_intent.payment_failed`.
- *Demo limitation*: In the absence of a database or email service, the webhook logs event receipt for monitoring and auditability. Order fulfillment and receipt emails are outside the scope of this assignment.

## Setup & Running Locally

### 1. Prerequisites
- Node.js (v18+)
- Stripe CLI (for webhook forwarding and sandbox testing)

### 2. Installation
```bash
git clone https://github.com/rifahmirzaa/sa-takehome-project-node.git
cd sa-takehome-project-node
npm ci
```

### 3. Environment Configuration
Copy `sample.env` to `.env`:
```bash
cp sample.env .env
```

Configure your sandbox API keys in `.env`:
```dotenv
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

*Note: Book browsing on `/` remains functional without Stripe keys; checkout gracefully notifies users if payment configuration is missing.*

### 4. Running the Webhook Listener
In a separate terminal, forward webhook events to the local endpoint:
```bash
stripe listen --events payment_intent.succeeded,payment_intent.processing,payment_intent.payment_failed --forward-to localhost:3000/webhook
```
Copy the printed signing secret (`whsec_...`) to `STRIPE_WEBHOOK_SECRET` in your `.env`.

### 5. Start the Server
```bash
npm start
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

## Testing & Verification

Run the automated test suite (using Node's built-in test runner):
```bash
npm test
```

### Verification Matrix

| Check | Scenario | Result |
| --- | --- | --- |
| Route Security | `GET /checkout`, `GET /success` return `no-store`, `no-referrer`, CSP | Passed |
| Catalog Integrity | Server enforces catalog prices ($23, $25, $28); ignores client overrides | Passed |
| Input Validation | Malformed or missing `itemId` / non-UUID `attemptId` return HTTP 400 | Passed |
| Status Verification | Malformed secrets return 400; mismatched/unrelated intents return 404 | Passed |
| Secrets Protection | Client secret and billing data are never exposed in JSON or HTML | Passed |
| Webhook Verification | Missing/invalid signatures return 400; valid signatures return 200 | Passed |
| Live Sandbox Payments | Created and verified real PaymentIntents in Stripe test mode | Verified via SDK & Stripe MCP |
| Live CLI Webhooks | `stripe listen` + `stripe trigger` received and verified | Verified with real test events |
| Decline & Retry | Card decline handled; retry succeeds on same intent without duplicate | Verified in Stripe test mode |
| 3D Secure (3DS) | `requires_action` correctly halts success claim and prompts completion | Verified in Stripe test mode |
