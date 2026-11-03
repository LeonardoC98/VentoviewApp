const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

/**
 * Spenden-Dienste, die die App direkt mit dem Schlüssel des Nutzers abhört – ohne Umweg über unseren Server:
 * StreamElements (Astro), Streamlabs (Socket-API) und Tipeeestream (Socket). Die Schlüssel bleiben auf diesem PC
 * (verschlüsselt mit Windows, falls verfügbar). Jede Spende geht einheitlich als Ereignis an die Module
 * (Alerts, Ziele, Chat-Bot …):
 *   { id, source, sourceName, type: 'donation', user, amount, currency, message, test, at }
 */
const SERVICES = {
  streamelements: { name: 'StreamElements', fields: ['token'] },
  streamlabs: { name: 'Streamlabs', fields: ['token'] },
  tipeeestream: { name: 'Tipeeestream', fields: ['token', 'user'] },
};
const RECONNECT_MS = [5000, 15000, 60000]; // nach Fehlern immer länger warten
const DEDUPE_MS = 15000;

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const money = (value) => {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

class Connections extends EventEmitter {
  constructor({ config, safeStorage, fetch: fetchImpl = fetch }) {
    super();
    this.config = config;
    this.safeStorage = safeStorage;
    this.fetch = fetchImpl;
    this.secrets = this.load();
    this.status = {}; // id → { state: 'connecting'|'connected'|'error', text }
    this.workers = {}; // id → laufende Verbindung
    this.recent = new Map(); // Schlüssel → Zeitpunkt (doppelte Meldungen herausfiltern)
  }

  load() {
    const stored = this.config.get('connections');
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
    const text = JSON.stringify(this.secrets);
    if (!Object.keys(this.secrets).length) this.config.set({ connections: null });
    else if (this.safeStorage?.isEncryptionAvailable()) this.config.set({ connections: { encrypted: this.safeStorage.encryptString(text).toString('base64') } });
    else this.config.set({ connections: { plain: text } });
  }

  // Für die Oberfläche: Dienste, ob eingerichtet, Zustand – nie die Schlüssel selbst
  state() {
    return Object.fromEntries(Object.entries(SERVICES).map(([id, service]) => [id, {
      name: service.name,
      fields: service.fields,
      configured: Boolean(this.secrets[id]),
      user: this.secrets[id]?.user || null,
      ...(this.secrets[id] ? this.status[id] || { state: 'connecting', text: 'Verbinde …' } : { state: 'off', text: '' }),
    }]));
  }

  setStatus(id, state, text) {
    this.status[id] = { state, text };
    this.emit('change');
  }

  async save(id, values) {
    const service = SERVICES[id];
    if (!service) throw new Error('Unbekannter Dienst.');
    const next = {};
    for (const field of service.fields) {
      const value = clean(values?.[field], 2000);
      if (!value) throw new Error(field === 'user' ? 'Bitte deinen Benutzernamen eintragen.' : 'Bitte den Schlüssel eintragen.');
      next[field] = value;
    }
    this.secrets[id] = next;
    this.persist();
    this.restart(id);
    return this.state();
  }

  remove(id) {
    this.stopOne(id);
    delete this.secrets[id];
    delete this.status[id];
    this.persist();
    this.emit('change');
    return this.state();
  }

  // Probe-Spende: zeigt, ob Alerts und Ziele ankommen – ohne echten Dienst
  test(id) {
    const service = SERVICES[id];
    if (!service) throw new Error('Unbekannter Dienst.');
    this.donation(id, { user: 'TestSpender', amount: 5, currency: 'EUR', message: 'Test über die App – alles kommt an!' }, { test: true });
    return { message: `Test-Spende über ${service.name} geschickt` };
  }

  start() {
    for (const id of Object.keys(this.secrets)) this.restart(id);
  }

  stop() {
    for (const id of Object.keys(this.workers)) this.stopOne(id);
  }

  stopOne(id) {
    this.workers[id]?.stop();
    delete this.workers[id];
  }

  restart(id) {
    this.stopOne(id);
    if (!this.secrets[id]) return;
    const create = { streamelements: streamElements, streamlabs, tipeeestream }[id];
    this.setStatus(id, 'connecting', 'Verbinde …');
    this.workers[id] = keepConnected((handlers) => create(this.secrets[id], handlers, this.fetch), {
      onStatus: (state, text) => this.setStatus(id, state, text),
      onDonation: (data) => this.donation(id, data),
    });
  }

  // Einheitliches Ereignis; derselbe Betrag vom selben Namen kurz hintereinander zählt nur einmal
  donation(source, data, { test = false } = {}) {
    const event = {
      id: crypto.randomUUID(), source, sourceName: SERVICES[source]?.name || source, type: 'donation',
      user: clean(data.user, 60) || 'Anonym', amount: money(data.amount), currency: clean(data.currency, 8).toUpperCase(),
      message: clean(data.message, 500), test, at: Date.now(),
    };
    const key = data.key || `${source}|${event.user}|${event.amount}|${event.message}`;
    const now = Date.now();
    for (const [k, at] of this.recent) if (now - at > DEDUPE_MS) this.recent.delete(k);
    if (!test && this.recent.has(key)) return;
    this.recent.set(key, now);
    this.emit('event', event);
  }
}

// Hält eine Verbindung offen: bei Abbruch neu verbinden, nach Fehlern mit wachsender Pause
function keepConnected(open, { onStatus, onDonation }) {
  let stopped = false;
  let current = null;
  let timer = null;
  let failures = 0;
  const run = () => {
    if (stopped) return;
    current = open({
      connected: (text) => {
        failures = 0;
        onStatus('connected', text);
      },
      donation: onDonation,
      closed: (error) => {
        current = null;
        if (stopped) return;
        failures += 1;
        onStatus(error?.fatal ? 'error' : 'connecting', error?.message || 'Verbindung getrennt – verbinde neu …');
        if (error?.fatal) return; // falscher Schlüssel: erst nach neuem Speichern wieder versuchen
        timer = setTimeout(run, RECONNECT_MS[Math.min(failures - 1, RECONNECT_MS.length - 1)]);
      },
    });
  };
  run();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      current?.close();
    },
  };
}

