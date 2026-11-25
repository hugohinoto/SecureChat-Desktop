import test from "node:test";
import assert from "node:assert/strict";
import { validateServerUrl } from "../src/server-url";

test("accepts HTTPS origins and normalizes trailing slash", () => {
  assert.equal(validateServerUrl("https://chat.example.com/"), "https://chat.example.com");
});

test("rejects insecure non-loopback origins", () => {
  assert.throws(() => validateServerUrl("http://chat.example.com", true), /SERVER_URL_HTTPS_REQUIRED/);
});

test("allows loopback HTTP only when development override is explicit", () => {
  assert.equal(validateServerUrl("http://127.0.0.1:8787", true), "http://127.0.0.1:8787");
  assert.throws(() => validateServerUrl("http://127.0.0.1:8787", false), /SERVER_URL_HTTPS_REQUIRED/);
});

test("rejects credentials, paths, query strings, and fragments", () => {
  for (const value of [
    "https://user:pass@chat.example.com",
    "https://chat.example.com/app",
    "https://chat.example.com/?next=/",
    "https://chat.example.com/#fragment"
  ]) assert.throws(() => validateServerUrl(value), /SERVER_URL_/);
});

test("rejects invalid and oversized inputs", () => {
  assert.throws(() => validateServerUrl("not a URL"), /SERVER_URL_INVALID/);
  assert.throws(() => validateServerUrl("https://" + "a".repeat(2050) + ".com"), /SERVER_URL_INVALID/);
});
