// Live-Video: Kameras (auch Capture-Karten und virtuelle Kameras), Bildschirme und Fenster – aufgenommen hier in der
// App (verstecktes Fenster ui/video-capture.html) und per WebRTC an die Overlays geschickt. So zeigt die
// Browserquelle der Streaming-Software das Bild, ohne selbst auf die Kamera zugreifen zu dürfen.
//
// Quellen (layer.live einer Video-Ebene):
//   cam:default        erste Kamera von Windows
//   cam:<deviceId>     bestimmte Kamera / Capture-Karte
//   screen:<n>         Bildschirm n (0 = erster)
//   win:<name>         Fenster eines Programms – über den Namen, weil sich die Fenster-ID bei jedem Start ändert
// Ablauf: Overlay öffnet WebSocket /video?src=…&q=1080&fps=30 → App lässt das Fenster ein Angebot (SDP) machen →
// Overlay antwortet → Bild läuft direkt zwischen Fenster und Overlay. Aufgenommen wird nur, solange jemand zuschaut.
'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BrowserWindow, desktopCapturer, ipcMain, screen, session } = require('electron');

const SOURCE = /^(cam:[\w\-=+/.]{1,200}|screen:\d{1,2}|win:.{1,120})$/;
const QUALITY = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };

class LiveVideo extends EventEmitter {
  constructor() {
    super();
    this.win = null;
    this.winReady = null;
    this.viewers = new Map(); // peerId → { ws, key, src }
    this.waiting = new Map(); // reqId → { resolve, reject, timer }
    this.stats = new Map();   // key → { src, motion, width, height, fps, at }
    this.seq = 0;
    ipcMain.on('livevideo:msg', (event, msg) => {
      if (event.sender !== this.win?.webContents || !msg) return;
      if (msg.type === 'reply') {
        const w = this.waiting.get(msg.reqId);
        if (!w) return;
        this.waiting.delete(msg.reqId);
        clearTimeout(w.timer);
        if (msg.ok) w.resolve(msg.result);
        else w.reject(new Error(msg.result));
      } else if (msg.type === 'display-want') {
        this.displayWanted = String(msg.id || '');
        this.win.webContents.send('livevideo:cmd', { type: 'ack', reqId: msg.reqId });
      } else if (msg.type === 'offer') {
        this.toViewer(msg.peerId, { type: 'offer', sdp: msg.sdp });
      } else if (msg.type === 'error' || msg.type === 'gone') {
        const viewer = this.viewers.get(msg.peerId);
        if (!viewer) return;
        if (msg.message) this.toViewer(msg.peerId, { type: 'error', message: msg.message });
        viewer.ws.close(1011, 'Quelle weg');
      } else if (msg.type === 'stats') {
        if (msg.running) this.stats.set(msg.key, { src: msg.src, motion: msg.motion, width: msg.width, height: msg.height, fps: msg.fps, at: Date.now() });
        else this.stats.delete(msg.key);
        this.emit('stats', this.statsList());
      }
    });
  }

  // Verstecktes Fenster – eigene Sitzung, die nur Kamera-Zugriff bekommt
  window() {
    if (this.winReady) return this.winReady;
    const ses = session.fromPartition('persist:vv-livevideo');
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'));
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
    // Bildschirm/Fenster über getDisplayMedia: ohne Auswahlfenster die Quelle, die das Fenster vorher genannt hat
    ses.setDisplayMediaRequestHandler?.((_request, callback) => {
      const id = this.displayWanted;
      this.displayWanted = null;
      desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((list) => {
          const src = list.find((s) => s.id === id);
          callback(src ? { video: src } : {});
        })
        .catch(() => callback({}));
    });
    this.win = new BrowserWindow({
      show: false,
      webPreferences: { session: ses, preload: path.join(__dirname, '..', 'ui', 'video-capture-preload.js'), contextIsolation: true, backgroundThrottling: false },
    });
    this.win.on('closed', () => {
      this.win = null;
      this.winReady = null;
      for (const viewer of this.viewers.values()) viewer.ws.close(1011, 'Aufnahme beendet');
    });
    this.winReady = this.win.loadFile(path.join(__dirname, '..', 'ui', 'video-capture.html')).then(() => this.win);
    return this.winReady;
  }

  async command(cmd) {
    const win = await this.window();
    win.webContents.send('livevideo:cmd', cmd);
  }

