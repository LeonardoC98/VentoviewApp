const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screensTest', {
  displays: () => ipcRenderer.invoke('displays'),
  desktopInfo: () => ipcRenderer.invoke('desktop-info'),
  show: (id, mode, content) => ipcRenderer.invoke('show', id, mode, content),
  hide: (id) => ipcRenderer.invoke('hide', id),
  onDisplays: (cb) => ipcRenderer.on('displays', (_e, list) => cb(list)),
});
