/**
 * Riot-Daten für die Module (League, TFT, VALORANT). Der Schlüssel liegt nur auf dem Ventoview-Server: Die App fragt dort
 * mit ihrem Geräte-Token an. League und TFT kommen mit der Riot-ID aus – keine Anmeldung nötig.
 *
 * VALORANT gibt Spielerdaten nur nach Riot Sign On heraus: login() öffnet den Browser, die Zugangsschlüssel bleiben
 * verschlüsselt auf diesem PC (wie bei YouTube und Kick) und gehen nur mit, um die eigenen Spiele abzurufen.
 */
const { EventEmitter } = require('node:events');

const INFO_MS = 5 * 60 * 1000;
const LOGIN_MS = 5 * 60 * 1000;

class Riot extends EventEmitter {
  constructor({ config, safeStorage, openExternal, siteUrl, account, fetchImpl = fetch }) {
    super();
    this.config = config;
    this.safeStorage = safeStorage;
    this.openExternal = openExternal;
    this.siteUrl = siteUrl;
    this.account = account;
    this.fetch = fetchImpl;
    this.tokens = this.load();
    this.available = null;
    this.availableAt = 0;
    this.pending = null;
  }

  load() {
    const stored = this.config.get('riot');
    if (!stored) return null;
    try {
      const text = stored.encrypted && this.safeStorage?.isEncryptionAvailable()
        ? this.safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))
        : stored.plain;
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  save(tokens) {
    this.tokens = tokens;
    if (!tokens) this.config.set({ riot: null });
    else if (this.safeStorage?.isEncryptionAvailable()) this.config.set({ riot: { encrypted: this.safeStorage.encryptString(JSON.stringify(tokens)).toString('base64') } });
    else this.config.set({ riot: { plain: JSON.stringify(tokens) } });
    this.emit('change');
  }

  async post(pathname, body = {}) {
    const deviceToken = this.account?.data?.deviceToken;
    if (!deviceToken) throw new Error('Erst die App mit deinem Ventoview-Konto verbinden.');
    const res = await this.fetch(new URL(pathname, this.siteUrl()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': deviceToken },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Fehler ${res.status}`), { status: res.status });
    return data;
  }

  // Was der Server kann: { api, rso } – gemerkt für ein paar Minuten
  async info() {
    if (this.available && Date.now() - this.availableAt < INFO_MS) return this.available;
    const res = await this.fetch(new URL('/api/riot', this.siteUrl()));
    this.available = res.ok ? await res.json() : { api: false, rso: false };
    this.availableAt = Date.now();
    return this.available;
  }

  get connected() {
    return Boolean(this.tokens?.access);
  }

  remember(data) {
    this.save({ access: data.access_token, refresh: data.refresh_token || this.tokens?.refresh, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  }

  async token() {
    if (!this.tokens) throw Object.assign(new Error('Bitte mit dem Riot-Konto anmelden.'), { status: 401 });
    if (Date.now() < this.tokens.expires - 60000) return this.tokens.access;
    const data = await this.post('/api/riot/rso/refresh', { refresh_token: this.tokens.refresh });
    if (!data.access_token) {
      this.save(null);
      throw Object.assign(new Error('Bitte mit dem Riot-Konto neu anmelden.'), { status: 401 });
    }
    this.remember(data);
    return this.tokens.access;
  }

  // Eigene VALORANT-Spiele: der Server fragt mit dem Zugang der angemeldeten Person
  async valPlayer(body = {}) {
    return this.post('/api/riot/val/player', { ...body, accessToken: await this.token() });
  }

  async login() {
    const { url, state } = await this.post('/api/riot/rso/start');
    const pending = {};
    this.pending = pending;
    this.openExternal(url);
    const expires = Date.now() + LOGIN_MS;
    while (this.pending === pending && Date.now() < expires) {
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
      const data = await this.post('/api/riot/rso/result', { state }).catch(() => ({ pending: true }));
      if (data.pending) continue;
      this.pending = null;
      if (!data.access_token) throw new Error(data.error || 'Riot wurde nicht verbunden.');
      this.remember(data);
      return true;
    }
    this.pending = null;
    throw new Error('Die Anmeldung ist abgelaufen – bitte noch einmal verbinden.');
  }

  logout() {
    this.pending = null;
    this.save(null);
  }
}

module.exports = { Riot };
