# Setup and troubleshooting

[Overview](../README.md) · [Design](design.md) · [Configuration](#configuration) · [Manual startup](#manual-startup) · [Troubleshooting](#troubleshooting)

For the normal startup flow, follow [extract to first payment](../README.md#start-here-extract-to-first-payment).

## Prerequisites

Install a supported [Node.js release with npm](https://nodejs.org/en/download), and [Stripe CLI](https://docs.stripe.com/stripe-cli#install). You also need a Stripe sandbox and internet access for Stripe and page assets.

On macOS with Homebrew, install the CLI with:

```bash
brew install stripe/stripe-cli/stripe
```

Check your tools:

```bash
node --version
npm --version
stripe version
```

The launcher supports Bash on macOS, Linux, or WSL and requires Node.js 18+. It checks prerequisites; it does not install system tools.

## Configuration

Extract the ZIP and open a terminal in the project folder containing `package.json`, `sample.env`, and `app.js`. Run commands from that folder. Copy `sample.env` to `.env` only when `.env` does not already exist.

| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | Sandbox server key; stays on the server |
| `STRIPE_PUBLISHABLE_KEY` | Publishable key from the same sandbox; used by Stripe.js |
| `STRIPE_WEBHOOK_SECRET` | Leave blank for the launcher; set the active listener's `whsec_…` value for manual startup |

- Use a restricted sandbox key (`rk_test_…`) with permission for account retrieval, Checkout Session creation/retrieval and expanded PaymentIntent retrieval, and CLI listening, or a sandbox secret key (`sk_test_…`).
- Keep `.env` private and exclude it from any ZIP you share. Restart after changing keys.
- The launcher rejects live keys and checks server-key access. It cannot prove that the publishable key belongs to the same sandbox.

## Launcher

```bash
bash scripts/dev.sh --check
bash scripts/dev.sh
```

- `--check` installs missing npm dependencies and verifies sandbox API access without starting processes.
- Normal startup waits for the listener, passes its signing secret to the app, and prints `Ready: http://localhost:3000`.
- No separate `stripe login` is needed: both processes use the server key from `.env`.
- **Ctrl+C** stops the server and listener, including child processes started by npm-installed CLI wrappers. The script preserves `.env` and deletes its temporary logs.
- `npm run dev` is equivalent. Using `bash scripts/dev.sh` also works if ZIP extraction removes the script's executable permission.

To use another port:

```bash
PORT=3001 bash scripts/dev.sh
```

## Manual startup

Use this instead of the launcher when you want to manage the two processes yourself. After extracting the project and configuring `.env`:

1. Install dependencies with `npm ci`. There is no build step.
2. In a second terminal, log the CLI into the **same account and sandbox** as the app, then start forwarding:

   ```bash
   stripe login
   stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired --forward-to localhost:3000/webhook
   ```

3. Copy the listener's `whsec_…` into `.env` as `STRIPE_WEBHOOK_SECRET`.
4. In the application terminal, run `npm start` and open [localhost:3000](http://localhost:3000).

Keep both terminals open. Restart the app after changing `.env`. The CLI signing secret differs from a Dashboard webhook endpoint's secret.

## Verify

Follow the [test-card walkthrough](../README.md#test-the-payment-flow). Confirm both paths:

- **Receipt:** amount, currency, and `pi_` ID match the sandbox Dashboard.
- **Webhook:** a verified `checkout.session.completed` event with payment status `paid` appears in the app terminal; manual CLI forwarding shows HTTP 200.

To check expiry, expire an unpaid Session in Stripe and reload checkout. The page should show “Checkout expired”; selecting the book again starts a new Session.

Receipt retrieval and webhook delivery are independent. A working receipt alone does not confirm webhook delivery.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Missing Node.js, npm, or Stripe CLI | Install the missing prerequisite above |
| Authentication fails | Check the sandbox server key, restricted-key permissions, and network |
| Checkout is unavailable | Set both API keys and restart |
| Payment Element does not load | Check matching sandbox keys, network access, and browser blockers; retry initialization |
| Payment status is unavailable | Retry the status check; preserve the saved attempt |
| Previous integration warning | This tab retains a direct-PaymentIntent checkout. Verify it in Stripe before clearing that saved attempt; it is never silently replaced |
| Checkout is too old to retry | Inspect Stripe logs and `bookId`/`attemptId` metadata before resetting the attempt |
| Webhook returns 400 | Use the active listener's signing secret and restart the app |
| Port 3000 is occupied | Stop the previous app or use `PORT=3001 bash scripts/dev.sh` |

Configuration, templates, and assets resolve from the project directory. Return URLs use the current browser origin, so moving the repository does not require path edits.
