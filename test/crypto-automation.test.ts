import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const app = readFileSync(join(__dirname, "../src/renderer/web-client/app.js"), "utf8");
const automation = readFileSync(join(__dirname, "../src/renderer/web-client/crypto-automation.js"), "utf8");
const crypto = readFileSync(join(__dirname, "../src/renderer/web-client/crypto-v2.js"), "utf8");

test("desktop automatic key exchange runs after sign-in and during foreground maintenance", () => {
  assert.match(app, /void runAutomaticCryptoMaintenance\(\)/);
  assert.match(app, /\+\+cryptoMaintenanceTick % 60 === 0/);
  assert.match(app, /document\.addEventListener\("visibilitychange"/);
  assert.match(app, /window\.addEventListener\("focus"/);
});

test("desktop automation retains the out-of-band fingerprint gate", () => {
  assert.match(app, /verifiedPeerPins\[peerUserId\] === peer\.identitySigningPublicKey/);
  assert.match(app, /if\(!cryptoV2Ready \|\| !cryptoV2Module \|\| !conversation \|\|\s*!cryptoV2Required \|\| !activePeerFingerprintVerified \|\| activeProtocolVersion===2\) return;/);
  assert.match(automation, /if \(!await isPeerTrusted\(peerUserId\)\)/);
});

test("automatic device-session maintenance queries trusted devices and missing Olm sessions", () => {
  assert.match(crypto, /export async function maintainPeerSessions/);
  assert.match(crypto, /registerAndTrustParticipants\(current, String\(peerUserId\)\.toLowerCase\(\)\)/);
  assert.match(crypto, /context\.machine\.getMissingSessions/);
});
