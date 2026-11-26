import test from "node:test";
import assert from "node:assert/strict";
import { isNewerVersion, validateReleaseInfo } from "../src/updater";

const validRelease = (version = "0.5.1") => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/hugohinoto/SecureChat-Desktop/releases/tag/v${version}`,
  assets: [{
    name: `SecureChat-Desktop-${version}-portable.exe`,
    browser_download_url: `https://github.com/hugohinoto/SecureChat-Desktop/releases/download/v${version}/SecureChat-Desktop-${version}-portable.exe`,
    digest: `sha256:${"a".repeat(64)}`
  }]
});

test("version comparison accepts only newer stable semantic versions", () => {
  assert.equal(isNewerVersion("0.5.1", "0.5.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.99.99"), true);
  assert.equal(isNewerVersion("0.5.0", "0.5.0"), false);
  assert.equal(isNewerVersion("0.4.99", "0.5.0"), false);
  assert.equal(isNewerVersion("0.5.1-beta.1", "0.5.0"), false);
});

test("release validation requires exact repo asset, stable tag and SHA-256 digest", () => {
  const update = validateReleaseInfo(validRelease(), "0.5.0");
  assert.equal(update?.version, "0.5.1");
  assert.equal(update?.sha256, "a".repeat(64));
  assert.equal(validateReleaseInfo(validRelease("0.4.9"), "0.5.0"), null);
  assert.equal(validateReleaseInfo({ ...validRelease(), prerelease: true }, "0.5.0"), null);
  assert.equal(validateReleaseInfo({ ...validRelease(), draft: true }, "0.5.0"), null);
  assert.equal(validateReleaseInfo({ ...validRelease(), assets: [] }, "0.5.0"), null);
});

test("release validation rejects unsafe download hosts, paths and malformed digests", () => {
  const unsafeHost = validRelease();
  unsafeHost.assets[0].browser_download_url = "https://evil.example/update.exe";
  assert.equal(validateReleaseInfo(unsafeHost, "0.5.0"), null);
  const unsafePath = validRelease();
  unsafePath.assets[0].browser_download_url = "https://github.com/other/repo/releases/download/v0.5.1/update.exe";
  assert.equal(validateReleaseInfo(unsafePath, "0.5.0"), null);
  const badDigest = validRelease();
  badDigest.assets[0].digest = "sha256:not-a-hash";
  assert.equal(validateReleaseInfo(badDigest, "0.5.0"), null);
});

test("main process checks for updates periodically and only offers restart after staging", async () => {
  const main = await (await import("node:fs/promises")).readFile("src/main.ts", "utf8");
  const updater = await (await import("node:fs/promises")).readFile("src/updater.ts", "utf8");
  assert.match(main, /startUpdateMonitor/);
  assert.match(main, /6 \* 60 \* 60 \* 1000/);
  assert.match(main, /launchStagedUpdate/);
  assert.match(updater, /UPDATE_INTEGRITY_CHECK_FAILED/);
  assert.match(updater, /update-healthy-/);
  assert.match(updater, /Move-Item -LiteralPath \$stage -Destination \$exe -Force/);
  assert.match(updater, /Move-Item -LiteralPath \$backup -Destination \$exe -Force/);
  assert.match(updater, /AddSeconds\(75\)/);
});
