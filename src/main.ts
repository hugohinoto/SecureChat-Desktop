import { app, BrowserWindow, ipcMain, Menu, net, Notification, safeStorage, session, shell } from "electron";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { validateServerUrl } from "./server-url";
import { VaultStore } from "./vault";

type ServerConfig = { serverUrl: string };
const DEFAULT_SERVER_URL = "https://securechat.hugohinoto.workers.dev";
let remoteWindow: BrowserWindow | null = null;
let localWindow: BrowserWindow | null = null;
let configWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let configuredServerUrl: string | null = null;
let configPath = "";
let sessionCookiePath = "";
let sessionCookie: string | null = null;
let sessionCookieOrigin: string | null = null;
let vault: VaultStore;
let autoReconnectEnabled = false;
let reconnectInFlight = false;
let reconnectTimer: NodeJS.Timeout | null = null;
type ConnectionState = "unknown" | "online" | "offline" | "reconnecting";
let connectionState: ConnectionState = "unknown";

function setConnectionState(next: Exclude<ConnectionState, "unknown">): void {
  if (connectionState === next) return;
  const previous = connectionState;
  connectionState = next;
  if (previous !== "unknown" && localWindow && !localWindow.isDestroyed()) localWindow.webContents.send("connection:state", next);
  if (previous !== "unknown" && remoteWindow && !remoteWindow.isDestroyed()) remoteWindow.webContents.send("connection:state", next);
  // Do not announce the initial state; only meaningful transitions produce notifications.
  if (previous === "unknown") return;
  const messages: Record<Exclude<ConnectionState, "unknown">, { title: string; body: string }> = {
    online: { title: "SecureChatに再接続しました", body: "オンライン画面に戻りました。" },
    offline: { title: "オフラインに切り替わりました", body: "ローカル保管庫で作業を続けられます。ローカルメッセージは送信されません。" },
    reconnecting: { title: "SecureChatに再接続中", body: "サーバーへの接続を確認しました。オンライン画面を準備しています。" }
  };
  // The offline workspace displays an in-app toast while focused. Use OS notifications only in the background.
  if ((next === "online" || !BrowserWindow.getFocusedWindow()) && Notification.isSupported()) {
    const message = messages[next];
    new Notification({ title: message.title, body: message.body, silent: true }).show();
  }
}
function configurePortableProfile(): void {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) app.setPath("userData", join(portableDir, "portable-data"));
  configPath = join(app.getPath("userData"), "server-config.json");
  sessionCookiePath = join(app.getPath("userData"), "desktop-session.bin");
}

