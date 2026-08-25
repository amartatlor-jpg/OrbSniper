const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sniper", {
  start: () => ipcRenderer.invoke("sniper:start"),
  stop: () => ipcRenderer.invoke("sniper:stop"),
  skip: () => ipcRenderer.invoke("sniper:skip"),
  copyText: (text) => ipcRenderer.invoke("app:copy", text),
  openExternal: (url) => ipcRenderer.invoke("app:open", url),
  getVersion: () => ipcRenderer.invoke("app:version"),
  minimize: () => ipcRenderer.invoke("win:minimize"),
  close: () => ipcRenderer.invoke("win:close"),
  onLog: (cb) => ipcRenderer.on("sniper:log", (_, m) => cb(m)),
  onSay: (cb) => ipcRenderer.on("sniper:say", (_, m) => cb(m)),
  onStatus: (cb) => ipcRenderer.on("sniper:status", (_, m) => cb(m)),
  onTally: (cb) => ipcRenderer.on("sniper:tally", (_, m) => cb(m)),
  onPhase: (cb) => ipcRenderer.on("sniper:phase", (_, m) => cb(m)),
  onDone: (cb) => ipcRenderer.on("sniper:done", (_, m) => cb(m)),
  onRunning: (cb) => ipcRenderer.on("sniper:running", (_, m) => cb(m))
});
