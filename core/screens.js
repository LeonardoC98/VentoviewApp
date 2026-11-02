// Bildschirme (Modul „Bildschirme“): erkennt alle Bildschirme und zeigt auf jedem einen Stapel von Designs aus dem
// Editor – „über allem“ (über allen Fenstern) oder „als Hintergrund“ (hinter den Desktop-Symbolen wie ein
// Hintergrundbild, auch zusammen mit Wallpaper Engine). Was im Stapel weiter oben liegt, verdeckt das darunter;
// „über allem“ liegt immer über „als Hintergrund“. Klicks gehen immer durch, der Ton bleibt aus.
// Je Bildschirm und Art ein durchsichtiges Fenster, darin die Designs übereinander (ui/screen-stack.html).
// Was wo läuft, merkt sich die App (Einstellung „screens“) und zeigt es nach einem Neustart, nach einem Neustart des
// Windows-Explorers oder beim Wieder-Anstecken des Bildschirms von selbst wieder.
'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MODES = ['behind', 'top'];
const RETRY_MS = 30_000; // Webseite nicht erreichbar: so lange warten, dann erneut versuchen
const STACK_PAGE = path.join(__dirname, '..', 'ui', 'screen-stack.html');

class Screens extends EventEmitter {
  constructor({ BrowserWindow, screen, app, config, overlayUrl }) {
    super();
    Object.assign(this, { BrowserWindow, screen, app, config, overlayUrl });
    this.windows = new Map(); // `${Bildschirm}|${Art}` → { win, key, mode, urls, bounds, closing, error }
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

  // Gemerkt je Bildschirm: { items: [{ design, mode, site }] } – von unten nach oben
  items(key) {
    const stored = (this.config.get('screens') || {})[key];
    if (!stored) return [];
    if (Array.isArray(stored.items)) return stored.items.filter((i) => i?.design && MODES.includes(i.mode));
    return stored.design ? [{ design: stored.design, mode: stored.mode, site: stored.site || null }] : []; // frühere Form: ein Design
  }

  setItems(key, items) {
    const all = { ...(this.config.get('screens') || {}) };
    if (items.length) all[key] = { items };
    else delete all[key];
    this.config.set({ screens: all });
  }

  // Für den Editor: Bildschirme mit ihrem Stapel (von unten nach oben) und ggf. einem Hinweis je Art
  list() {
    return this.displays().map(({ display, ...d }) => ({
      ...d,
      items: this.items(d.key).map(({ design, mode }) => ({ design, mode })),
      errors: Object.fromEntries(MODES.map((mode) => [mode, this.windows.get(`${d.key}|${mode}`)?.error || null]).filter(([, e]) => e)),
    }));
  }

  // Design oben auf den Stapel legen (liegt es schon dort, wandert es nach oben und bekommt die neue Art).
  // site: Adresse der Webseite, deren Editor „Anzeigen“ geklickt hat – das Overlay kommt von dort
  async show({ screen: key, design, mode = 'behind', site = null } = {}) {
    if (!MODES.includes(mode)) throw new Error('Unbekannte Anzeige-Art.');
    if (!design) throw new Error('Erst das Design speichern.');
    const target = this.displays().find((d) => d.key === key);
    if (!target) throw new Error('Diesen Bildschirm gibt es gerade nicht.');
    const items = this.items(key).filter((i) => i.design !== String(design));
    items.push({ design: String(design), mode, site: typeof site === 'string' ? site : null });
    this.setItems(key, items);
    await this.sync(target);
    this.changed();
    return this.list();
  }

  // Ein Design vom Stapel nehmen
  async remove({ screen: key, design } = {}) {
    this.setItems(key, this.items(key).filter((i) => i.design !== design));
    const target = this.displays().find((d) => d.key === key);
    if (target) await this.sync(target);
    else this.closeScreen(key);
    this.changed();
    return this.list();
  }

  // Eine Stufe nach oben (+1) oder unten (-1) – nur innerhalb derselben Art
  async move({ screen: key, design, step = 1 } = {}) {
    const items = this.items(key);
    const i = items.findIndex((x) => x.design === design);
    if (i < 0) return this.list();
    const same = items.map((x, n) => n).filter((n) => items[n].mode === items[i].mode);
    const j = same[same.indexOf(i) + (step > 0 ? 1 : -1)];
    if (j === undefined) return this.list();
    [items[i], items[j]] = [items[j], items[i]];
    this.setItems(key, items);
    const target = this.displays().find((d) => d.key === key);
    if (target) await this.sync(target);
    this.changed();
    return this.list();
  }

  // Ganzen Bildschirm leeren
  hide({ screen: key } = {}) {
    this.closeScreen(key);
    this.setItems(key, []);
    this.changed();
    return this.list();
  }

  // Notbremse (Tray): alles aus und vergessen
  hideAll() {
    for (const id of [...this.windows.keys()]) this.close(id);
    this.config.set({ screens: {} });
    this.changed();
  }

  // Design gelöscht: von allen Stapeln nehmen
  forget(design) {
    const all = this.config.get('screens') || {};
    const keys = Object.keys(all).filter((key) => this.items(key).some((i) => i.design === design));
    if (!keys.length) return;
    for (const key of keys) this.setItems(key, this.items(key).filter((i) => i.design !== design));
    this.restore();
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
    const present = this.displays();
    for (const [id, entry] of [...this.windows]) {
      const d = present.find((x) => x.key === entry.key);
      if (!d || JSON.stringify(d.display.bounds) !== JSON.stringify(entry.bounds)) this.close(id);
    }
    for (const d of present) await this.sync(d).catch(() => {});
    this.changed();
  }

  // Fenster eines Bildschirms an den Stapel anpassen: je Art eins, darin die Designs von unten nach oben
  async sync(target) {
    const items = this.items(target.key);
    for (const mode of MODES) {
      const id = `${target.key}|${mode}`;
      const urls = items.filter((i) => i.mode === mode).map((i) => this.overlayUrl(i.design, i.site));
      const open = this.windows.get(id);
      if (!urls.length) {
        this.close(id);
        continue;
      }
      if (open && JSON.stringify(open.urls) === JSON.stringify(urls)) continue;
      if (open) {
        // Fenster bleibt (und damit sein Platz hinter den Desktop-Symbolen) – nur die Designs darin neu laden
        open.urls = urls;
        await open.win.loadURL(stackUrl(urls)).catch(() => {});
        continue;
      }
      await this.open(target, mode, urls);
    }
  }

  closeScreen(key) {
    for (const mode of MODES) this.close(`${key}|${mode}`);
  }

  close(id) {
    const entry = this.windows.get(id);
    if (!entry) return;
    entry.closing = true;
    this.windows.delete(id);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  async open(target, mode, urls) {
    const id = `${target.key}|${mode}`;
    this.close(id);
    const win = new this.BrowserWindow({
      ...target.display.bounds, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, show: false, title: 'Ventoview',
      webPreferences: { backgroundThrottling: false },
    });
    win.setIgnoreMouseEvents(true);
    win.webContents.setAudioMuted(true); // Töne laufen im Stream, nicht zusätzlich auf dem Desktop
    const entry = { win, key: target.key, mode, urls, bounds: target.display.bounds, closing: false, error: null };
    this.windows.set(id, entry);
    win.on('closed', () => {
      if (this.windows.get(id) === entry) this.windows.delete(id);
      // Nicht von uns geschlossen (z. B. der Explorer wurde neu gestartet und hat die Hintergrund-Ebene mitgenommen)
      if (!entry.closing) setTimeout(() => this.restore(), 3000);
    });
    try {
      await win.loadURL(stackUrl(urls));
    } catch {
      this.close(id);
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
    for (const entry of this.windows.values()) {
      entry.closing = true;
      if (!entry.win.isDestroyed()) entry.win.destroy();
    }
    this.windows.clear();
    this.helper?.kill();
  }
}

// Seite mit den Designs übereinander (je Design ein Overlay-Rahmen, das letzte liegt oben)
function stackUrl(urls) {
  const url = new URL(`file:///${STACK_PAGE.replace(/\\/g, '/')}`);
  for (const u of urls) url.searchParams.append('u', u);
  return url.href;
}

module.exports = { Screens };
