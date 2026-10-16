const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('bossShop', {
  invoke: (action, payload = {}) => ipcRenderer.invoke('boss-shop:api', { action, payload }),
  exportFile: (format, title, rows) => ipcRenderer.invoke('boss-shop:export', { format, title, rows }),
  backupDatabase: token => ipcRenderer.invoke('boss-shop:backup', { token }),
  restoreDatabase: token => ipcRenderer.invoke('boss-shop:restore', { token }),
  selectProductImport: token => ipcRenderer.invoke('boss-shop:import-select', { token }),
  selectProductPhoto: token => ipcRenderer.invoke('boss-shop:photo-select', { token }),
  commitProductImport: (token, importId, options) => ipcRenderer.invoke('boss-shop:import-commit', { token, importId, ...options }),
  setFontScale: factor => webFrame.setZoomFactor(Math.min(1.3, Math.max(0.9, Number(factor) || 1)))
})
