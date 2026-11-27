import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/web-client/app.js", import.meta.url), "utf8");
const automation = readFileSync(new URL("../src/web-client/crypto-automation.js", import.meta.url), "utf8");
const crypto = readFileSync(new URL("../src/web-client/crypto-v2.js", import.meta.url), "utf8");

test("desktop automatic key exchange runs after sign-in and during foreground maintenance", () => {
  assert.match(app, /void runAutomaticCryptoMaintenance\(\)/);
  assert.match(app, /\+\+cryptoMaintenanceTick % 30 === 0/);
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
