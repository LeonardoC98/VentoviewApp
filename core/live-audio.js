// Live-Audio: Mikrofon und andere Eingänge, der Ton des ganzen PCs oder einer einzelnen App – aufgenommen hier in der
// App und roh (48 kHz, Stereo, 16 Bit) an Overlays geschickt (WebSocket /audio?src=…). So holt sich die
// Streaming-Software den Ton aus der Browserquelle, statt das Gerät selbst einzubinden.
//
// Quellen:
//   mic:<Windows-ID> Eingang (Mikrofon, Line-In, virtuelles Kabel …), mic:default = Standard-Mikrofon von Windows
//   sys              alles, was der PC abspielt (Loopback des Standard-Wiedergabegeräts)
//   app:<prozess>    nur ein Programm, z. B. app:spotify (Process Loopback, ab Windows 10 2004)
//   in:<Geräte-ID>   ältere Eingänge über ein verstecktes Fenster (Chromium); in:default läuft wie mic:default
// mic, sys und app laufen über audio-capture.ps1 – direkt über Windows, im Takt des Geräts, mit wenig Verzögerung.
// Aufgenommen wird nur, solange ein Overlay zuhört.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const MAX_BUFFERED = 256 * 1024; // hängt ein Overlay hinterher, lieber Pakete auslassen als Verzögerung aufbauen
const IDLE_MS = 3000;            // ohne Zuhörer noch kurz weiterlaufen (Overlay lädt neu)
const RETRY_MS = 3000;           // Gerät/Programm nicht da: so oft neu versuchen
const SOURCE = /^(in:[\w\-=+/.]{1,200}|mic:[\w{}.\-]{1,160}|sys|app:[\w .\-]{1,80})$/;

class LiveAudio {
  constructor() {
    this.sources = new Map(); // id → { id, listeners: Set<ws>, stop, idle, retry }
    this.win = null;
    this.winReady = null;
    this.waiting = new Map(); // reqId → { resolve, reject, timer }
    this.seq = 0;
    this.script = null;
    ipcMain.on('liveaudio:pcm', (event, id, data) => {
      if (event.sender === this.win?.webContents) this.push(id, Buffer.from(data));
    });
    ipcMain.on('liveaudio:reply', (event, reqId, ok, result) => {
      if (event.sender !== this.win?.webContents) return;
      const w = this.waiting.get(reqId);
      if (!w) return;
      this.waiting.delete(reqId);
      clearTimeout(w.timer);
      if (ok) w.resolve(result);
      else w.reject(new Error(result));
    });
    ipcMain.on('liveaudio:ended', (event, id) => {
      if (event.sender !== this.win?.webContents) return;
      const src = this.sources.get(id);
      if (src) this.restartLater(src); // Gerät abgezogen o. ä.
    });
  }

  // Das PowerShell-Skript liegt im App-Archiv – PowerShell kann dort nicht lesen, also einmal danebenlegen
  helper() {
    if (this.script) return this.script;
    const file = path.join(app.getPath('userData'), 'audio-capture.ps1');
    const text = fs.readFileSync(path.join(__dirname, 'audio-capture.ps1'), 'utf8');
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch { /* noch nicht da */ }
    if (old !== text) fs.writeFileSync(file, text, 'utf8');
    this.script = file;
    return file;
  }

