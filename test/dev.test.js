const test = require('node:test');
const bashTest = (name, run) => test(name, {
  skip: process.platform === 'win32' ? 'Run launcher tests under WSL' : false,
  timeout: 15000
}, run);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const fixtureKey = 'sk_test_launcher';
const fixtureSecret = 'whsec_launcher';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t, { missingEnv = false, secretKey = fixtureKey, failAuth = false, failListener = false, port } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bookshop-launcher-'));
  const project = path.join(temporary, 'project');
  fs.mkdirSync(project);
  for (const entry of ['scripts', 'sample.env', 'app.js', 'lib', 'views', 'public']) {
    fs.cpSync(path.join(root, entry), path.join(project, entry), { recursive: true });
  }
  const envPath = path.join(project, '.env');
  const envText = `STRIPE_SECRET_KEY=${secretKey}\nSTRIPE_PUBLISHABLE_KEY=pk_test_launcher\nSTRIPE_WEBHOOK_SECRET=whsec_previous\n`;
  if (!missingEnv) fs.writeFileSync(envPath, envText);
  const bin = path.join(temporary, 'bin');
  const trace = path.join(temporary, 'trace.jsonl');
  const tmp = path.join(temporary, 'tmp');
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(bin, 'stripe'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const record = data => fs.appendFileSync(process.env.LAUNCHER_TRACE, JSON.stringify(data) + '\\n');
if (process.env.STRIPE_API_KEY !== '${fixtureKey}') process.exit(2);
record({ command: args[0], pid: process.pid });
if (args[0] === 'whoami') { console.log('{}'); process.exit(0); }
if (args[0] === 'get') {
  if (process.env.FAIL_AUTH === '1') { console.error('${fixtureKey} authentication failed'); process.exit(1); }
  console.log('{}'); process.exit(0);
}
if (args[0] === 'listen') {
  if (process.env.FAIL_LISTENER === '1') { console.error('${fixtureKey} listener failed'); process.exit(1); }
  console.log('Ready! Your webhook signing secret is ${fixtureSecret}');
  process.on('SIGTERM', () => { record({ command: 'stopped', pid: process.pid }); process.exit(0); });
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 });
  const selectedPort = port || await freePort();
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once('close', resolve));
        child.kill('SIGTERM');
        await stopped;
      }
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  function run(args = []) {
    const child = spawn('bash', [path.join(project, 'scripts/dev.sh'), ...args], {
      cwd: temporary,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
        NODE_PATH: path.join(root, 'node_modules'), TMPDIR: tmp,
        PORT: String(selectedPort), LAUNCHER_TRACE: trace,
        FAIL_AUTH: failAuth ? '1' : '0', FAIL_LISTENER: failListener ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const finished = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    return { child, finished, output: () => output };
  }
  return { run, port: selectedPort, envPath, envText, tmp,
    events: () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Launcher did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function noSecrets(output) {
  assert.ok(!output.includes(fixtureKey));
  assert.ok(!output.includes(fixtureSecret));
}

bashTest('launcher creates missing configuration and stops before Stripe calls', async t => {
  const f = await fixture(t, { missingEnv: true });
  const result = await f.run().finished;
  assert.equal(result.code, 1);
  assert.match(result.output, /Created .env/);
  assert.ok(fs.existsSync(f.envPath));
  assert.equal(f.events().length, 0);
});

bashTest('launcher rejects live keys before calling Stripe', async t => {
  const f = await fixture(t, { secretKey: 'sk_live_launcher' });
  const result = await f.run(['--check']).finished;
  assert.equal(result.code, 1);
  assert.match(result.output, /live keys/);
  assert.equal(f.events().length, 0);
});

bashTest('launcher check validates authentication without starting the listener', async t => {
  const f = await fixture(t);
  const result = await f.run(['--check']).finished;
  assert.equal(result.code, 0);
  assert.deepEqual(f.events().map(e => e.command), ['whoami', 'get']);
  assert.equal(fs.readFileSync(f.envPath, 'utf8'), f.envText);
  assert.deepEqual(fs.readdirSync(f.tmp), []);
  noSecrets(result.output);
});

bashTest('launcher authentication failure hides credentials and removes temporary logs', async t => {
  const f = await fixture(t, { failAuth: true });
  const result = await f.run().finished;
  assert.equal(result.code, 1);
  assert.match(result.output, /authentication failed/);
  assert.deepEqual(f.events().map(e => e.command), ['whoami', 'get']);
  assert.deepEqual(fs.readdirSync(f.tmp), []);
  noSecrets(result.output);
});

bashTest('launcher leaves an occupied port alone', async t => {
  const occupied = net.createServer();
  await new Promise(resolve => occupied.listen(0, resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const f = await fixture(t, { port: occupied.address().port });
  const result = await f.run().finished;
  assert.equal(result.code, 1);
  assert.match(result.output, /unavailable/);
  assert.equal(occupied.listening, true);
  assert.ok(!f.events().some(e => e.command === 'listen'));
});

bashTest('launcher reports listener failure without starting the app or leaking keys', async t => {
  const f = await fixture(t, { failListener: true });
  const result = await f.run().finished;
  assert.equal(result.code, 1);
  assert.match(result.output, /listener stopped/);
  assert.deepEqual(fs.readdirSync(f.tmp), []);
  noSecrets(result.output);
});

bashTest('launcher forwards with an ephemeral secret and cleans up both processes on exit', async t => {
  const f = await fixture(t);
  const run = f.run();
  await until(() => run.output().includes('Ready: http://localhost:'));
  assert.equal((await fetch(`http://localhost:${f.port}/`)).status, 200);
  const Stripe = require('stripe');
  const stripe = new Stripe(fixtureKey);
  const payload = JSON.stringify({ id: 'evt_launcher', type: 'payment_intent.succeeded', data: { object: { id: 'pi_launcher', status: 'succeeded' } } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: fixtureSecret });
  const webhook = await fetch(`http://localhost:${f.port}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body: payload
  });
  assert.equal(webhook.status, 200);
  run.child.kill('SIGTERM');
  const result = await run.finished;
  assert.equal(result.code, 143);
  const listener = f.events().find(e => e.command === 'listen');
  assert.throws(() => process.kill(listener.pid, 0), { code: 'ESRCH' });
  await assert.rejects(fetch(`http://localhost:${f.port}/`));
  assert.equal(fs.readFileSync(f.envPath, 'utf8'), f.envText);
  assert.deepEqual(fs.readdirSync(f.tmp), []);
  noSecrets(result.output);
});
