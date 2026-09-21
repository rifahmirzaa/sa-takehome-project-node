const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('a relocated app loads its own configuration, templates, and assets from another working directory', () => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bookshop-paths-'));
  const project = path.join(temporary, 'relocated-project');

  try {
    fs.mkdirSync(project);
    for (const entry of ['app.js', 'lib', 'views', 'public']) {
      fs.cpSync(path.join(root, entry), path.join(project, entry), { recursive: true });
    }
    fs.writeFileSync(path.join(project, '.env'), [
      'STRIPE_SECRET_KEY=sk_test_path_fixture',
      'STRIPE_PUBLISHABLE_KEY=pk_test_path_fixture'
    ].join('\n'));

    const env = { ...process.env, NODE_PATH: path.join(root, 'node_modules') };
    delete env.STRIPE_SECRET_KEY;
    delete env.STRIPE_PUBLISHABLE_KEY;

    // The child starts outside the copied project and uses fixture keys without contacting Stripe
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const app = require(process.argv[1]);
      assert.equal(process.env.STRIPE_PUBLISHABLE_KEY, 'pk_test_path_fixture');
      const server = app.listen(0, '127.0.0.1', async () => {
        try {
          const origin = 'http://127.0.0.1:' + server.address().port;
          const home = await fetch(origin + '/');
          assert.equal(home.status, 200);
          assert.match(await home.text(), /Book Nook/);
          const checkout = await fetch(origin + '/checkout?item=1');
          assert.equal(checkout.status, 200);
          assert.match(await checkout.text(), /pk_test_path_fixture/);
          const css = await fetch(origin + '/css/custom.css');
          assert.equal(css.status, 200);
          assert.match(await css.text(), /font-family/);
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
        } finally {
          server.close();
        }
      });
    `, path.join(project, 'app.js')], { cwd: temporary, env, timeout: 15000, stdio: 'pipe' });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
