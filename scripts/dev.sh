#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: bash scripts/dev.sh [--check]' \
    'Start the local app and Stripe webhook listener, or only check sandbox access.'
}

case "${1:-}" in
  '') ;;
  --check) ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 1 ;;
esac

fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

command -v node >/dev/null 2>&1 || fail 'Install Node.js with npm, then run this command again.'
command -v npm >/dev/null 2>&1 || fail 'npm is missing. Install Node.js with npm first.'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || fail 'Node.js 18 or newer is required.'
command -v stripe >/dev/null 2>&1 || fail 'Install Stripe CLI first: https://docs.stripe.com/stripe-cli#install'

if [[ ! -f .env ]]; then
  (umask 077; cp sample.env .env)
  fail 'Created .env. Add the sandbox secret and publishable keys from the same sandbox, then run this command again.'
fi

if ! node -e "require('dotenv'); require('express'); require('express-handlebars'); require('stripe')" >/dev/null 2>&1; then
  printf '%s\n' 'Installing project dependencies...'
  npm ci --no-fund
fi

# Parse dotenv values as data instead of executing the configuration as shell code
read_key() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const config = require('dotenv').parse(fs.readFileSync('.env'));
process.stdout.write(config[process.argv[2]] || '');
NODE
}

STRIPE_SECRET_KEY="$(read_key STRIPE_SECRET_KEY)"
STRIPE_PUBLISHABLE_KEY="$(read_key STRIPE_PUBLISHABLE_KEY)"
[[ "$STRIPE_SECRET_KEY" =~ ^(sk|rk)_test_[[:alnum:]]+$ ]] || fail 'Set a sandbox secret or restricted key in .env; live keys and example placeholders are not accepted.'
[[ "$STRIPE_PUBLISHABLE_KEY" =~ ^pk_test_[[:alnum:]]+$ ]] || fail 'Set the matching sandbox publishable key in .env.'
export STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY
PORT="${PORT:-3000}"
[[ "$PORT" =~ ^[0-9]+$ ]] && ((10#$PORT >= 1 && 10#$PORT <= 65535)) || fail 'PORT must be a number between 1 and 65535.'
export PORT

# The listener uses the app's key so a saved CLI login cannot select another sandbox
export STRIPE_API_KEY="$STRIPE_SECRET_KEY"

listener_pid=''
server_pid=''
run_dir="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/stripe-press.XXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT
  for pid in "$server_pid" "$listener_pid"; do
    if [[ -n "$pid" ]]; then
      kill -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$run_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s\n' 'Checking Stripe sandbox access...'
if ! stripe whoami --format json >"$run_dir/identity.log" 2>&1; then
  printf '%s\n' 'No CLI session found; checking the sandbox key directly.'
fi
if ! stripe get /v1/account >"$run_dir/auth.log" 2>&1; then
  fail 'Stripe authentication failed. Check your sandbox key, network connection, and account-read permissions if using a restricted key.'
fi
printf '%s\n' 'Sandbox API authentication passed.'

if [[ "${1:-}" == '--check' ]]; then
  printf '%s\n' 'Checks complete. The server and listener were not started.'
  exit 0
fi

node <<'NODE'
const net = require('node:net');
const server = net.createServer();
server.on('error', () => {
  console.error('Port ' + process.env.PORT + ' is unavailable. Stop the existing app or choose another PORT.');
  process.exit(1);
});
server.listen(Number(process.env.PORT), () => server.close());
NODE

# Give background jobs separate groups so cleanup also stops CLI wrapper children
set -m
printf '%s\n' 'Starting Stripe webhook forwarding...'
stripe listen --color off --skip-update \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired \
  --forward-to "http://localhost:$PORT/webhook" >"$run_dir/listener.log" 2>&1 &
listener_pid=$!

STRIPE_WEBHOOK_SECRET=''
for ((attempt = 0; attempt < 30; attempt++)); do
  kill -0 "$listener_pid" 2>/dev/null || fail 'Stripe listener stopped. Check your network connection and key permissions for webhook listening.'
  STRIPE_WEBHOOK_SECRET="$(sed -nE 's/.*(whsec_[[:alnum:]]+).*/\1/p' "$run_dir/listener.log" | head -n 1)"
  [[ -n "$STRIPE_WEBHOOK_SECRET" ]] && break
  sleep 1
done
[[ -n "$STRIPE_WEBHOOK_SECRET" ]] || fail 'Stripe listener did not become ready within 30 seconds. Check the connection and try again.'
export STRIPE_WEBHOOK_SECRET

# Pass this listener's secret to the app without changing the saved .env file
node app.js &
server_pid=$!

node <<'NODE'
const http = require('node:http');
let attempts = 0;
function check() {
  const request = http.get('http://localhost:' + process.env.PORT + '/', response => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  });
  request.setTimeout(1000, () => request.destroy());
  request.on('error', () => {
    if (++attempts < 10) setTimeout(check, 500);
    else { console.error('The app did not start successfully.'); process.exit(1); }
  });
}
check();
NODE

printf '%s\n' "Ready: http://localhost:$PORT" \
  "Webhooks: Stripe sandbox -> http://localhost:$PORT/webhook" \
  'Payment events appear below. Press Ctrl+C to stop the app and listener.'

while kill -0 "$listener_pid" 2>/dev/null && kill -0 "$server_pid" 2>/dev/null; do
  sleep 1
done
fail 'The app or Stripe listener stopped unexpectedly. Both processes will be stopped; run the launcher again after checking the connection.'
