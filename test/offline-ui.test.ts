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


test("offline fallback retries the server and preserves the vault until API reachability is confirmed", async () => {
  const main = await readFile("src/main.ts", "utf8");
  const remoteWindowLoad = main.slice(main.indexOf('current.webContents.on("did-finish-load"'), main.indexOf('current.webContents.on("did-fail-load"'));
  const reconnect = main.slice(main.indexOf("async function checkForServerAndReconnect"), main.indexOf("function startAutoReconnectMonitor"));
  assert.match(main, /function startAutoReconnectMonitor/);
  assert.match(main, /setInterval\(\(\) => \{ void checkForServerAndReconnect\(\); \}, 15000\)/);
  assert.match(main, /AbortSignal\.timeout\(8000\)/);
  assert.match(reconnect, /createRemoteWindow\(origin, true\)/);
  assert.doesNotMatch(remoteWindowLoad, /localWindow\.destroy\(\)/);
  assert.match(reconnect, /if \(onlineWindow && reachable\)[\s\S]*if \(offlineWindow\)[\s\S]*vault\.lock\(\);\s+offlineWindow\.destroy\(\)/);
  assert.match(main, /createLocalWindow\(true\)/);
});

test("connection notifications are transition-based, privacy-safe, and accessible", async () => {
  const main = await readFile("src/main.ts", "utf8");
  const preload = await readFile("src/preload.ts", "utf8");
  const shared = await readFile("src/shared.ts", "utf8");
  const html = await readFile("src/renderer/index.html", "utf8");
  const js = await readFile("src/renderer/app.js", "utf8");
  const css = await readFile("src/renderer/styles.css", "utf8");
  assert.match(main, /if \(connectionState === next\) return/);
  assert.match(main, /previous === "unknown"\) return/);
  assert.match(main, /Notification\.isSupported\(\)/);
  assert.match(main, /next === "online" \|\| !BrowserWindow\.getFocusedWindow\(\)/);
  assert.match(main, /connection:status/);
  assert.match(preload, /onConnectionState/);
  assert.match(shared, /getConnectionState/);
  assert.match(html, /id="connection-toast"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(js, /再接続中/);
  assert.match(js, /メッセージは送信されません/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(main, /messages\[next\].*messageBody|通知本文.*message\.text/);
});
