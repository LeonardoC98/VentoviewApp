// Verstecktes Fenster für Live-Audio-Eingänge: Befehle von der App, Tonpakete zurück
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vvAudio', {
  push: (id, buffer) => ipcRenderer.send('liveaudio:pcm', id, buffer),
  reply: (reqId, ok, result) => ipcRenderer.send('liveaudio:reply', reqId, ok, result),
  ended: (id) => ipcRenderer.send('liveaudio:ended', id),
  onCommand: (fn) => ipcRenderer.on('liveaudio:cmd', (_event, cmd) => fn(cmd)),
});
