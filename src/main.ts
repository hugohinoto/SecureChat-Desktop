import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";
import { VaultStore } from "./vault";
let win:BrowserWindow|null=null;
let vault:VaultStore;
function dataDir():string {
  const portable=process.env.PORTABLE_EXECUTABLE_DIR;
  return portable ? join(portable,"portable-data") : join(app.getPath("userData"),"data");
}
function assertTrustedSender(event: Electron.IpcMainInvokeEvent):void {
  if (!win || event.sender !== win.webContents || !event.senderFrame.url.startsWith("file://")) {
    throw new Error("IPC_SENDER_REJECTED");
  }
}
function registerIpc():void {
  ipcMain.handle("vault:status",(e)=>{assertTrustedSender(e);return vault.exists().then(exists=>({exists,unlocked:vault.unlocked}));});
  ipcMain.handle("vault:create",(e,p:string)=>{assertTrustedSender(e);return vault.create(p);});
  ipcMain.handle("vault:unlock",(e,p:string)=>{assertTrustedSender(e);return vault.unlock(p);});
  ipcMain.handle("vault:lock",(e)=>{assertTrustedSender(e);return vault.lock();});
  ipcMain.handle("vault:snapshot",(e)=>{assertTrustedSender(e);return vault.snapshot();});
  ipcMain.handle("conversation:create",(e,t:string)=>{assertTrustedSender(e);return vault.createConversation(t);});
  ipcMain.handle("message:add-local",(e,id:string,t:string)=>{assertTrustedSender(e);return vault.addLocalMessage(id,t);});
}
function createWindow():void {
  win=new BrowserWindow({width:1080,height:760,minWidth:720,minHeight:560,backgroundColor:"#10151d",title:"SecureChat Desktop",
    webPreferences:{preload:join(__dirname,"preload.js"),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,devTools:!app.isPackaged}});
  win.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith("https://")) void shell.openExternal(url);return {action:"deny"};});
  win.webContents.on("will-navigate",(event,url)=>{if(url!==win?.webContents.getURL()) event.preventDefault();});
  void win.loadFile(join(__dirname,"renderer","index.html"));
  win.on("closed",()=>{vault.lock();win=null;});
}
app.whenReady().then(()=>{vault=new VaultStore(join(dataDir(),"vault.scv"));registerIpc();createWindow();app.on("activate",()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on("before-quit",()=>vault?.lock());
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit();});
