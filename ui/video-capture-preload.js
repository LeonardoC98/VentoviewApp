// Verstecktes Fenster für Live-Video: Befehle von der App, Antworten und WebRTC-Angebote zurück
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vvVideo', {
  send: (msg) => ipcRenderer.send('livevideo:msg', msg),
  onCommand: (fn) => ipcRenderer.on('livevideo:cmd', (_event, cmd) => fn(cmd)),
});
