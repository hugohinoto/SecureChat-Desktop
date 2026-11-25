import { app, BrowserWindow, ipcMain, Menu, session, shell } from "electron";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { validateServerUrl } from "./server-url";

type ServerConfig = { serverUrl: string };
let remoteWindow: BrowserWindow | null = null;
let configWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let configuredServerUrl: string | null = null;
let configPath = "";

function configurePortableProfile(): void {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) app.setPath("userData", join(portableDir, "portable-data"));
  configPath = join(app.getPath("userData"), "server-config.json");
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

function isTrustedConfigSender(event: Electron.IpcMainInvokeEvent): boolean {
  return !!configWindow && event.sender === configWindow.webContents &&
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

function createRemoteWindow(serverUrl: string): void {
  const origin = validateServerUrl(serverUrl);
  configuredServerUrl = origin;
  if (remoteWindow && !remoteWindow.isDestroyed()) {
    remoteWindow.destroy();
    remoteWindow = null;
  }
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
  current.webContents.on("will-navigate", (event, url) => {
    try { if (new URL(url).origin !== origin) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  current.webContents.on("will-redirect", (event, url) => {
    try { if (new URL(url).origin !== origin) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  current.webContents.on("did-finish-load", () => {
    if (current !== remoteWindow || current.isDestroyed()) return;
    current.show();
    closeSplash();
    if (configWindow && !configWindow.isDestroyed()) configWindow.close();
  });
  current.webContents.on("did-fail-load", (_event, code, _description, _validatedURL, isMainFrame) => {
    if (!isMainFrame || current !== remoteWindow || current.isDestroyed()) return;
    current.hide();
    closeSplash();
    createConfigWindow("サーバーへ接続できませんでした。URLとネットワークを確認してください。 (ERR " + code + ")");
  });
  current.on("closed", () => { if (remoteWindow === current) remoteWindow = null; });
  void current.loadURL(origin);
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
}

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: "SecureChat", submenu: [
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
  registerIpc();
  installApplicationMenu();
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "notifications");
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "notifications");
  createSplash();
  try {
    const envUrl = process.env.SECURECHAT_SERVER_URL;
    const savedUrl = envUrl ? validateServerUrl(envUrl) : await readServerConfig();
    if (savedUrl) createRemoteWindow(savedUrl);
    else { closeSplash(); createConfigWindow(); }
  } catch (error) {
    closeSplash();
    createConfigWindow(error instanceof Error ? error.message : "サーバー設定を読み込めませんでした。");
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (configuredServerUrl) createRemoteWindow(configuredServerUrl);
      else createConfigWindow();
    }
  });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
