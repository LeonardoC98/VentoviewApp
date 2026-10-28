const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const REFRESH_MS = 6 * 3600 * 1000;

/**
 * Verbindung zum Ventoview-Konto. Die Webseite stellt einen signierten Lizenzschein aus (welche Module frei sind,
 * gültig für ein paar Tage); die App prüft die Unterschrift und holt sich regelmäßig einen frischen.
 * Gespeichert wird in config.json → account: { deviceToken, license, publicKey }.
 */
class Account extends EventEmitter {
  constructor({ config, siteUrl }) {
    super();
    this.config = config;
    this.siteUrl = siteUrl; // () => string
    this.data = config.get('account') || null;
    this.error = null;
    this.timer = null;
  }

  // Inhalt des Lizenzscheins, wenn Unterschrift und Ablaufdatum stimmen – sonst null
  get license() {
    const { license, publicKey } = this.data || {};
    if (!license || !publicKey) return null;
    try {
      const [payload, signature] = license.split('.');
      if (!crypto.verify(null, Buffer.from(payload), crypto.createPublicKey(publicKey), Buffer.from(signature, 'base64url'))) return null;
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.exp * 1000 > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  allows(moduleId) {
    return Boolean(this.license?.modules?.includes(moduleId));
  }

  // Für den Download von Modul-Paketen
  authHeader() {
    return this.data?.license ? { Authorization: `Bearer ${this.data.license}` } : {};
  }

  state() {
    const license = this.license;
    return {
      connected: Boolean(license),
      paired: Boolean(this.data?.deviceToken),
      userId: license?.sub ?? null,
      name: license?.name ?? null,
      modules: license?.modules ?? [],
      expires: license ? license.exp * 1000 : null,
      error: this.error,
    };
  }

  // Von der Webseite („Diesen PC verbinden“) oder nach dem Einlösen eines Codes
  set({ deviceToken, license, publicKey }) {
    if (!deviceToken || !license || !publicKey) throw new Error('Unvollständige Kontodaten.');
    const previous = this.data;
    this.data = { deviceToken, license, publicKey };
    if (!this.license) {
      this.data = previous;
      throw new Error('Der Lizenzschein ist ungültig.');
    }
    this.error = null;
    this.config.set({ account: this.data });
    this.emit('change');
    return this.state();
  }

  async post(path, body) {
    const res = await fetch(new URL(path, this.siteUrl()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Fehler ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async pair(code) {
    const data = await this.post('api/pair', { code, name: require('node:os').hostname() });
    return this.set(data);
  }

  async refresh() {
    if (!this.data?.deviceToken) return this.state();
    try {
      const { license, publicKey } = await this.post('api/license', { deviceToken: this.data.deviceToken });
      this.set({ deviceToken: this.data.deviceToken, license, publicKey });
    } catch (err) {
      if (err.status === 401) {
        // PC wurde auf der Webseite getrennt
        this.clear();
        this.error = err.message;
      } else {
        // Offline: der alte Schein gilt bis zu seinem Ablauf weiter
        this.error = this.license ? null : `Konto nicht erreichbar: ${err.message}`;
      }
      this.emit('change');
    }
    return this.state();
  }

  clear() {
    this.data = null;
    this.error = null;
    this.config.set({ account: null });
    this.emit('change');
  }

  start() {
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }
}

module.exports = { Account };
