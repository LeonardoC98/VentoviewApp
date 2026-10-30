// Brücke für das unsichtbare Export-Fenster: Bilder und Ton von der App empfangen, Ergebnis zurückschicken
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vvIpc', {
  on: (channel, fn) => ipcRenderer.on(channel, (_event, data) => fn(data)),
  send: (channel, data) => ipcRenderer.send(channel, data),
});