async function readServerConfig(): Promise<string | null> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    return validateServerUrl(parsed.serverUrl);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeServerConfig(serverUrl: string): Promise<void> {
  await mkdir(app.getPath("userData"), { recursive: true });
  const tempPath = configPath + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    await writeFile(tempPath, JSON.stringify({ serverUrl } satisfies ServerConfig), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function loadStoredSession(): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) return;
  try {
    const encrypted = await readFile(sessionCookiePath);
    const stored = JSON.parse(safeStorage.decryptString(encrypted)) as { origin?: string; cookie?: string };
    if (typeof stored.origin === "string" && typeof stored.cookie === "string" &&
        /^(?:__Host-sc_session|sc_session)=[A-Za-z0-9_-]{40,128}$/.test(stored.cookie)) {
      sessionCookieOrigin = validateServerUrl(stored.origin);
      sessionCookie = stored.cookie;
    }
  } catch { /* A missing or unreadable session is treated as signed out. */ }
}
async function persistSession(): Promise<void> {
  if (!sessionCookie || !sessionCookieOrigin || !safeStorage.isEncryptionAvailable()) {
    await rm(sessionCookiePath, { force: true }).catch(() => undefined);
    return;
  }
  const encrypted = safeStorage.encryptString(JSON.stringify({ origin: sessionCookieOrigin, cookie: sessionCookie }));
  const tempPath = sessionCookiePath + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    await writeFile(tempPath, encrypted, { mode: 0o600, flag: "wx" });
    await rename(tempPath, sessionCookiePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
async function clearStoredSession(): Promise<void> {
  sessionCookie = null;
  sessionCookieOrigin = null;
  await rm(sessionCookiePath, { force: true }).catch(() => undefined);
}
function isTrustedRemoteSender(event: Electron.IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url || "";
  return !!remoteWindow && event.sender === remoteWindow.webContents &&
    frameUrl.startsWith("file://") && frameUrl.includes("/renderer/web-client/");
}
async function requestDesktopApi(pathValue: unknown, requestValue: unknown): Promise<{ status: number; body: string | Uint8Array; contentType: string }> {
  if (typeof pathValue !== "string" || pathValue.length > 2048 || !pathValue.startsWith("/api/") ||
      pathValue.includes(String.fromCharCode(92))) throw new Error("DESKTOP_API_PATH_REJECTED");
  if (!requestValue || typeof requestValue !== "object") throw new Error("DESKTOP_API_REQUEST_INVALID");
  const request = requestValue as { method?: unknown; body?: unknown; contentType?: unknown };
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("DESKTOP_API_METHOD_REJECTED");
  const requestBody = request.body;
  const bodyIsText = typeof requestBody === "string";
  const bodyIsBytes = requestBody instanceof Uint8Array || requestBody instanceof ArrayBuffer;
  if (requestBody !== undefined && requestBody !== null &&
      (!bodyIsText && !bodyIsBytes ||
       (bodyIsText ? Buffer.byteLength(requestBody as string, "utf8") : (requestBody instanceof ArrayBuffer ? requestBody.byteLength : (requestBody as Uint8Array).byteLength)) > 16 * 1024 * 1024)) {
    throw new Error("DESKTOP_API_BODY_REJECTED");
  }
  const origin = validateServerUrl(configuredServerUrl || DEFAULT_SERVER_URL);
  const target = new URL(pathValue, origin);
  if (target.origin !== origin || !target.pathname.startsWith("/api/")) throw new Error("DESKTOP_API_PATH_REJECTED");
  if (sessionCookieOrigin !== origin) {
    sessionCookie = null;
    sessionCookieOrigin = null;
    await rm(sessionCookiePath, { force: true }).catch(() => undefined);
  }
  const headers = new Headers({ Accept: "application/json", Origin: origin });
  if (sessionCookie) headers.set("Cookie", sessionCookie);
  if (request.contentType === "application/json") headers.set("Content-Type", "application/json");
  else if (typeof request.contentType === "string" && request.contentType.length <= 128 &&
           (request.contentType.startsWith("application/octet-stream") || request.contentType.startsWith("text/plain"))) headers.set("Content-Type", request.contentType);
  const response = await fetch(target, {
    method, headers, body: requestBody == null ? undefined : (requestBody instanceof ArrayBuffer ? Buffer.from(requestBody) : requestBody instanceof Uint8Array ? Buffer.from(requestBody) : requestBody as string),
    redirect: "manual", signal: AbortSignal.timeout(120000)
  });
  const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = responseHeaders.getSetCookie?.() || [response.headers.get("set-cookie") || ""];
  for (const line of setCookies) {
    const pair = line.split(";", 1)[0].trim();
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (name !== "__Host-sc_session" && name !== "sc_session") continue;
    if (!value) await clearStoredSession();
    else {
      sessionCookie = name + "=" + value;
      sessionCookieOrigin = origin;
      await persistSession();
    }
  }
  if (target.pathname === "/api/auth/logout" && response.ok) await clearStoredSession();
  const contentType = response.headers.get("content-type") || "application/json";
  if (contentType.startsWith("application/octet-stream")) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 16 * 1024 * 1024) throw new Error("DESKTOP_API_RESPONSE_TOO_LARGE");
    return { status: response.status, body: bytes, contentType };
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > 16 * 1024 * 1024) throw new Error("DESKTOP_API_RESPONSE_TOO_LARGE");
  return { status: response.status, body, contentType };
}
function isTrustedConfigSender(event: Electron.IpcMainInvokeEvent): boolean {
  return !!configWindow && event.sender === configWindow.webContents &&
    event.senderFrame?.url.startsWith("file://") === true;
}
function isTrustedLocalSender(event: Electron.IpcMainInvokeEvent): boolean {
  return !!localWindow && event.sender === localWindow.webContents &&
    event.senderFrame?.url.startsWith("file://") === true;
}
function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}
function createSplash(): void {
  splashWindow = new BrowserWindow({
    width: 720, height: 405, frame: false, resizable: false, movable: false,
    center: true, show: true, skipTaskbar: true, backgroundColor: "#f1f5f3",
    title: "SecureChat",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  void splashWindow.loadFile(join(__dirname, "renderer", "splash.html"));
}
function createConfigWindow(message = ""): void {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.focus();
    if (message) configWindow.webContents.send("config:error", message);
    return;
  }
  configWindow = new BrowserWindow({
    width: 620, height: 590, minWidth: 520, minHeight: 520,
    title: "SecureChat — サーバー接続設定",
    icon: join(__dirname, "renderer", "assets", "securechat-icon.svg"),
    backgroundColor: "#f1f5f3", show: false,
    webPreferences: {
      preload: join(__dirname, "config-preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  configWindow.once("ready-to-show", () => configWindow?.show());
  configWindow.on("closed", () => { configWindow = null; });
  void configWindow.loadFile(join(__dirname, "renderer", "config.html"));
  if (message) configWindow.webContents.once("did-finish-load", () => configWindow?.webContents.send("config:error", message));
}
function createLocalWindow(enableAutoReconnect = false): void {
  autoReconnectEnabled = enableAutoReconnect;
  if (localWindow && !localWindow.isDestroyed()) { localWindow.show(); localWindow.focus(); return; }
  if (remoteWindow && !remoteWindow.isDestroyed()) { remoteWindow.destroy(); remoteWindow = null; }
  localWindow = new BrowserWindow({
    width: 1280, height: 850, minWidth: 760, minHeight: 600,
    title: "SecureChat Desktop",
    icon: join(__dirname, "renderer", "assets", "securechat-icon.svg"),
    backgroundColor: "#10151d", show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, devTools: !app.isPackaged
    }
  });
  const current = localWindow;
  current.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  current.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });
  current.webContents.once("did-finish-load", () => {
    if (connectionState !== "unknown") current.webContents.send("connection:state", connectionState);
  });
  current.once("ready-to-show", () => { current.show(); closeSplash(); setConnectionState("offline"); });
  current.on("closed", () => { if (localWindow === current) localWindow = null; });
  void current.loadFile(join(__dirname, "renderer", "web-client", "offline.html"));
}
function createRemoteWindow(serverUrl: string, keepOfflineUntilReady = false): void {
  const origin = validateServerUrl(serverUrl);
  configuredServerUrl = origin;
  if (!keepOfflineUntilReady) {
    autoReconnectEnabled = false;
    if (localWindow && !localWindow.isDestroyed()) { vault.lock(); localWindow.destroy(); localWindow = null; }
  }
  if (remoteWindow && !remoteWindow.isDestroyed()) { remoteWindow.destroy(); remoteWindow = null; }
  remoteWindow = new BrowserWindow({
    width: 1280, height: 850, minWidth: 760, minHeight: 600,
    title: "SecureChat Desktop",
    icon: join(__dirname, "renderer", "assets", "securechat-icon.svg"),
    backgroundColor: "#10151d", show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, devTools: !app.isPackaged
    }
  });
  const current = remoteWindow;
  current.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === "https:" && target.origin !== origin) void shell.openExternal(target.toString());
    } catch { /* Invalid and non-HTTPS popups are denied. */ }
    return { action: "deny" };
  });
  const isBundledClientFile = (url: string): boolean => {
    try {
      const target = new URL(url);
      return target.protocol === "file:" && target.pathname.includes("/renderer/web-client/");
    } catch { return false; }
  };
  current.webContents.on("will-navigate", (event, url) => {
    if (isBundledClientFile(url)) return;
    event.preventDefault();
    try { const target = new URL(url); if (target.protocol === "https:") void shell.openExternal(target.toString()); } catch {}
  });
  current.webContents.on("will-redirect", (event, url) => {
    if (!isBundledClientFile(url)) event.preventDefault();
  });
  current.webContents.on("did-finish-load", () => {
    if (current !== remoteWindow || current.isDestroyed()) return;
    current.show(); closeSplash();
    setConnectionState("online");
    autoReconnectEnabled = true;
    if (keepOfflineUntilReady && localWindow && !localWindow.isDestroyed()) {
      vault.lock();
      localWindow.destroy();
      localWindow = null;
    }
    if (configWindow && !configWindow.isDestroyed()) configWindow.close();
  });
  current.webContents.on("did-fail-load", (_event, code, _description, _validatedURL, isMainFrame) => {
    if (!isMainFrame || current !== remoteWindow || current.isDestroyed()) return;
    setConnectionState("offline");
    current.destroy();
    if (remoteWindow === current) remoteWindow = null;
    closeSplash();
    if (!localWindow || localWindow.isDestroyed()) createLocalWindow(true);
  });
  current.on("closed", () => { if (remoteWindow === current) remoteWindow = null; });
  void current.loadFile(join(__dirname, "renderer", "web-client", "index.html"));
}

