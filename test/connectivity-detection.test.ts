import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("online state is based on API reachability, not local renderer load", async () => {
  const main = await readFile("src/main.ts", "utf8");
  const remoteWindow = main.slice(main.indexOf("function createRemoteWindow"), main.indexOf("async function isServerReachable"));
  assert.match(remoteWindow, /setConnectionState\("reconnecting"\)/);
  assert.doesNotMatch(remoteWindow, /setConnectionState\("online"\)/);
  assert.match(remoteWindow, /void checkForServerAndReconnect\(\)/);
});

test("startup and reconnect share a tolerant HTTP reachability probe", async () => {
  const main = await readFile("src/main.ts", "utf8");
  assert.match(main, /async function isServerReachable\(origin: string\)/);
  assert.match(main, /response\.status >= 100 && response\.status < 600/);
  assert.doesNotMatch(main, /response\.url\.startsWith\(origin\)/);
  assert.match(main, /if \(await isServerReachable\(savedUrl\)\) createRemoteWindow/);
  assert.match(main, /const reachable = await isServerReachable\(origin\)/);
  assert.match(main, /if \(onlineWindow && reachable\) \{\s*setConnectionState\("online"\)/);
});

test("HTTP errors are treated as reachable transport responses", async () => {
  const main = await readFile("src/main.ts", "utf8");
  assert.match(main, /even if its API currently returns 5xx/);
});
