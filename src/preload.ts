import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "./shared";
const api:DesktopApi={
  createVault:p=>ipcRenderer.invoke("vault:create",p),unlock:p=>ipcRenderer.invoke("vault:unlock",p),
  lock:()=>ipcRenderer.invoke("vault:lock"),getSnapshot:()=>ipcRenderer.invoke("vault:snapshot"),
  createConversation:t=>ipcRenderer.invoke("conversation:create",t),
  addLocalMessage:(id,t)=>ipcRenderer.invoke("message:add-local",id,t),
  getVaultStatus:()=>ipcRenderer.invoke("vault:status")
};
contextBridge.exposeInMainWorld("secureChat",api);
