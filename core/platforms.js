const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

/**
 * YouTube und Kick neben Twitch: Anmeldung, Live-Chat, Ereignisse und Nachrichten schreiben – einheitlich für die
 * Module (Stream-Chat, Chat-Bot, Alerts, Ziele, Interaktion). Beide Anbieter verlangen ein geheimes App-Passwort,
 * deshalb läuft die Anmeldung über den Ventoview-Server (server/platforms.js); Kick schickt Chat und Ereignisse
 * nur an eine Webadresse, der Server reicht sie an die App weiter. Die Tokens bleiben auf diesem PC (verschlüsselt
 * mit Windows, falls verfügbar).
 *
 * Ereignisse für Module:
 *   'chat'  { platform, id, user, userId, color, text, badges: ['broadcaster'|'moderator'|'vip'|'subscriber'|…],
 *             emotes: [['kick:123', start, end]], self, at }
 *   'event' { platform, type: 'follow'|'sub'|'resub'|'giftsub'|'bits'|'donation'|'redeem'|'live'|'clear', user,
 *             amount, currency, unit, months, tier, message, reward, live, at }
 */
const PLATFORMS = { youtube: 'YouTube', kick: 'Kick' };
const YT_API = 'https://www.googleapis.com/youtube/v3';
const KICK_API = 'https://api.kick.com/public/v1';
const KICK_EVENTS = ['chat.message.sent', 'channel.followed', 'channel.subscription.new', 'channel.subscription.renewal',
  'channel.subscription.gifts', 'kicks.gifted', 'channel.reward.redemption.updated', 'livestream.status.updated', 'moderation.banned'];
const LIVE_SEARCH_MS = 90000;   // YouTube: so oft nach einem laufenden Livestream schauen (kostet Kontingent)
const STATS_MS = 10 * 60000;    // Abonnenten (YouTube) bzw. Abos (Kick) neu holen
const POLL_MIN_MS = 5000;       // YouTube-Chat abfragen, wenn der Stream-Weg nicht geht – nicht öfter (Kontingent)
const RETRY_MS = [5000, 15000, 60000];
const MAX_TEXT = 500;

const wait = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});
const clean = (value, max = 200) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

class Platforms extends EventEmitter {
  constructor({ config, safeStorage, openExternal, siteUrl, account, fetch: fetchImpl = fetch }) {
    super();
    this.config = config;
    this.safeStorage = safeStorage;
    this.openExternal = openExternal;
    this.siteUrl = siteUrl; // () => string
    this.account = account;
    this.fetch = fetchImpl;
    this.data = this.load();      // id → { access, refresh, expiresAt, userId, name, slug }
    this.pending = {};            // id → { code, uri } (YouTube) bzw. { browser: true } (Kick)
    this.errors = {};
    this.status = {};             // id → { state, text } – Live-Chat
    this.info = {};               // id → { live, followers, subs, chatId }
    this.available = null;        // vom Server: welche Plattformen eingerichtet sind
    this.workers = {};            // id → AbortController
    this.refreshing = {};
  }

  // ---------- Speichern ----------

  load() {
    const stored = this.config.get('platforms');
    if (!stored) return {};
    try {
      const text = stored.encrypted && this.safeStorage?.isEncryptionAvailable()
        ? this.safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))
        : stored.plain;
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  persist() {
    const text = JSON.stringify(this.data);
    if (!Object.keys(this.data).length) this.config.set({ platforms: null });
    else if (this.safeStorage?.isEncryptionAvailable()) this.config.set({ platforms: { encrypted: this.safeStorage.encryptString(text).toString('base64') } });
    else this.config.set({ platforms: { plain: text } });
  }

  save(id, data) {
    if (data) this.data[id] = data;
    else delete this.data[id];
    this.persist();
    this.emit('change');
  }

  // ---------- Für Oberfläche und Module ----------

  state() {
    return Object.fromEntries(Object.entries(PLATFORMS).map(([id, name]) => {
      const d = this.data[id];
      const base = { name, available: this.available ? Boolean(this.available[id]) : null };
      if (d) return [id, { ...base, status: 'connected', user: d.name, live: Boolean(this.info[id]?.live), chat: this.status[id] || null }];
      if (this.pending[id]) return [id, { ...base, status: 'pending', ...this.pending[id] }];
      return [id, { ...base, status: this.errors[id] ? 'error' : 'off', error: this.errors[id] || null }];
    }));
  }

