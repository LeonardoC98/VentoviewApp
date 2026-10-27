const { EventEmitter } = require('node:events');
const { autoUpdater } = require('electron-updater');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Automatische Updates über GitHub Releases (Ziel: package.json → build.publish).
 * Neue Versionen werden im Hintergrund geladen, per SHA-512 geprüft und beim Beenden
 * oder per Klick installiert. Status: disabled | idle | checking | latest | downloading | ready | error
 */
class Updater extends EventEmitter {
  constructor({ enabled }) {
    super();
    this.enabled = enabled;
    this.state = { status: enabled ? 'idle' : 'disabled' };
    if (!enabled) return;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, progress: 0 }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest' }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
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
    if (['disabled', 'checking', 'downloading', 'ready'].includes(this.state.status)) return;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Wird schon über das 'error'-Event angezeigt
    }
  }

  // Beendet die App, installiert still und startet die neue Version
  install() {
    if (this.state.status === 'ready') autoUpdater.quitAndInstall(true, true);
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