async function checkForServerAndReconnect(): Promise<void> {
  if (!autoReconnectEnabled || reconnectInFlight) return;
  reconnectInFlight = true;
  try {
    const serverUrl = configuredServerUrl || await readServerConfig() || DEFAULT_SERVER_URL;
    const origin = validateServerUrl(serverUrl);
    let reachable = false;
    try {
      const response = await net.fetch(origin + "/api/auth/me", {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" }
      });
      reachable = response.status >= 200 && response.status < 500 && response.url.startsWith(origin);
    } catch { reachable = false; }

    const onlineWindow = remoteWindow && !remoteWindow.isDestroyed();
    const offlineWindow = localWindow && !localWindow.isDestroyed();
    if (onlineWindow && !reachable) {
      setConnectionState("offline");
      onlineWindow.destroy();
      if (remoteWindow === onlineWindow) remoteWindow = null;
      if (!offlineWindow) createLocalWindow(true);
      return;
    }
    if (offlineWindow && reachable && (!remoteWindow || remoteWindow.isDestroyed())) {
      setConnectionState("reconnecting");
      createRemoteWindow(origin, true);
    }
  } finally {
    reconnectInFlight = false;
  }
}
function startAutoReconnectMonitor(): void {
  if (reconnectTimer) clearInterval(reconnectTimer);
  reconnectTimer = setInterval(() => { void checkForServerAndReconnect(); }, 15000);
  reconnectTimer.unref();
}