  // Verbundene Plattformen für Module: [{ id, name, user, live, followers, subs }]
  connected() {
    return Object.keys(PLATFORMS).filter((id) => this.data[id]).map((id) => ({
      id, name: PLATFORMS[id], user: this.data[id].name, live: Boolean(this.info[id]?.live),
      followers: this.info[id]?.followers ?? null, subs: this.info[id]?.subs ?? null,
    }));
  }

  setStatus(id, state, text) {
    const now = this.status[id];
    if (now?.state === state && now?.text === text) return;
    this.status[id] = { state, text };
    this.emit('change');
  }

  setInfo(id, patch) {
    const before = JSON.stringify(this.info[id] || {});
    this.info[id] = { ...this.info[id], ...patch };
    if (JSON.stringify(this.info[id]) !== before) this.emit('change');
  }

  // ---------- Ventoview-Server ----------

  async server(pathname, body = {}, { method = 'POST' } = {}) {
    const deviceToken = this.account?.data?.deviceToken;
    if (!deviceToken) throw new Error('Erst die App oben mit deinem Ventoview-Konto verbinden.');
    const res = await this.fetch(new URL(pathname, this.siteUrl()), {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': deviceToken },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
  }

  async checkAvailable() {
    try {
      const res = await this.fetch(new URL('/api/platforms', this.siteUrl()));
      if (res.ok) this.available = await res.json();
    } catch { /* Webseite nicht erreichbar – beim nächsten Mal */ }
    this.emit('change');
    return this.available;
  }

  // ---------- Anmelden ----------

  async connect(id) {
    if (!PLATFORMS[id]) throw new Error('Unbekannte Plattform.');
    delete this.errors[id];
    await this.checkAvailable();
    if (this.available && !this.available[id]) throw new Error(`${PLATFORMS[id]} ist auf dem Ventoview-Server noch nicht eingerichtet.`);
    return id === 'youtube' ? this.connectYoutube() : this.connectKick();
  }

  cancel(id) {
    delete this.pending[id];
    this.emit('change');
  }

  fail(id, text) {
    delete this.pending[id];
    this.errors[id] = text;
    this.emit('change');
  }

  // YouTube: Gerätecode wie bei Twitch – Google zeigt eine Seite, auf der man den Code eingibt
  async connectYoutube() {
    const { ok, data } = await this.server('/api/youtube/device');
    if (!ok || !data.device_code) throw new Error(data.error_description || data.error || 'YouTube antwortet nicht.');
    const pending = { code: data.user_code, uri: data.verification_url || 'https://www.google.com/device' };
    this.pending.youtube = pending;
    this.emit('change');
    this.openExternal(pending.uri);
    const expires = Date.now() + (data.expires_in || 1800) * 1000;
    let interval = Math.max(5, data.interval || 5) * 1000;
    (async () => {
      while (this.pending.youtube === pending && Date.now() < expires) {
        await wait(interval);
        if (this.pending.youtube !== pending) return;
        const res = await this.server('/api/youtube/token', { device_code: data.device_code }).catch(() => ({ data: { error: 'authorization_pending' } }));
        if (res.data.access_token) {
          delete this.pending.youtube;
          try {
            await this.storeYoutube(res.data);
          } catch (err) {
            this.fail('youtube', err.message);
          }
          return;
        }
        if (res.data.error === 'slow_down') interval += 5000;
        else if (res.data.error !== 'authorization_pending') {
          return this.fail('youtube', res.data.error === 'access_denied' ? 'Abgelehnt.' : `YouTube: ${res.data.error_description || res.data.error || 'Fehler'}`);
        }
      }
      if (this.pending.youtube === pending) this.fail('youtube', 'Der Code ist abgelaufen – bitte noch einmal verbinden.');
    })();
    return this.state();
  }

  async storeYoutube(tokens) {
    const res = await this.fetch(`${YT_API}/channels?part=snippet,statistics&mine=true`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const data = await res.json().catch(() => ({}));
    const channel = data.items?.[0];
    if (!channel) throw new Error('Zu diesem Google-Konto gibt es keinen YouTube-Kanal.');
    this.info.youtube = { followers: Number(channel.statistics?.subscriberCount) || null, statsAt: Date.now() };
    this.save('youtube', {
      access: tokens.access_token, refresh: tokens.refresh_token, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      userId: channel.id, name: channel.snippet?.title || 'YouTube',
    });
    this.restart('youtube');
  }

  // Kick: Anmeldung im Browser; die App fragt beim Server nach, bis sie fertig ist
  async connectKick() {
    const { ok, data } = await this.server('/api/kick/start');
    if (!ok || !data.url) throw new Error(data.error || 'Kick antwortet nicht.');
    const pending = { browser: true };
    this.pending.kick = pending;
    this.emit('change');
    this.openExternal(data.url);
    const expires = Date.now() + 10 * 60000;
    (async () => {
      while (this.pending.kick === pending && Date.now() < expires) {
        await wait(2000);
        if (this.pending.kick !== pending) return;
        const res = await this.server('/api/kick/result', { state: data.state }).catch(() => ({ data: { pending: true } }));
        if (res.data.pending) continue;
        delete this.pending.kick;
        if (!res.data.access_token) return this.fail('kick', res.data.error || 'Kick wurde nicht verbunden.');
        try {
          await this.storeKick(res.data);
        } catch (err) {
          this.fail('kick', err.message);
        }
        return;
      }
      if (this.pending.kick === pending) this.fail('kick', 'Die Anmeldung ist abgelaufen – bitte noch einmal verbinden.');
    })();
    return this.state();
  }

  async storeKick(tokens) {
    const res = await this.fetch(`${KICK_API}/users`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const user = (await res.json().catch(() => ({})))?.data?.[0];
    if (!user?.user_id) throw new Error('Kick-Konto nicht gefunden.');
    this.save('kick', {
      access: tokens.access_token, refresh: tokens.refresh_token, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      userId: String(user.user_id), name: user.name || 'Kick',
    });
    this.restart('kick');
  }

  async disconnect(id) {
    const d = this.data[id];
    this.stopOne(id);
    delete this.info[id];
    delete this.status[id];
    delete this.errors[id];
    this.save(id, null);
    // Zugriff beim Anbieter zurückziehen (geht ohne App-Passwort)
    if (d?.access) {
      const url = id === 'youtube' ? `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(d.access)}`
        : `https://id.kick.com/oauth/revoke?token=${encodeURIComponent(d.access)}&token_hint_type=access_token`;
      await this.fetch(url, { method: 'POST' }).catch(() => {});
    }
  }

  // Gültiges Zugriffs-Token – erneuert es bei Bedarf über den Ventoview-Server
  async token(id) {
    const d = this.data[id];
    if (!d) return null;
    if (d.expiresAt - 60000 > Date.now()) return d.access;
    this.refreshing[id] ||= (async () => {
      const { ok, data } = await this.server(`/api/${id}/refresh`, { refresh_token: d.refresh }).catch(() => ({ ok: false, data: {} }));
      if (!ok || !data.access_token) {
        // Server kurz weg: später noch einmal; Erneuern abgelehnt: neu verbinden
        if (data.error === 'invalid_grant' || /invalid|expired|revoked/i.test(String(data.error || ''))) {
          this.stopOne(id);
          this.save(id, null);
          this.errors[id] = `${PLATFORMS[id]}-Verbindung abgelaufen – bitte neu verbinden.`;
          this.emit('change');
        }
        return null;
      }
      this.save(id, { ...this.data[id], access: data.access_token, refresh: data.refresh_token || d.refresh, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
      return data.access_token;
    })().finally(() => { delete this.refreshing[id]; });
    return this.refreshing[id];
  }

  invalidate(id) {
    if (this.data[id]) this.data[id].expiresAt = 0;
  }

  // Anfrage an YouTube oder Kick mit Token; bei 401 einmal erneuern
  async api(id, url, { method = 'GET', body } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(id);
      if (!token) throw Object.assign(new Error(`${PLATFORMS[id]} ist nicht verbunden.`), { status: 401 });
      const res = await this.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        this.invalidate(id);
        continue;
      }
      const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = data.error?.errors?.[0]?.reason || data.error?.status || '';
        throw Object.assign(new Error(data.error?.message || data.message || `${PLATFORMS[id]}: HTTP ${res.status}`), { status: res.status, reason });
      }
      return data;
    }
    return null;
  }

  // ---------- Schreiben ----------

  // Nachricht in den Chat: platform = 'youtube' | 'kick' | leer (alle verbundenen); replyTo = Nachrichten-ID (Kick)
  async send(text, { platform, replyTo } = {}) {
    const message = clean(text, MAX_TEXT);
    if (!message) return [];
    const targets = platform ? [platform] : Object.keys(PLATFORMS).filter((id) => this.data[id]);
    const results = [];
    for (const id of targets) {
      if (!this.data[id]) continue;
      try {
        if (id === 'youtube') {
          const chatId = this.info.youtube?.chatId;
          if (!chatId) throw new Error('Kein laufender YouTube-Livestream.');
          await this.api('youtube', `${YT_API}/liveChat/messages?part=snippet`, {
            method: 'POST', body: { snippet: { liveChatId: chatId, type: 'textMessageEvent', textMessageDetails: { messageText: message.slice(0, 200) } } },
          });
        } else {
          const data = await this.api('kick', `${KICK_API}/chat`, {
            method: 'POST', body: { type: 'user', broadcaster_user_id: Number(this.data.kick.userId), content: message, ...(replyTo ? { reply_to_message_id: replyTo } : {}) },
          });
          if (data?.data && data.data.is_sent === false) throw new Error('Kick hat die Nachricht nicht angenommen.');
        }
        results.push({ platform: id, ok: true });
      } catch (err) {
        results.push({ platform: id, ok: false, error: err.message });
      }
    }
    return results;
  }

  // ---------- Mithören ----------

  start() {
    this.checkAvailable();
    for (const id of Object.keys(PLATFORMS)) if (this.data[id]) this.restart(id);
  }

  stop() {
    for (const id of Object.keys(this.workers)) this.stopOne(id);
  }

  stopOne(id) {
    this.workers[id]?.abort();
    delete this.workers[id];
  }

  restart(id) {
    this.stopOne(id);
    if (!this.data[id]) return;
    const controller = new AbortController();
    this.workers[id] = controller;
    const run = id === 'youtube' ? () => this.youtubeLoop(controller.signal) : () => this.kickLoop(controller.signal);
    run().catch((err) => console.error(`[${id}]`, err));
  }

  emitChat(msg) {
    this.emit('chat', { at: Date.now(), badges: [], emotes: [], color: '', self: false, ...msg });
  }

  emitEvent(e) {
    this.emit('event', { id: crypto.randomUUID(), at: Date.now(), user: '', amount: 0, message: '', ...e });
  }

  // ---------- YouTube ----------

  async youtubeStats() {
    if (Date.now() - (this.info.youtube?.statsAt || 0) < STATS_MS) return;
    const data = await this.api('youtube', `${YT_API}/channels?part=statistics&mine=true`).catch(() => null);
    const count = Number(data?.items?.[0]?.statistics?.subscriberCount);
    this.setInfo('youtube', { statsAt: Date.now(), ...(Number.isFinite(count) ? { followers: count } : {}) });
  }

  async youtubeLoop(signal) {
    let failures = 0;
    while (!signal.aborted && this.data.youtube) {
      try {
        await this.youtubeStats();
        const data = await this.api('youtube', `${YT_API}/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all&maxResults=5`);
        const live = (data.items || []).find((b) => b.snippet?.liveChatId);
        if (!live) {
          this.setInfo('youtube', { live: false, chatId: null });
          this.setStatus('youtube', 'idle', 'Wartet auf einen Livestream');
          failures = 0;
          await wait(LIVE_SEARCH_MS, signal);
          continue;
        }
        if (!this.info.youtube?.live) this.emitEvent({ platform: 'youtube', type: 'live', live: true });
        this.setInfo('youtube', { live: true, chatId: live.snippet.liveChatId });
        this.setStatus('youtube', 'ok', 'Liest den Live-Chat');
        failures = 0;
        await this.youtubeChat(live.snippet.liveChatId, signal);
        if (signal.aborted) return;
        this.setInfo('youtube', { live: false, chatId: null });
        this.emitEvent({ platform: 'youtube', type: 'live', live: false });
        await wait(30000, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err.status === 401 && !this.data.youtube) return;
        failures += 1;
        const quota = err.reason === 'quotaExceeded' || err.reason === 'rateLimitExceeded';
        this.setStatus('youtube', 'error', quota ? 'YouTube-Kontingent für heute aufgebraucht – später geht es weiter' : err.message);
        await wait(quota ? 15 * 60000 : RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)], signal);
      }
    }
  }

  // Chat eines Livestreams: erst über den Stream-Weg (ein Abruf, YouTube schiebt neue Nachrichten nach), sonst abfragen.
  // Was schon vor dem Verbinden im Chat stand, löst keine Alerts aus
  async youtubeChat(chatId, signal) {
    const since = Date.now() - 5000;
    const state = { pageToken: '', ended: false };
    const handle = (response) => {
      if (response.nextPageToken) state.pageToken = response.nextPageToken;
      if (response.offlineAt) state.ended = true;
      for (const item of response.items || []) {
        if (Date.parse(item.snippet?.publishedAt || '') < since) continue;
        if (this.youtubeItem(item) === 'end') state.ended = true;
      }
    };
    try {
      await this.youtubeStream(chatId, state, handle, signal);
    } catch (err) {
      if (signal.aborted || state.ended || ['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled'].includes(err.reason)) return;
      if (err.status === 401 || err.reason === 'quotaExceeded') throw err;
      // Stream-Weg nicht verfügbar – normal abfragen
    }
    while (!signal.aborted && !state.ended && this.data.youtube) {
      let data;
      try {
        data = await this.api('youtube', `${YT_API}/liveChat/messages?liveChatId=${encodeURIComponent(chatId)}&part=snippet,authorDetails&maxResults=200${state.pageToken ? `&pageToken=${encodeURIComponent(state.pageToken)}` : ''}`);
      } catch (err) {
        if (['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled', 'forbidden'].includes(err.reason)) return;
        throw err;
      }
      handle(data);
      await wait(Math.max(POLL_MIN_MS, Number(data.pollingIntervalMillis) || 0), signal);
    }
  }

  async youtubeStream(chatId, state, handle, signal) {
    while (!signal.aborted && !state.ended) {
      const token = await this.token('youtube');
      if (!token) throw Object.assign(new Error('YouTube ist nicht verbunden.'), { status: 401 });
      const url = `${YT_API}/liveChat/messages/stream?liveChatId=${encodeURIComponent(chatId)}&part=snippet,authorDetails&maxResults=200${state.pageToken ? `&pageToken=${encodeURIComponent(state.pageToken)}` : ''}`;
      const res = await this.fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) this.invalidate('youtube');
        throw Object.assign(new Error(data.error?.message || `HTTP ${res.status}`), { status: res.status, reason: data.error?.errors?.[0]?.reason || '' });
      }
      const parse = jsonObjects(handle);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
        if (state.ended) {
          reader.cancel().catch(() => {});
          break;
        }
      }
      // Verbindung zu Ende (YouTube schließt sie nach einer Weile) → mit dem letzten pageToken weiter
      await wait(1000, signal);
    }
  }

  // Eine Chat-Zeile von YouTube → Chat-Nachricht und/oder Ereignis; 'end' = Chat vorbei
  youtubeItem(item) {
    const s = item.snippet || {};
    const a = item.authorDetails || {};
    const user = clean(a.displayName, 60).replace(/^@/, '');
    const self = a.channelId && a.channelId === this.data.youtube?.userId;
    const badges = [a.isChatOwner && 'broadcaster', a.isChatModerator && 'moderator', a.isChatSponsor && 'subscriber', a.isVerified && 'verified'].filter(Boolean);
    const chat = (text) => text && this.emitChat({ platform: 'youtube', id: item.id, user, userId: a.channelId || '', text: clean(text, MAX_TEXT), badges, self });
    switch (s.type) {
      case 'textMessageEvent':
        chat(s.textMessageDetails?.messageText ?? s.displayMessage);
        break;
      case 'superChatEvent': {
        const d = s.superChatDetails || {};
        this.emitEvent({ platform: 'youtube', type: 'donation', user, amount: Math.round((Number(d.amountMicros) || 0) / 10000) / 100, currency: clean(d.currency, 8).toUpperCase(), message: clean(d.userComment, 500) });
        chat(d.userComment);
        break;
      }
      case 'superStickerEvent': {
        const d = s.superStickerDetails || {};
        this.emitEvent({ platform: 'youtube', type: 'donation', user, amount: Math.round((Number(d.amountMicros) || 0) / 10000) / 100, currency: clean(d.currency, 8).toUpperCase(), message: clean(d.superStickerMetadata?.altText, 200) });
        break;
      }
      case 'newSponsorEvent':
        this.emitEvent({ platform: 'youtube', type: 'sub', user, tier: clean(s.newSponsorDetails?.memberLevelName, 60), months: 1 });
        break;
      case 'memberMilestoneChatEvent': {
        const d = s.memberMilestoneChatDetails || {};
        this.emitEvent({ platform: 'youtube', type: 'resub', user, tier: clean(d.memberLevelName, 60), months: Number(d.memberMonth) || 0, amount: Number(d.memberMonth) || 0, message: clean(d.userComment, 500) });
        chat(d.userComment);
        break;
      }
      case 'membershipGiftingEvent': {
        const d = s.membershipGiftingDetails || {};
        this.emitEvent({ platform: 'youtube', type: 'giftsub', user, amount: Math.max(1, Number(d.giftMembershipsCount) || 1), tier: clean(d.giftMembershipsLevelName, 60) });
        break;
      }
      case 'giftEvent': {
        const d = s.giftDetails || {};
        this.emitEvent({ platform: 'youtube', type: 'bits', unit: 'Jewels', user, amount: Number(d.jewelsAmount) || 0, message: clean(d.giftName, 100) });
        break;
      }
      case 'userBannedEvent':
        this.emitEvent({ platform: 'youtube', type: 'clear', user: clean(s.userBannedDetails?.bannedUserDetails?.displayName, 60).replace(/^@/, '') });
        break;
      case 'chatEndedEvent':
        return 'end';
      default:
        break;
    }
    return null;
  }

  // ---------- Kick ----------

  // Ereignisse beim Anbieter abonnieren (Kick schickt sie an den Ventoview-Server) – nur, was noch fehlt
  async kickSubscribe() {
    const list = await this.api('kick', `${KICK_API}/events/subscriptions`);
    const have = new Set((list?.data || []).map((s) => s.event));
    const missing = KICK_EVENTS.filter((name) => !have.has(name));
    if (missing.length) {
      await this.api('kick', `${KICK_API}/events/subscriptions`, { method: 'POST', body: { method: 'webhook', events: missing.map((name) => ({ name, version: 1 })) } });
    }
  }

  async kickStats() {
    if (Date.now() - (this.info.kick?.statsAt || 0) < STATS_MS) return;
    const data = await this.api('kick', `${KICK_API}/channels?broadcaster_user_id=${encodeURIComponent(this.data.kick.userId)}`).catch(() => null);
    const channel = data?.data?.[0];
    if (!channel) return;
    this.setInfo('kick', { statsAt: Date.now(), slug: channel.slug, live: Boolean(channel.stream?.is_live), subs: Number(channel.active_subscribers_count) || 0 });
  }

  async kickLoop(signal) {
    let failures = 0;
    let subscribed = false;
    const statsTimer = setInterval(() => this.kickStats().catch(() => {}), 60000);
    signal.addEventListener('abort', () => clearInterval(statsTimer), { once: true });
    while (!signal.aborted && this.data.kick) {
      try {
        if (!subscribed) {
          await this.kickSubscribe();
          subscribed = true;
        }
        await this.kickStats().catch(() => {});
        const token = await this.token('kick');
        if (!token) return;
        const deviceToken = this.account?.data?.deviceToken;
        if (!deviceToken) throw new Error('Erst die App mit deinem Ventoview-Konto verbinden.');
        this.setStatus('kick', 'connecting', 'Verbinde …');
        const res = await this.fetch(new URL('/api/kick/events', this.siteUrl()), {
          headers: { 'X-Device-Token': deviceToken, 'X-Kick-Token': token, Accept: 'text/event-stream' }, signal,
        });
        if (res.status === 401) {
          this.invalidate('kick');
          throw new Error('Kick-Anmeldung wird erneuert …');
        }
        if (!res.ok || !res.body) throw new Error(`Ventoview-Server: HTTP ${res.status}`);
        this.setStatus('kick', 'ok', 'Liest Chat und Ereignisse');
        failures = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parse = sse((event, data) => {
          if (event === 'kick') {
            try {
              const msg = JSON.parse(data);
              this.kickEvent(msg.type, msg.payload || {});
            } catch { /* kaputte Zeile */ }
          }
        });
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parse(decoder.decode(value, { stream: true }));
        }
        if (signal.aborted) return;
        this.setStatus('kick', 'connecting', 'Verbindung getrennt – verbinde neu …');
        await wait(2000, signal);
      } catch (err) {
        if (signal.aborted) return;
        failures += 1;
        this.setStatus('kick', 'error', err.message);
        await wait(RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)], signal);
      }
    }
  }

  kickEvent(type, p) {
    const name = (u) => clean(u?.username, 60);
    if (type === 'chat.message.sent') {
      const sender = p.sender || {};
      const { text, emotes } = kickText(String(p.content || ''));
      this.emitChat({
        platform: 'kick', id: String(p.message_id || ''), user: name(sender), userId: String(sender.user_id ?? ''),
        color: /^#[0-9a-f]{6}$/i.test(sender.identity?.username_color || '') ? sender.identity.username_color : '',
        text: clean(text, MAX_TEXT), emotes,
        badges: [...new Set((sender.identity?.badges || []).map((b) => String(b.type || '')).filter(Boolean)
          .concat(String(sender.user_id) === this.data.kick?.userId ? ['broadcaster'] : []))],
        self: String(sender.user_id) === this.data.kick?.userId,
      });
    } else if (type === 'channel.followed') {
      this.emitEvent({ platform: 'kick', type: 'follow', user: name(p.follower) });
    } else if (type === 'channel.subscription.new') {
      this.emitEvent({ platform: 'kick', type: 'sub', user: name(p.subscriber), months: Number(p.duration) || 1 });
    } else if (type === 'channel.subscription.renewal') {
      this.emitEvent({ platform: 'kick', type: 'resub', user: name(p.subscriber), months: Number(p.duration) || 0, amount: Number(p.duration) || 0 });
    } else if (type === 'channel.subscription.gifts') {
      this.emitEvent({ platform: 'kick', type: 'giftsub', user: p.gifter?.is_anonymous || !p.gifter ? 'Anonym' : name(p.gifter), amount: Math.max(1, (p.giftees || []).length) });
    } else if (type === 'kicks.gifted') {
      this.emitEvent({ platform: 'kick', type: 'bits', unit: 'Kicks', user: name(p.sender), amount: Number(p.gift?.amount) || 0, message: clean(p.gift?.message, 500) });
    } else if (type === 'channel.reward.redemption.updated') {
      if (p.status && p.status !== 'pending') return; // nur neue Einlösungen, nicht das Annehmen/Ablehnen danach
      this.emitEvent({ platform: 'kick', type: 'redeem', user: name(p.redeemer), reward: clean(p.reward?.title, 100), amount: Number(p.reward?.cost) || 0, message: clean(p.user_input, 500) });
    } else if (type === 'livestream.status.updated') {
      this.setInfo('kick', { live: Boolean(p.is_live) });
      this.emitEvent({ platform: 'kick', type: 'live', live: Boolean(p.is_live) });
    } else if (type === 'moderation.banned') {
      this.emitEvent({ platform: 'kick', type: 'clear', user: name(p.banned_user) });
    }
  }
}

