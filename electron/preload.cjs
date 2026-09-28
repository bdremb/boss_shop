const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bossShop', {
  invoke: (action, payload = {}) => ipcRenderer.invoke('boss-shop:api', { action, payload }),
  exportFile: (format, title, rows) => ipcRenderer.invoke('boss-shop:export', { format, title, rows })
})
