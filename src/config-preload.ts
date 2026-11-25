import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("secureChatConfig", {
  get: () => ipcRenderer.invoke("config:get"),
  save: (serverUrl: string) => ipcRenderer.invoke("config:save", serverUrl),
  onError: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on("config:error", listener);
    return () => ipcRenderer.removeListener("config:error", listener);
  }
});
