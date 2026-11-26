import { contextBridge, ipcRenderer } from "electron";

type ApiRequest = { method?: string; body?: string | Uint8Array | null; contentType?: string };
type ApiResponse = { status: number; body: string | Uint8Array; contentType: string };

contextBridge.exposeInMainWorld("secureChatDesktop", {
  request: (path: string, request: ApiRequest): Promise<ApiResponse> =>
    ipcRenderer.invoke("api:request", path, request),
  getConnectionState: (): Promise<"online" | "offline" | "reconnecting"> =>
    ipcRenderer.invoke("connection:remote-status"),
  onConnectionState: (callback: (state: "online" | "offline" | "reconnecting") => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: "online" | "offline" | "reconnecting") => callback(state);
    ipcRenderer.on("connection:state", listener);
    return () => ipcRenderer.removeListener("connection:state", listener);
  }
});
