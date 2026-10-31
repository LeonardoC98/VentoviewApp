const { EventEmitter } = require('node:events');
const { autoUpdater } = require('electron-updater');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Updates über GitHub Releases (Ziel: package.json → build.publish).
 * Die App prüft nur, ob es eine neue Version gibt – geladen und installiert wird erst, wenn man auf
 * „Update installieren“ klickt (per SHA-512 geprüft). Nichts passiert von selbst beim Beenden.
 * Status: disabled | idle | checking | latest | available | downloading | ready | error
 */
class Updater extends EventEmitter {
  constructor({ enabled }) {
    super();
    this.enabled = enabled;
    this.state = { status: enabled ? 'idle' : 'disabled' };
    if (!enabled) return;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'available', version: info.version }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest' }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: info.version });
      // Geladen, weil auf „Installieren“ geklickt wurde → gleich installieren
      if (this.installWhenReady) autoUpdater.quitAndInstall(true, true);
    });
    autoUpdater.on('error', (err) => this.set({ status: 'error', error: describe(err) }));
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.state);
  }

  start() {
    if (!this.enabled) return;
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  async check() {
    if (['disabled', 'checking', 'available', 'downloading', 'ready'].includes(this.state.status)) return;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Wird schon über das 'error'-Event angezeigt
    }
  }

  // Nur per Klick: Update laden, dann App beenden, still installieren und die neue Version starten
  async install() {
    if (this.state.status === 'ready') return autoUpdater.quitAndInstall(true, true);
    if (this.state.status !== 'available') return;
    this.installWhenReady = true;
    this.set({ status: 'downloading', progress: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      this.installWhenReady = false; // Fehler zeigt das 'error'-Event
    }
  }
}

function describe(err) {
  const message = String(err?.message || err);
  if (/404|Unable to find latest version|No published versions|Cannot find latest/i.test(message)) {
    return 'Auf GitHub gibt es noch keine veröffentlichte Version.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR/i.test(message)) return 'Keine Verbindung zum Update-Server.';
  return message.split('\n')[0].slice(0, 160);
}

module.exports = { Updater };
