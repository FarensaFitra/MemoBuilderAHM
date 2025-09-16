// preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // simpan PDF (sudah ada)
  savePDF: (args) => ipcRenderer.invoke("save-pdf", args),

  // aksi sensitif: wajib password
  enableAllNomorSecure: (password) => ipcRenderer.invoke("enable-all-nomor", { password }),
  // deleteLogsSecure({ password, scope: "all" | "month", ym?: "YYYY-MM" })
  deleteLogsSecure: (args) => ipcRenderer.invoke("delete-logs", args),
});