  async request(cmd, timeout = 10000) {
    const win = await this.window();
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error('Keine Antwort von der Video-Aufnahme'));
      }, timeout);
      this.waiting.set(reqId, { resolve, reject, timer });
      win.webContents.send('livevideo:cmd', { ...cmd, reqId });
    });
  }

  toViewer(peerId, msg) {
    const ws = this.viewers.get(peerId)?.ws;
    if (ws?.readyState === ws?.OPEN) ws.send(JSON.stringify(msg));
  }

  // Alle Quellen zum Auswählen → [{ id, label, kind: 'camera' | 'screen' | 'window' }]
  async list() {
    const [cams, desktop] = await Promise.all([
      this.request({ type: 'list' }).catch(() => []),
      desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }).catch(() => []),
    ]);
    const displays = screen.getAllDisplays();
    const screens = desktop.filter((s) => s.id.startsWith('screen:'));
    const windows = desktop.filter((s) => s.id.startsWith('window:') && s.name && !/^Ventoview/.test(s.name));
    return [
      { id: 'cam:default', label: 'Standard-Kamera', kind: 'camera' },
      ...cams.filter((c) => c.deviceId && c.deviceId !== 'default').map((c) => ({ id: `cam:${c.deviceId}`, label: c.label || 'Kamera', kind: 'camera' })),
      ...screens.map((s, i) => {
        const d = displays[i];
        return { id: `screen:${i}`, label: `Bildschirm ${i + 1}${d ? ` (${Math.round(d.size.width * d.scaleFactor)} × ${Math.round(d.size.height * d.scaleFactor)})` : ''}`, kind: 'screen' };
      }),
      ...[...new Set(windows.map((w) => w.name))].slice(0, 60).map((name) => ({ id: `win:${name}`, label: name, kind: 'window' })),
    ];
  }

  // Welche Quelle das Fenster aufnehmen soll
  async resolve(src) {
    if (src.startsWith('cam:')) return { kind: 'camera', deviceId: src.slice(4) };
    const desktop = await desktopCapturer.getSources({ types: [src.startsWith('screen:') ? 'screen' : 'window'], thumbnailSize: { width: 0, height: 0 } });
    if (src.startsWith('screen:')) {
      const found = desktop.filter((s) => s.id.startsWith('screen:'))[Number(src.slice(7))];
      if (!found) throw new Error('Bildschirm nicht gefunden.');
      return { kind: 'screen', desktopId: found.id };
    }
    const name = src.slice(4);
    // Gleicher Name, sonst ein Fenster, dessen Titel ihn enthält (z. B. wechselnde Titel im Browser)
    const found = desktop.find((s) => s.name === name) || desktop.find((s) => s.name.toLowerCase().includes(name.toLowerCase()));
    if (!found) throw new Error(`Fenster „${name}“ ist gerade nicht offen.`);
    return { kind: 'window', desktopId: found.id };
  }

  // Ein Overlay will eine Quelle sehen (WebSocket /video?src=…)
  async attach(ws, src, params = {}) {
    if (!SOURCE.test(String(src))) {
      ws.close(1008, 'Unbekannte Quelle');
      return;
    }
    const height = QUALITY[params.q] ? Number(params.q) : 1080;
    const [width] = QUALITY[height];
    const fps = Number(params.fps) === 60 ? 60 : 30;
    const peerId = ++this.seq;
    const key = `${src}|${height}|${fps}`;
    this.viewers.set(peerId, { ws, key, src });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'answer' && typeof msg.sdp === 'string') this.command({ type: 'answer', peerId, sdp: msg.sdp });
    });
    ws.on('close', () => {
      this.viewers.delete(peerId);
      this.command({ type: 'close', peerId }).catch(() => {});
    });
    try {
      const source = await this.resolve(src);
      if (!this.viewers.has(peerId)) return; // schon wieder weg
      await this.command({ type: 'peer', peerId, key, src, source, quality: { width, height, fps } });
    } catch (err) {
      this.toViewer(peerId, { type: 'error', message: err.message });
      ws.close(1011, 'Quelle nicht verfügbar');
    }
  }

  statsList() {
    const now = Date.now();
    return [...this.stats.values()].filter((s) => now - s.at < 3000);
  }

  // Foto einer laufenden Quelle (src leer = die erste laufende Kamera) → JPEG als Buffer
  async snapshot(src = '') {
    const running = [...this.stats.entries()].filter(([, s]) => Date.now() - s.at < 3000);
    const pick = running.find(([, s]) => s.src === src) || (!src || src.startsWith('cam:') ? running.find(([, s]) => s.src.startsWith('cam:')) : null) || (!src ? running[0] : null);
    if (!pick) throw new Error('Keine laufende Kamera – erst eine Live-Video-Ebene im Overlay zeigen.');
    const url = await this.request({ type: 'snapshot', key: pick[0] });
    return Buffer.from(String(url).split(',')[1] || '', 'base64');
  }

  close() {
    for (const viewer of this.viewers.values()) viewer.ws.terminate?.();
    this.viewers.clear();
    this.win?.destroy();
  }
}

module.exports = { LiveVideo };