  run(args) {
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helper(), ...args], { windowsHide: true });
  }

  // Verstecktes Fenster für die Eingänge – eigene Sitzung, die nur Mikrofon-Zugriff bekommt
  window() {
    if (this.winReady) return this.winReady;
    const ses = session.fromPartition('persist:vv-liveaudio');
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'));
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
    this.win = new BrowserWindow({
      show: false,
      webPreferences: { session: ses, preload: path.join(__dirname, '..', 'ui', 'audio-capture-preload.js'), contextIsolation: true, backgroundThrottling: false },
    });
    this.win.on('closed', () => {
      this.win = null;
      this.winReady = null;
    });
    this.winReady = this.win.loadFile(path.join(__dirname, '..', 'ui', 'audio-capture.html')).then(() => this.win);
    return this.winReady;
  }

  async request(cmd) {
    const win = await this.window();
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error('Keine Antwort von der Audio-Aufnahme'));
      }, 10000);
      this.waiting.set(reqId, { resolve, reject, timer });
      win.webContents.send('liveaudio:cmd', { ...cmd, reqId });
    });
  }

  // Programme, die gerade Ton ausgeben können → [{ name, title }]; mode 'inputs': Eingänge → [{ id, name }]
  apps(mode = 'list') {
    return new Promise((resolve) => {
      const child = this.run(['-Mode', mode]);
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', () => resolve([]));
      child.on('close', () => {
        try { resolve(JSON.parse(out)); } catch { resolve([]); }
      });
    });
  }

  // Alle Quellen zum Auswählen → [{ id, label, kind: 'input' | 'system' | 'app' }]
  async list() {
    const [inputs, apps] = await Promise.all([this.apps('inputs'), this.apps()]);
    // Ohne Windows-Liste (sollte nicht vorkommen) wie früher über das versteckte Fenster
    const legacy = inputs.length ? [] : await this.request({ type: 'list' }).catch(() => []);
    return [
      { id: 'mic:default', label: 'Standard-Mikrofon (wie in Windows eingestellt)', kind: 'input' },
      ...inputs.map((d) => ({ id: `mic:${d.id}`, label: d.name || 'Eingang', kind: 'input' })),
      ...legacy.filter((d) => !['default', 'communications'].includes(d.deviceId)).map((d) => ({ id: `in:${d.deviceId}`, label: d.label || 'Eingang', kind: 'input' })),
      { id: 'sys', label: 'Systemsound – alles, was der PC abspielt', kind: 'system' },
      ...apps.map((a) => ({ id: `app:${a.name}`, label: a.title || a.name, kind: 'app' })),
    ];
  }

  // Ein Overlay hört zu (WebSocket /audio?src=…)
  attach(ws, id) {
    if (!SOURCE.test(String(id))) {
      ws.close(1008, 'Unbekannte Quelle');
      return;
    }
    let src = this.sources.get(id);
    if (!src) {
      src = { id, listeners: new Set(), stop: null, idle: null, retry: null };
      this.sources.set(id, src);
      this.start(src);
    }
    clearTimeout(src.idle);
    src.listeners.add(ws);
    ws.on('close', () => {
      src.listeners.delete(ws);
      if (!src.listeners.size) src.idle = setTimeout(() => this.end(src), IDLE_MS);
    });
  }

  push(id, data) {
    const src = this.sources.get(id);
    if (!src) return;
    for (const ws of src.listeners) {
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFERED) ws.send(data, { binary: true });
    }
  }

  start(src) {
    if (src.id.startsWith('in:') && src.id !== 'in:default') {
      const deviceId = src.id.slice(3);
      src.stop = () => this.win?.webContents.send('liveaudio:cmd', { type: 'stop', id: src.id });
      this.request({ type: 'start', id: src.id, deviceId }).catch((err) => {
        console.warn('Live-Audio:', src.id, err.message);
        this.restartLater(src);
      });
      return;
    }
    const args = src.id === 'sys' ? ['-Mode', 'sys']
      : src.id === 'in:default' ? ['-Mode', 'mic', '-Name', 'default']
        : src.id.startsWith('mic:') ? ['-Mode', 'mic', '-Name', src.id.slice(4)]
          : ['-Mode', 'app', '-Name', src.id.slice(4)];
    const child = this.run(args);
    let rest = Buffer.alloc(0);
    // Pakete können mitten in einem Sample enden – immer ganze Stereo-Samples (4 Byte) weitergeben
    child.stdout.on('data', (chunk) => {
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const whole = data.length - (data.length % 4);
      rest = data.subarray(whole);
      if (whole) this.push(src.id, data.subarray(0, whole));
    });
    child.stderr.on('data', (chunk) => console.warn('Live-Audio:', src.id, String(chunk).trim()));
    child.on('error', () => {});
    child.on('close', () => {
      if (src.child === child) this.restartLater(src);
    });
    src.child = child;
    src.stop = () => {
      src.child = null;
      child.kill();
    };
  }

  restartLater(src) {
    if (this.sources.get(src.id) !== src) return;
    clearTimeout(src.retry);
    src.retry = setTimeout(() => {
      if (this.sources.get(src.id) === src && src.listeners.size) {
        src.stop?.();
        this.start(src);
      }
    }, RETRY_MS);
  }

  end(src) {
    if (src.listeners.size) return;
    clearTimeout(src.retry);
    src.stop?.();
    this.sources.delete(src.id);
  }

  close() {
    for (const src of this.sources.values()) {
      clearTimeout(src.retry);
      clearTimeout(src.idle);
      src.stop?.();
    }
    this.sources.clear();
    this.win?.destroy();
  }
}

module.exports = { LiveAudio };
