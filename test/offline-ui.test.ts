import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("offline workspace uses the shared SecureChat workspace layout", async () => {
  const html = await readFile("src/renderer/index.html", "utf8");
  const css = await readFile("src/renderer/styles.css", "utf8");
  for (const selector of [
    'id="workspace" class="app-shell"',
    'class="sidebar glass-panel"',
    'class="chat-panel glass-panel"',
    'class="chat-header"',
    'class="security-banner"',
    'class="timeline" id="messages"',
    'class="composer-area"'
  ]) assert.ok(html.includes(selector), `missing shared layout hook: ${selector}`);
  for (const token of ["#080e19", "#101a2b", "--accent", ".app-shell", ".chat-header", ".security-banner"]) {
    assert.ok(css.includes(token), `missing shared SecureChat visual token: ${token}`);
  }
  assert.match(html, /オフライン/);
  assert.match(html, /相手には送信されません/);
});

test("offline UI keeps the vault gate and renderer controls wired", async () => {
  const html = await readFile("src/renderer/index.html", "utf8");
  const js = await readFile("src/renderer/app.js", "utf8");
  for (const id of ["gate", "gate-form", "gate-title", "gate-description", "gate-submit", "password", "confirm-password-row", "confirm-password", "gate-error", "conversation-list", "new-chat", "chat-title", "messages", "message-input", "composer", "send", "lock"]) {
    assert.ok(html.includes(`id="${id}"`), `missing renderer element: ${id}`);
    assert.ok(js.includes(`"${id}"`), `renderer does not reference element: ${id}`);
  }
});


test("offline fallback retries the configured server and preserves the vault until online load succeeds", async () => {
  const main = await readFile("src/main.ts", "utf8");
  assert.match(main, /function startAutoReconnectMonitor/);
  assert.match(main, /setInterval\(\(\) => \{ void checkForServerAndReconnect\(\); \}, 15000\)/);
  assert.match(main, /AbortSignal\.timeout\(5000\)/);
  assert.match(main, /createRemoteWindow\(origin, true\)/);
  assert.match(main, /if \(keepOfflineUntilReady && localWindow/);
  assert.match(main, /vault\.lock\(\);\s+localWindow\.destroy\(\)/);
  assert.match(main, /createLocalWindow\(true\)/);
});
