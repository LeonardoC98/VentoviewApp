// Bildschirme (Modul „Bildschirme“): erkennt alle Bildschirme und zeigt auf jedem ein Design aus dem Editor –
// „über allem“ (über allen Fenstern) oder „als Hintergrund“ (hinter den Desktop-Symbolen wie ein Hintergrundbild,
// auch zusammen mit Wallpaper Engine). Klicks gehen immer durch, der Ton bleibt aus.
// Was wo läuft, merkt sich die App (Einstellung „screens“) und zeigt es nach einem Neustart, nach einem Neustart des
// Windows-Explorers oder beim Wieder-Anstecken des Bildschirms von selbst wieder.
'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MODES = ['behind', 'top'];
const RETRY_MS = 30_000; // Webseite nicht erreichbar: so lange warten, dann erneut versuchen

class Screens extends EventEmitter {
  constructor({ BrowserWindow, screen, app, config, overlayUrl }) {
    super();
    Object.assign(this, { BrowserWindow, screen, app, config, overlayUrl });
    this.windows = new Map(); // Schlüssel des Bildschirms → { win, design, mode, bounds, closing, error }
    this.helper = null;
    this.waiting = [];
    this.retryTimer = null;
    this.restoreTimer = null;
  }

  // Von links nach rechts, mit echten Pixeln (die Windows-Skalierung herausgerechnet). Der Schlüssel ist der Name des
  // Bildschirms – der bleibt auch nach einem Neustart gleich; zwei gleiche Modelle bekommen „#2“ dazu.
  displays() {
    const primary = this.screen.getPrimaryDisplay().id;
    const seen = {};
    return this.screen.getAllDisplays()
      .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
      .map((display, i) => {
        const px = this.screen.dipToScreenRect(null, display.bounds);
        const label = display.label || `Bildschirm ${i + 1}`;
        seen[label] = (seen[label] || 0) + 1;
        return {
          display, key: seen[label] > 1 ? `${label} #${seen[label]}` : label, nr: i + 1, label,
          width: px.width, height: px.height, x: px.x, y: px.y, scale: display.scaleFactor,
          hz: Math.round(display.displayFrequency || 0) || null, primary: display.id === primary,
        };
      });
  }

  list() {
    const assigned = this.config.get('screens') || {};
    return this.displays().map(({ display, ...d }) => {
      const a = assigned[d.key];
      const open = this.windows.get(d.key);
      return { ...d, showing: a ? { design: a.design, mode: a.mode, error: open?.error || null } : null };
    });
  }

  // site: Adresse der Webseite, deren Editor „Anzeigen“ geklickt hat – das Overlay kommt von dort
  async show({ screen: key, design, mode = 'behind', site = null } = {}) {
    if (!MODES.includes(mode)) throw new Error('Unbekannte Anzeige-Art.');
    if (!design) throw new Error('Erst das Design speichern.');
    const target = this.displays().find((d) => d.key === key);
    if (!target) throw new Error('Diesen Bildschirm gibt es gerade nicht.');
    const entry = { design: String(design), mode, site: typeof site === 'string' ? site : null };
    this.remember(key, entry);
    await this.open(target, entry);
    this.changed();
    return this.list();
  }

  hide({ screen: key } = {}) {
    this.close(key);
    this.remember(key, null);
    this.changed();
    return this.list();
  }

  // Notbremse (Tray): alles aus und vergessen
  hideAll() {
    for (const key of [...this.windows.keys()]) this.close(key);
    this.config.set({ screens: {} });
    this.changed();
  }

  // Design gelöscht: nirgends mehr anzeigen
  forget(design) {
    const assigned = this.config.get('screens') || {};
    const keys = Object.keys(assigned).filter((key) => assigned[key].design === design);
    if (!keys.length) return;
    for (const key of keys) {
      this.close(key);
      this.remember(key, null);
    }
    this.changed();
  }

  // Bildschirme an- oder abgesteckt, Auflösung oder Skalierung geändert: neu einrichten
  watch() {
    const later = () => {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = setTimeout(() => this.restore(), 800);
    };
    this.screen.on('display-added', later).on('display-removed', later).on('display-metrics-changed', later);
  }

