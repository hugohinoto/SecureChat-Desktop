import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const REPOSITORY = "hugohinoto/SecureChat-Desktop";
const MAX_RELEASE_BYTES = 250 * 1024 * 1024;
const VERSION_PATTERN = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/;

export type ReleaseAsset = { name?: unknown; browser_download_url?: unknown; digest?: unknown };
export type ReleaseInfo = { tag_name?: unknown; draft?: unknown; prerelease?: unknown; html_url?: unknown; assets?: unknown };
export type AvailableUpdate = { version: string; downloadUrl: string; sha256: string; releaseUrl: string };

function parseVersion(value: string): [number, number, number] | null {
  if (!VERSION_PATTERN.test(value)) return null;
  return value.split(".").map(Number) as [number, number, number];
}
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate), installed = parseVersion(current);
  if (!next || !installed) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return false;
}
export function validateReleaseInfo(value: unknown, currentVersion: string): AvailableUpdate | null {
  if (!value || typeof value !== "object") return null;
  const release = value as ReleaseInfo;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string" ||
      !release.tag_name.startsWith("v") || !Array.isArray(release.assets)) return null;
  const version = release.tag_name.slice(1);
  if (!isNewerVersion(version, currentVersion)) return null;
  const expectedName = `SecureChat-Desktop-${version}-portable.exe`;
  const asset = (release.assets as ReleaseAsset[]).find(item => item?.name === expectedName);
  if (!asset || typeof asset.browser_download_url !== "string" || typeof asset.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) return null;
  let url: URL;
  try { url = new URL(asset.browser_download_url); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "github.com" ||
      !url.pathname.startsWith(`/${REPOSITORY}/releases/download/`)) return null;
  const releaseUrl = typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/")
    ? release.html_url : `https://github.com/${REPOSITORY}/releases/tag/v${version}`;
  return { version, downloadUrl: url.toString(), sha256: asset.digest.slice(7), releaseUrl };
}

export async function checkLatestUpdate(currentVersion: string): Promise<AvailableUpdate | null> {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "SecureChat-Desktop-Updater" },
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`UPDATE_CHECK_HTTP_${response.status}`);
  return validateReleaseInfo(await response.json(), currentVersion);
}

function toPowerShellLiteral(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}'))`;
}
export async function confirmPendingUpdate(userDataPath: string): Promise<void> {
  const pendingPath = join(userDataPath, "pending-update.json");
  try {
    const pending = JSON.parse(await readFile(pendingPath, "utf8")) as { version?: unknown; markerPath?: unknown };
    if (typeof pending.version !== "string" || typeof pending.markerPath !== "string") return;
    const root = resolve(userDataPath), marker = resolve(pending.markerPath), relative = marker.slice(root.length);
    if (!relative || relative.startsWith(sep) && relative.slice(1).startsWith("..") || !marker.startsWith(root + sep)) return;
    await writeFile(marker, pending.version, { encoding: "utf8", mode: 0o600 });
  } catch { /* No pending update is the normal startup path. */ }
}

export async function downloadAndStageUpdate(update: AvailableUpdate, userDataPath: string): Promise<{ helperPath: string }> {
  if (process.platform !== "win32" || !process.env.PORTABLE_EXECUTABLE_FILE) throw new Error("PORTABLE_UPDATE_NOT_SUPPORTED");
  const executable = resolve(process.env.PORTABLE_EXECUTABLE_FILE);
  if (!isAbsolute(executable) || extname(executable).toLowerCase() !== ".exe") throw new Error("PORTABLE_EXECUTABLE_PATH_INVALID");
  const response = await fetch(update.downloadUrl, { redirect: "follow", signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`UPDATE_DOWNLOAD_HTTP_${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_RELEASE_BYTES) throw new Error("UPDATE_DOWNLOAD_TOO_LARGE");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RELEASE_BYTES) throw new Error("UPDATE_DOWNLOAD_SIZE_INVALID");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== update.sha256) throw new Error("UPDATE_INTEGRITY_CHECK_FAILED");

  const staged = executable + ".securechat-update.exe";
  const backup = executable + ".securechat-rollback.exe";
  const marker = join(userDataPath, `update-healthy-${update.version}.flag`);
  const pending = join(userDataPath, "pending-update.json");
  await mkdir(userDataPath, { recursive: true });
  await rm(staged, { force: true });
  await writeFile(staged, bytes, { flag: "wx", mode: 0o700 });
  await rm(marker, { force: true });
  await writeFile(pending, JSON.stringify({ version: update.version, markerPath: marker }), { mode: 0o600 });

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$exe = ${toPowerShellLiteral(executable)}`,
    `$stage = ${toPowerShellLiteral(staged)}`,
    `$backup = ${toPowerShellLiteral(backup)}`,
    `$marker = ${toPowerShellLiteral(marker)}`,
    `$oldPid = ${process.pid}`,
    "Wait-Process -Id $oldPid -ErrorAction SilentlyContinue",
    "Start-Sleep -Seconds 2",
    "try {",
    "  Copy-Item -LiteralPath $exe -Destination $backup -Force",
    "  Move-Item -LiteralPath $stage -Destination $exe -Force",
    "  Start-Process -FilePath $exe",
    "  $deadline = (Get-Date).AddSeconds(75)",
    "  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $marker)) { Start-Sleep -Milliseconds 500 }",
    "  if (Test-Path -LiteralPath $marker) {",
    "    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue",
    "    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue",
    "    Remove-Item -LiteralPath ${toPowerShellLiteral(pending)} -Force -ErrorAction SilentlyContinue",
    "    exit 0",
    "  }",
    "  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "  Start-Sleep -Seconds 2",
    "  Move-Item -LiteralPath $backup -Destination $exe -Force",
    "  Start-Process -FilePath $exe",
    "} catch {",
    "  if (Test-Path -LiteralPath $backup) {",
    "    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "    Start-Sleep -Seconds 2",
    "    Move-Item -LiteralPath $backup -Destination $exe -Force",
    "    Start-Process -FilePath $exe",
    "  }",
    "}",
    "Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue",
    "Remove-Item -LiteralPath ${toPowerShellLiteral(pending)} -Force -ErrorAction SilentlyContinue"
  ].join("\r\n");
  const helperPath = join(userDataPath, "apply-update.ps1");
  await writeFile(helperPath, script, { encoding: "utf8", mode: 0o600 });
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    detached: true, stdio: "ignore", windowsHide: true
  });
  child.unref();
  return { helperPath };
}
