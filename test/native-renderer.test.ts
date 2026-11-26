import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("online and offline desktop windows render bundled local pages", async () => {
  const main = await readFile("src/main.ts", "utf8");
  assert.match(main, /renderer", "web-client", "index\.html"/);
  assert.match(main, /renderer", "web-client", "offline\.html"/);
  assert.doesNotMatch(main, /current\.loadURL\(origin\)/);
  assert.match(main, /preload: join\(__dirname, "web-preload\.js"\)/);
});

test("online web client API traffic is bridged through the main process", async () => {
  const main = await readFile("src/main.ts", "utf8");
  const preload = await readFile("src/web-preload.ts", "utf8");
  const bootstrap = await readFile("src/web-client/desktop-bootstrap.js", "utf8");
  assert.match(bootstrap, /target\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(bootstrap, /secureChatDesktop\.request/);
  assert.match(bootstrap, /body instanceof Blob/);
  assert.match(main, /ipcMain\.handle\("api:request"/);
  assert.match(main, /pathValue\.startsWith\("\/api\/"\)/);
  assert.match(main, /target\.origin !== origin/);
  assert.match(main, /Origin: origin/);
  assert.match(main, /safeStorage\.encryptString/);
  assert.match(main, /safeStorage\.decryptString/);
  assert.match(preload, /api:request/);
  assert.doesNotMatch(preload, /sessionCookie|Cookie/);
});

test("offline workspace uses the same bundled SecureChat visual system", async () => {
  const html = await readFile("src/web-client/offline.html", "utf8");
  const css = await readFile("src/web-client/styles.css", "utf8");
  const js = await readFile("src/web-client/offline.js", "utf8");
  for (const selector of [
    'class="app-shell"',
    'class="sidebar glass-panel"',
    'class="chat-panel glass-panel"',
    'class="chat-header"',
    'class="security-banner"',
    'class="timeline" id="messages"',
    'class="composer-area"',
    'class="auth-gate"'
  ]) assert.ok(html.includes(selector), `missing shared layout hook: ${selector}`);
  for (const token of [".app-shell", ".chat-header", ".security-banner", ".auth-card", ".message-row", ".composer-area"]) {
    assert.ok(css.includes(token), `missing shared visual token: ${token}`);
  }
  assert.match(js, /addLocalMessage/);
  assert.match(js, /相手には送信されません/);
  assert.match(html, /styles\.css/);
  assert.match(html, /ui-refresh\.css/);
});

test("bundled client build rewrites web paths and applies a local-only CSP", async () => {
  const script = await readFile("scripts/copy-renderer.cjs", "utf8");
  assert.match(script, /href="\\//);
  assert.match(script, /crypto-v2\.bundle\.js/);
  assert.match(script, /connect-src 'self' data:/);
  assert.match(script, /loader: \{ "\.wasm": "dataurl" \}/);
  assert.match(script, /desktop-bootstrap\.js/);
});