  // Alles Gemerkte anzeigen, was nicht mehr passt schließen
  async restore() {
    clearTimeout(this.retryTimer);
    const assigned = this.config.get('screens') || {};
    const present = this.displays();
    for (const key of [...this.windows.keys()]) {
      const d = present.find((x) => x.key === key);
      const open = this.windows.get(key);
      if (!d || !assigned[key] || JSON.stringify(d.display.bounds) !== JSON.stringify(open.bounds)) this.close(key);
    }
    for (const d of present) {
      const a = assigned[d.key];
      const open = this.windows.get(d.key);
      if (a && (!open || open.design !== a.design || open.mode !== a.mode || open.site !== (a.site || null))) await this.open(d, a).catch(() => {});
    }
    this.changed();
  }

  remember(key, value) {
    const all = { ...(this.config.get('screens') || {}) };
    if (value) all[key] = value;
    else delete all[key];
    this.config.set({ screens: all });
  }

  close(key) {
    const entry = this.windows.get(key);
    if (!entry) return;
    entry.closing = true;
    this.windows.delete(key);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  async open(target, { design, mode, site = null }) {
    this.close(target.key);
    const win = new this.BrowserWindow({
      ...target.display.bounds, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, show: false, title: 'Ventoview',
      webPreferences: { backgroundThrottling: false },
    });
    win.setIgnoreMouseEvents(true);
    win.webContents.setAudioMuted(true); // Töne laufen im Stream, nicht zusätzlich auf dem Desktop
    const entry = { win, design, mode, site, bounds: target.display.bounds, closing: false, error: null };
    this.windows.set(target.key, entry);
    win.on('closed', () => {
      if (this.windows.get(target.key) === entry) this.windows.delete(target.key);
      // Nicht von uns geschlossen (z. B. der Explorer wurde neu gestartet und hat die Hintergrund-Ebene mitgenommen)
      if (!entry.closing) setTimeout(() => this.restore(), 3000);
    });
    try {
      await win.loadURL(this.overlayUrl(design, site));
    } catch {
      // Webseite gerade nicht erreichbar – lieber nichts zeigen als eine Fehlerseite auf dem Desktop
      this.close(target.key);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.restore(), RETRY_MS);
      return;
    }
    if (win.isDestroyed()) return;
    win.setBounds(target.display.bounds);
    win.showInactive();
    if (mode === 'top') {
      win.setAlwaysOnTop(true, 'screen-saver');
      return;
    }
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
    const answer = await this.ask(`behind ${hwnd} ${target.x} ${target.y} ${target.width} ${target.height}`);
    if (!answer.startsWith('ok')) {
      // Hintergrund-Ebene nicht gefunden: dann wenigstens über allem zeigen
      entry.error = 'Als Hintergrund ging hier nicht – wird über allem gezeigt.';
      if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
    }
  }

  changed() {
    this.emit('change', this.list());
  }

  // ---------- Windows-Helfer (PowerShell, läuft, solange etwas als Hintergrund gezeigt wird) ----------

  ask(command) {
    return new Promise((resolve) => {
      const helper = this.startHelper();
      if (!helper) return resolve('err nohelper');
      this.waiting.push(resolve);
      helper.stdin.write(`${command}\n`);
    });
  }

  startHelper() {
    if (this.helper) return this.helper;
    try {
      // Das Skript liegt im App-Archiv – PowerShell kann dort nicht lesen, also einmal danebenlegen
      const file = path.join(this.app.getPath('userData'), 'desktop-layer.ps1');
      const text = fs.readFileSync(path.join(__dirname, 'desktop-layer.ps1'), 'utf8');
      let old = '';
      try { old = fs.readFileSync(file, 'utf8'); } catch { /* noch nicht da */ }
      if (old !== text) fs.writeFileSync(file, text, 'utf8');
      const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
      let buffer = '';
      helper.stdout.setEncoding('utf8');
      helper.stdout.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (line && line !== 'ready') this.waiting.shift()?.(line);
        }
      });
      helper.on('exit', () => {
        if (this.helper === helper) this.helper = null;
        for (const resolve of this.waiting.splice(0)) resolve('err exit');
      });
      helper.on('error', () => {});
      this.helper = helper;
      return helper;
    } catch {
      return null;
    }
  }

  stop() {
    for (const key of [...this.windows.keys()]) {
      const entry = this.windows.get(key);
      entry.closing = true;
      if (!entry.win.isDestroyed()) entry.win.destroy();
    }
    this.windows.clear();
    this.helper?.kill();
  }
}

module.exports = { Screens };