// Kleiner Socket.IO-Client (Engine.IO 3 und 4) über WebSocket – reicht für Streamlabs und Tipeeestream
function socketIo(url, { onConnect, onEvent, onClose }) {
  const ws = new WebSocket(url);
  let pingTimer = null;
  let joined = false;
  let done = false;
  const finish = (reason) => {
    if (done) return;
    done = true;
    clearInterval(pingTimer);
    onClose(reason, joined);
  };
  const emit = (name, payload) => ws.readyState === WebSocket.OPEN && ws.send(`42${JSON.stringify([name, payload])}`);
  ws.addEventListener('message', (e) => {
    const data = String(e.data);
    if (data.startsWith('0{')) {
      // Engine.IO 3: der Client pingt; Engine.IO 4: der Server pingt (siehe unten)
      const { pingInterval = 25000 } = JSON.parse(data.slice(1));
      pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('2'), pingInterval);
    } else if (data === '2') {
      ws.send('3');
    } else if (data.startsWith('40')) {
      joined = true;
      onConnect(emit);
    } else if (data.startsWith('44')) {
      finish('refused');
      ws.close();
    } else if (data.startsWith('42')) {
      try {
        const [name, payload] = JSON.parse(data.slice(2));
        onEvent(name, payload);
      } catch { /* kaputte Meldung */ }
    }
  });
  ws.addEventListener('close', () => finish('closed'));
  ws.addEventListener('error', () => ws.close());
  return { close: () => ws.close() };
}

// Streamlabs: „Socket API Token“ (Streamlabs → Einstellungen → API-Einstellungen → API-Token)
function streamlabs({ token }, handlers) {
  const url = `wss://sockets.streamlabs.com/socket.io/?token=${encodeURIComponent(token)}&EIO=3&transport=websocket`;
  return socketIo(url, {
    onConnect: () => handlers.connected('Hört auf Spenden über Streamlabs'),
    onEvent: (name, payload) => {
      if (name !== 'event' || payload?.type !== 'donation') return;
      for (const d of [].concat(payload.message || [])) {
        const id = d._id || d.id;
        handlers.donation({ user: d.name || d.from, amount: d.amount, currency: d.currency, message: d.message, key: id ? `streamlabs|${id}` : undefined });
      }
    },
    onClose: (reason, joined) => handlers.closed(joined || reason !== 'refused'
      ? { message: 'Verbindung zu Streamlabs getrennt – verbinde neu …' }
      : { fatal: true, message: 'Streamlabs lehnt den Schlüssel ab – bitte den „Socket API Token“ prüfen.' }),
  });
}

