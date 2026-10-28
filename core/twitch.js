const { EventEmitter } = require('node:events');

// Öffentliche Twitch-App „Ventoview App“ – die Client-ID ist nicht geheim, ein Secret gibt es nicht
const CLIENT_ID = '0j2rkj9nzvqtayn5a71icucgr5b93r';
// Chat lesen, Bits, Abos, Follower und Kanalpunkte – dazu Chat schreiben und Whispers (Chat-Bot)
const SCOPES = 'user:read:chat bits:read channel:read:subscriptions moderator:read:followers channel:read:redemptions user:write:chat user:manage:whispers';

/**
 * Twitch-Verbindung der App (für Module wie Twitch-Chat und Alerts). Anmeldung per Gerätecode:
 * Twitch zeigt einen Code, der Nutzer bestätigt ihn auf twitch.tv/activate. Die Tokens bleiben auf diesem PC
 * (verschlüsselt mit Windows, falls verfügbar).
 */
class TwitchAuth extends EventEmitter {
  constructor({ config, safeStorage, openExternal }) {
    super();
    this.config = config;
    this.safeStorage = safeStorage;
    this.openExternal = openExternal;
    this.data = this.load();
    this.pending = null; // { code, uri, deviceCode, interval, expiresAt }
    this.error = null;
    this.refreshing = null;
  }

  get clientId() {
    return CLIENT_ID;
  }

  get user() {
    return this.data ? { id: this.data.userId, login: this.data.login } : null;
  }

  // Erlaubnisse des Tokens – null bei älteren Verbindungen, bis das Token einmal erneuert wurde
  get scopes() {
    return this.data?.scopes || null;
  }

  state() {
    if (this.data) return { status: 'connected', login: this.data.login };
    if (this.pending) return { status: 'pending', code: this.pending.code, uri: this.pending.uri };
    return { status: this.error ? 'error' : 'off', error: this.error };
  }

  load() {
    const stored = this.config.get('twitch');
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

  save(data) {
    this.data = data;
    if (!data) {
      this.config.set({ twitch: null });
    } else if (this.safeStorage?.isEncryptionAvailable()) {
      this.config.set({ twitch: { encrypted: this.safeStorage.encryptString(JSON.stringify(data)).toString('base64') } });
    } else {
      this.config.set({ twitch: { plain: JSON.stringify(data) } });
    }
    this.emit('change');
  }

  async form(url, params) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  }

  async connect() {
    this.error = null;
    const { ok, data } = await this.form('https://id.twitch.tv/oauth2/device', { client_id: CLIENT_ID, scopes: SCOPES });
    if (!ok || !data.device_code) throw new Error(data.message || 'Twitch antwortet nicht.');
    this.pending = {
      code: data.user_code, uri: data.verification_uri, deviceCode: data.device_code,
      interval: Math.max(2, data.interval || 5) * 1000, expiresAt: Date.now() + (data.expires_in || 1800) * 1000,
    };
    this.emit('change');
    this.openExternal(data.verification_uri);
    this.poll(this.pending);
    return this.state();
  }

  cancel() {
    this.pending = null;
    this.emit('change');
  }

  // Warten, bis der Nutzer den Code bestätigt hat
  async poll(pending) {
    while (this.pending === pending && Date.now() < pending.expiresAt) {
      await new Promise((r) => setTimeout(r, pending.interval));
      if (this.pending !== pending) return;
      const { ok, data } = await this.form('https://id.twitch.tv/oauth2/token', {
        client_id: CLIENT_ID, scopes: SCOPES, device_code: pending.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).catch(() => ({ ok: false, data: { message: 'authorization_pending' } }));
      if (ok && data.access_token) {
        this.pending = null;
        await this.store(data);
        return;
      }
      if (data.message === 'slow_down') pending.interval += 2000;
      else if (data.message !== 'authorization_pending') {
        this.pending = null;
        this.error = data.message === 'access_denied' ? 'Abgelehnt.' : `Twitch: ${data.message || 'Fehler'}`;
        this.emit('change');
        return;
      }
    }
    if (this.pending === pending) {
      this.pending = null;
      this.error = 'Der Code ist abgelaufen – bitte noch einmal verbinden.';
      this.emit('change');
    }
  }

  async store(tokens) {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${tokens.access_token}` } });
    const info = await res.json();
    if (!info.user_id) throw new Error('Twitch-Anmeldung ungültig.');
    this.save({
      access: tokens.access_token, refresh: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000, userId: info.user_id, login: info.login, scopes: info.scopes || [],
    });
  }

  // Gültiges Zugriffs-Token für Module – erneuert es bei Bedarf
  async token() {
    if (!this.data) return null;
    if (this.data.expiresAt - 60000 > Date.now()) return this.data.access;
    this.refreshing ||= (async () => {
      const { ok, data } = await this.form('https://id.twitch.tv/oauth2/token', {
        client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: this.data.refresh,
      });
      if (!ok || !data.access_token) {
        this.error = 'Twitch-Verbindung abgelaufen – bitte neu verbinden.';
        this.save(null);
        return null;
      }
      this.save({
        ...this.data, access: data.access_token, refresh: data.refresh_token || this.data.refresh,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000, scopes: data.scope || this.data.scopes,
      });
      return data.access_token;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // Token als abgelaufen markieren (z. B. nach 401 von Twitch), damit token() es erneuert
  invalidate() {
    if (this.data) this.data.expiresAt = 0;
  }

  async disconnect() {
    const token = this.data?.access;
    this.save(null);
    if (token) await this.form('https://id.twitch.tv/oauth2/revoke', { client_id: CLIENT_ID, token }).catch(() => {});
  }
}

module.exports = { TwitchAuth };