function registerIpc(): void {
  ipcMain.handle("config:get", async (event) => {
    if (!isTrustedConfigSender(event)) throw new Error("IPC_SENDER_REJECTED");
    return { serverUrl: configuredServerUrl || await readServerConfig() || "" };
  });
  ipcMain.handle("config:save", async (event, value: unknown) => {
    if (!isTrustedConfigSender(event)) throw new Error("IPC_SENDER_REJECTED");
    const serverUrl = validateServerUrl(value);
    await writeServerConfig(serverUrl);
    createRemoteWindow(serverUrl);
    return { saved: true };
  });
  ipcMain.handle("connection:remote-status", (event) => {
    if (!isTrustedRemoteSender(event)) throw new Error("IPC_SENDER_REJECTED");
    return connectionState === "unknown" ? "offline" : connectionState;
  });
  ipcMain.handle("api:request", async (event, path: unknown, request: unknown) => {
    if (!isTrustedRemoteSender(event)) throw new Error("IPC_SENDER_REJECTED");
    return requestDesktopApi(path, request);
  });
  ipcMain.handle("connection:status", (event) => {
    if (!isTrustedLocalSender(event)) throw new Error("IPC_SENDER_REJECTED");
    return connectionState === "unknown" ? "offline" : connectionState;
  });
  ipcMain.handle("vault:status", async (event) => {
    if (!isTrustedLocalSender(event)) throw new Error("IPC_SENDER_REJECTED");
    return { exists: await vault.exists(), unlocked: vault.unlocked };
  });
  ipcMain.handle("vault:create", async (event, password: unknown) => {
    if (!isTrustedLocalSender(event) || typeof password !== "string") throw new Error("IPC_SENDER_REJECTED");
    await vault.create(password);
  });
  ipcMain.handle("vault:unlock", async (event, password: unknown) => {
    if (!isTrustedLocalSender(event) || typeof password !== "string") throw new Error("IPC_SENDER_REJECTED");
    await vault.unlock(password);
  });
  ipcMain.handle("vault:lock", (event) => {
    if (!isTrustedLocalSender(event)) throw new Error("IPC_SENDER_REJECTED");
    vault.lock();
  });
  ipcMain.handle("vault:snapshot", (event) => {
    if (!isTrustedLocalSender(event)) throw new Error("IPC_SENDER_REJECTED");
    return vault.snapshot();
  });
  ipcMain.handle("conversation:create", async (event, title: unknown) => {
    if (!isTrustedLocalSender(event) || typeof title !== "string") throw new Error("IPC_SENDER_REJECTED");
    return vault.createConversation(title);
  });
  ipcMain.handle("message:add-local", async (event, id: unknown, message: unknown) => {
    if (!isTrustedLocalSender(event) || typeof id !== "string" || typeof message !== "string") throw new Error("IPC_SENDER_REJECTED");
    return vault.addLocalMessage(id, message);
  });
}
function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: "SecureChat", submenu: [
      { label: "オンラインに接続", click: () => { if (configuredServerUrl) createRemoteWindow(configuredServerUrl); else void readServerConfig().then(url => createRemoteWindow(url || DEFAULT_SERVER_URL)); } },
      { label: "オフライン保管庫を開く", click: () => createLocalWindow(false) },
      { label: "サーバー接続先を変更…", click: () => createConfigWindow() },
      { label: "再接続", click: () => { if (configuredServerUrl) createRemoteWindow(configuredServerUrl); } },
      { type: "separator" }, { role: "quit", label: "終了" }
    ] },
    { label: "編集", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "表示", submenu: [{ role: "reload" }, { role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }])] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

configurePortableProfile();
app.setAppUserModelId("jp.hugohinoto.securechat.desktop");
app.whenReady().then(async () => {
  await mkdir(app.getPath("userData"), { recursive: true });
  vault = new VaultStore(join(app.getPath("userData"), "vault.scv"));
  await loadStoredSession();
  registerIpc(); installApplicationMenu();
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === "notifications"));
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "notifications");
  createSplash();
  try {
    const envUrl = process.env.SECURECHAT_SERVER_URL;
    const savedUrl = envUrl ? validateServerUrl(envUrl) : (await readServerConfig()) || DEFAULT_SERVER_URL;
    configuredServerUrl = savedUrl;
    const probe = await net.fetch(savedUrl + "/api/auth/me", {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" }
    });
    if (probe.status >= 200 && probe.status < 500 && probe.url.startsWith(savedUrl)) createRemoteWindow(savedUrl);
    else { closeSplash(); createLocalWindow(true); }

  } catch {
    closeSplash(); createLocalWindow(true);
  }
  startAutoReconnectMonitor();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (configuredServerUrl) createRemoteWindow(configuredServerUrl);
      else createLocalWindow();
    }
  });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