// „Hallo [emote:37226:KEKW]“ → Text „Hallo KEKW“ und Emotes [['kick:37226', 6, 9]] (Positionen in Zeichen)
function kickText(content) {
  const emotes = [];
  let text = '';
  let last = 0;
  const re = /\[emote:(\d+):([^\]]*)\]/g;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    text += content.slice(last, m.index);
    const start = Array.from(text).length;
    const word = m[2] || 'emote';
    text += word;
    emotes.push([`kick:${m[1]}`, start, start + Array.from(word).length - 1]);
    last = m.index + m[0].length;
  }
  return { text: text + content.slice(last), emotes };
}

// Zerlegt Server-Sent Events: „event: x\ndata: …\n\n“
function sse(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.replace(/\r\n/g, '\n');
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent(event, data.join('\n'));
      end = buffer.indexOf('\n\n');
    }
  };
}

// Holt fertige JSON-Objekte aus einem Strom („[{…},{…}“ oder ein Objekt pro Zeile) – YouTube schickt so nach und nach
function jsonObjects(onObject) {
  let buffer = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  return (chunk) => {
    const offset = buffer.length;
    buffer += chunk;
    for (let i = offset; i < buffer.length; i++) {
      const c = buffer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') {
        if (depth === 0) start = i;
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            onObject(JSON.parse(buffer.slice(start, i + 1)));
          } catch { /* unvollständig */ }
          buffer = buffer.slice(i + 1);
          i = -1;
          start = -1;
        }
      }
    }
    if (depth === 0) buffer = '';
  };
}

module.exports = { Platforms, kickText, sse, jsonObjects };