// Tipeeestream: API-Schlüssel und Benutzername (Tipeeestream → Einstellungen → API)
function tipeeestream({ token, user }, handlers, fetchImpl) {
  let socket = null;
  let closed = false;
  (async () => {
    let host = 'https://sso-cf.tipeeestream.com';
    let port = '443';
    try {
      const res = await fetchImpl('https://api.tipeeestream.com/v2.0/site/socket');
      const data = await res.json();
      if (data?.datas?.host) ({ host, port = '443' } = data.datas);
    } catch { /* Standard-Adresse */ }
    if (closed) return;
    const base = String(host).replace(/^http/, 'ws').replace(/\/$/, '');
    socket = socketIo(`${base}:${port}/socket.io/?access_token=${encodeURIComponent(token)}&EIO=3&transport=websocket`, {
      onConnect: (emit) => {
        emit('join-room', { room: token, username: user });
        handlers.connected(`Hört auf Spenden über Tipeeestream (${user})`);
      },
      onEvent: (name, payload) => {
        const event = payload?.event;
        if (name !== 'new-event' || event?.type !== 'donation') return;
        const p = event.parameters || {};
        handlers.donation({ user: p.username || event.user?.username, amount: p.amount, currency: p.currency, message: p.message, key: event.id ? `tipeeestream|${event.id}` : undefined });
      },
      onClose: (reason, joined) => handlers.closed(joined || reason !== 'refused'
        ? { message: 'Verbindung zu Tipeeestream getrennt – verbinde neu …' }
        : { fatal: true, message: 'Tipeeestream lehnt den Schlüssel ab – bitte API-Schlüssel und Benutzernamen prüfen.' }),
    });
  })();
  return { close: () => { closed = true; socket?.close(); } };
}

// StreamElements: JWT-Token (StreamElements → Konto → Kanäle → „Geheimnisse anzeigen“) über Astro (WebSocket)
function streamElements({ token }, handlers) {
  const ws = new WebSocket('wss://astro.streamelements.com');
  const nonces = new Set();
  let subscribed = false;
  let refused = false;
  const subscribe = (topic) => {
    const nonce = crypto.randomUUID();
    nonces.add(nonce);
    ws.send(JSON.stringify({ type: 'subscribe', nonce, data: { topic, token, token_type: 'jwt' } }));
  };
  ws.addEventListener('open', () => {
    // Spenden kommen je nach Konto über „channel.tips“ oder „channel.activities“ – beide abonnieren, doppelte fallen raus
    subscribe('channel.tips');
    subscribe('channel.activities');
  });
  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type === 'response' && nonces.has(msg.nonce)) {
      if (msg.error) {
        refused = /unauthori|invalid|token/i.test(`${msg.error} ${msg.data?.message || ''}`);
        if (refused) ws.close();
        return;
      }
      if (!subscribed) handlers.connected('Hört auf Spenden über StreamElements');
      subscribed = true;
    } else if (msg.type === 'reconnect') {
      ws.close();
    } else if (msg.type === 'message') {
      const tip = parseStreamElements(msg.topic, msg.data);
      if (tip) handlers.donation(tip);
    }
  });
  ws.addEventListener('close', () => handlers.closed(refused
    ? { fatal: true, message: 'StreamElements lehnt den Schlüssel ab – bitte den JWT-Token prüfen.' }
    : { message: 'Verbindung zu StreamElements getrennt – verbinde neu …' }));
  ws.addEventListener('error', () => ws.close());
  return { close: () => ws.close() };
}

// channel.tips: { donation: { user: { username }, amount, currency, message }, _id }
// channel.activities: { type: 'tip', data: { username, amount, currency, message, tipId } }
function parseStreamElements(topic, data) {
  if (!data) return null;
  if (topic === 'channel.tips' && data.donation) {
    const d = data.donation;
    return { user: d.user?.username || d.user?.name, amount: d.amount, currency: d.currency, message: d.message, key: data._id ? `se|${data._id}` : undefined };
  }
  if (topic === 'channel.activities' && data.type === 'tip') {
    const d = data.data || {};
    const id = d.tipId || data.activityId || data._id;
    return { user: d.displayName || d.username, amount: d.amount, currency: d.currency, message: d.message, key: id ? `se|${id}` : undefined };
  }
  return null;
}

module.exports = { Connections, SERVICES, parseStreamElements };
