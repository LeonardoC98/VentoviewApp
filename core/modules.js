const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

/**
 * Lädt, startet und stoppt Module. Alles, was das Konto freischaltet, lädt die App von selbst herunter;
 * der Nutzer schaltet Module nur aktiv/inaktiv (config.json → inactive).
 * Jedes Modul liegt in <dir>/<id>/ (module.json + index.js) und bekommt
 * einen eigenen Datenordner unter <dataDir>/<id>/, der Updates überlebt.
 */
class ModuleManager extends EventEmitter {
  // Pfad einer öffentlichen Moduldatei (für den lokalen Dienst) – nur einfache Bild-Dateinamen
  publicFile(id, name) {
    if (!this.running.has(id) || !/^[\w.-]{1,100}\.(png|jpe?g|gif|webp)$/i.test(name)) return null;
    return path.join(this.dataDir, id, 'public', name);
  }

  // Läuft das Modul mit dieser App-Version? (module.json → "minApp")
  supports(info) {
    if (!info.minApp) return true;
    const parse = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
    const [a, b] = [parse(this.appVersion), parse(info.minApp)];
    for (let i = 0; i < 3; i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return true;
  }

  constructor({ dir, dataDir, siteUrl, bridge, appVersion, account, twitch, config, extensions, keys }) {
    super();
    this.keys = keys;       // globale Tastendrücke (nur solange ein Modul zuhört)
    this.appVersion = appVersion || '0.0.0';
    this.account = account; // Lizenzschein: welche Module freigeschaltet sind
    this.twitch = twitch;   // gemeinsame Twitch-Verbindung für Module
    this.config = config;
    this.extensions = extensions; // App-Erweiterungen (.vvext), die manche Module brauchen
    this.dir = dir;
    this.dataDir = dataDir;
    this.siteUrl = siteUrl; // () => string
    this.bridge = bridge;
    this.running = new Map(); // id → { manifest, instance, status }
    this.busy = new Set();
    this.registry = null;
    this.registryError = null;
  }

  async loadInstalled() {
    await fs.mkdir(this.dir, { recursive: true });
    for (const entry of await fs.readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        await this.start(entry.name);
      } catch (err) {
        console.error(`Modul "${entry.name}" konnte nicht gestartet werden:`, err);
      }
    }
  }

  async start(id) {
    const manager = this;
    const moduleDir = path.join(this.dir, id);
    const manifest = JSON.parse(await fs.readFile(path.join(moduleDir, 'module.json'), 'utf8'));
    const dataDir = path.join(this.dataDir, id);
    const publicDir = path.join(dataDir, 'public');
    await fs.mkdir(publicDir, { recursive: true });

    const entry = {
      manifest,
      instance: null,
      status: { state: 'idle', text: 'Startet …' },
      settings: await this.readSettings(id, manifest),
      suggestions: {},
      onSettings: null,
      onAction: null,
      cleanups: [],
      locked: !this.account?.allows(id),
      inactive: this.isInactive(id),
      needsExtension: Boolean(manifest.requires?.extension && !this.extensions?.has(manifest.requires.extension)),
    };
    this.running.set(id, entry);

    // Ohne Freischaltung bleibt das Modul installiert, läuft aber nicht
    if (entry.locked) {
      entry.status = this.account?.state().connected
        ? { state: 'warn', text: 'Für dein Konto nicht freigeschaltet' }
        : { state: 'warn', text: 'Erst mit deinem Ventoview-Konto verbinden' };
      this.bridge.moduleChanged(id);
      this.emit('change');
      return;
    }
    // Bringt das Modul eine Variable mit, die du schon selbst benutzt (Generator, eigenes Keyword), läuft es nicht –
    // sonst würde einer von beiden still den anderen überschreiben
    const conflict = !entry.inactive && this.conflictMessage(id, manifest);
    if (conflict) {
      entry.conflict = true;
      entry.status = { state: 'error', text: conflict };
      this.bridge.moduleChanged(id);
      this.emit('change');
      return;
    }
    if (entry.inactive || entry.needsExtension) {
      entry.status = entry.inactive
        ? { state: 'idle', text: 'Inaktiv' }
        : { state: 'warn', text: `Braucht die Erweiterung „${manifest.requires.name || manifest.requires.extension}“` };
      this.bridge.moduleChanged(id);
      this.emit('change');
      return;
    }

    const ctx = {
      id,
      version: manifest.version,
      dataDir,
      // Dateien hier liefert der lokale Dienst unter /files/<id>/<name> aus (z. B. Album-Cover)
      publicDir,
      fileUrl: (name) => `/files/${encodeURIComponent(id)}/${encodeURIComponent(name)}`,
      get settings() { return entry.settings; },
      onSettings: (callback) => { entry.onSettings = callback; },
      // Vorschläge für ein Einstellungsfeld, z. B. gerade erkannte Quellen für eine Whitelist
      setSuggestions: (key, list) => {
        if (JSON.stringify(entry.suggestions[key]) === JSON.stringify(list)) return;
        entry.suggestions[key] = list;
        this.emit('change');
      },
      // Test-Knöpfe im Editor und in der App (module.json → "actions")
      onAction: (callback) => { entry.onAction = callback; },
      // Globale Tastendrücke: callback({ type: 'down'|'up', code, name }) – gibt eine Abmelde-Funktion zurück
      onKey: this.keys && ((callback) => {
        const off = this.keys.on(callback);
        entry.cleanups.push(off);
        return off;
      }),
      // Aktuelle Werte aller Module und eigenen Keywords, z. B. { divsoloduo: 'Gold II', … } – nur lesen
      values: () => Object.assign({}, ...this.bridge.latest.values()),
      // Twitch-Verbindung der App: user, scopes, token(), clientId, onChange()
      twitch: this.twitch && {
        get user() { return manager.twitch.user; },
        get scopes() { return manager.twitch.scopes; },
        token: () => this.twitch.token(),
        invalidate: () => this.twitch.invalidate(),
        clientId: this.twitch.clientId,
        onChange: (callback) => {
          this.twitch.on('change', callback);
          entry.cleanups.push(() => this.twitch.off('change', callback));
        },
      },
      // Erweiterung, die das Modul in module.json → "requires" angibt (z. B. globale Tastenkürzel)
      extension: (name) => (manifest.requires?.extension === name ? this.extensions?.get(name) ?? null : null),
      publish: (data) => this.bridge.publish(id, data),
      setStatus: (text, state = 'ok') => {
        if (entry.status.text === text && entry.status.state === state) return;
        entry.status = { text, state };
        this.bridge.status(id, entry.status);
        this.emit('change');
      },
      log: (...args) => console.log(`[${id}]`, ...args),
    };

    this.bridge.moduleChanged(id);
    this.emit('change');
    try {
      entry.instance = require(path.join(moduleDir, 'index.js'));
      await entry.instance.start(ctx);
    } catch (err) {
      // Modul bleibt in der Liste, damit man es entfernen oder aktualisieren kann
      console.error(`Modul "${id}" konnte nicht gestartet werden:`, err);
      ctx.setStatus(`Konnte nicht starten: ${err.message}`, 'error');
    }
  }

  // Einstellungen eines Moduls: Felder aus module.json → "settings", Werte in <dataDir>/<id>/settings.json
  async readSettings(id, manifest) {
    const defaults = Object.fromEntries((manifest.settings || []).map((f) => [f.key, f.default ?? null]));
    let stored = {};
    try {
      stored = JSON.parse(await fs.readFile(path.join(this.dataDir, id, 'settings.json'), 'utf8'));
    } catch {
      return defaults;
    }
    // Passt ein gespeicherter Wert nicht zum Feldtyp (z. B. von einer älteren App, die den Typ noch nicht kannte),
    // gilt der Standard – sonst geht das Einstellungsfenster nicht auf
    for (const field of manifest.settings || []) {
      const listType = ['lines', 'hotkeys', 'dials', 'randomizers', 'blocks', 'extrakeys'].includes(field.type);
      if (field.key in stored && listType && !Array.isArray(stored[field.key])) delete stored[field.key];
    }
    return { ...defaults, ...stored };
  }

  // persist: false = nur vorläufig übernehmen (Einstellungsfenster offen, noch nicht gespeichert) – das Modul arbeitet
  // schon damit (z. B. Tastenkürzel neu belegt), die Datei bleibt aber, wie sie war
  async saveSettings(id, input, { persist = true } = {}) {
    const entry = this.running.get(id);
    if (!entry) throw new Error('Modul ist nicht installiert.');
    const values = {};
    for (const field of entry.manifest.settings || []) {
      const raw = input?.[field.key];
      if (field.type === 'lines' || field.type === 'hotkeys' || field.type === 'dials' || field.type === 'extrakeys') {
        values[field.key] = (Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n/))
          .map((line) => String(line).trim()).filter(Boolean).slice(0, 200).map((line) => line.slice(0, 200));
      } else if (field.type === 'randomizers') {
        values[field.key] = cleanRandomizers(raw);
      } else if (field.type === 'blocks') {
        // Bot-Elemente (Editor → „Ventoview“); null = noch nie gespeichert (Modul übernimmt alte Einstellungen)
        values[field.key] = Array.isArray(raw) ? cleanBlocks(raw) : null;
      } else if (field.type === 'select') {
        const allowed = (field.options || []).map(([v]) => String(v));
        values[field.key] = allowed.includes(String(raw)) ? String(raw) : String(field.default ?? allowed[0] ?? '');
      } else if (field.type === 'toggle') {
        values[field.key] = Boolean(raw);
      } else if (field.type === 'number') {
        const n = Number(raw);
        values[field.key] = Number.isFinite(n) ? n : field.default ?? 0;
      } else {
        values[field.key] = String(raw ?? '').slice(0, 1000);
      }
    }
    if (persist) await fs.writeFile(path.join(this.dataDir, id, 'settings.json'), JSON.stringify(values, null, 2));
    entry.settings = values;
    // Neue Generator-Namen können Konflikte mit anderen Modulen lösen (oder auslösen)
    if (id === 'chatbot') this.syncLicense();
    try {
      entry.onSettings?.(values);
    } catch (err) {
      console.error(`Modul "${id}" konnte die Einstellungen nicht übernehmen:`, err);
    }
    this.emit('change');
  }

  async stop(id) {
    const entry = this.running.get(id);
    if (!entry) return;
    this.running.delete(id);
    for (const cleanup of entry.cleanups || []) cleanup();
    try {
      await entry.instance?.stop?.();
    } catch (err) {
      console.error(`Modul "${id}" ließ sich nicht sauber beenden:`, err);
    }
    // Damit ein Update den neuen Code lädt und nicht den gecachten
    const prefix = path.join(this.dir, id) + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(prefix)) delete require.cache[key];
    }
    this.bridge.moduleChanged(id);
    this.emit('change');
  }

  async stopAll() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  async fetchRegistry() {
    try {
      const res = await fetch(new URL('registry.json', this.siteUrl()), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.registry = await res.json();
      this.registryError = null;
    } catch {
      this.registryError = `Webseite ${this.siteUrl()} ist nicht erreichbar.`;
    }
    this.emit('change');
    return this.registry;
  }

  async install(id) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    this.emit('change');
    try {
      const registry = await this.fetchRegistry();
      const info = registry?.modules?.find((m) => m.id === id);
      if (!info) throw new Error(this.registryError || 'Modul nicht gefunden.');
      if (!this.supports(info)) throw new Error(`„${info.name}“ braucht Ventoview ${info.minApp} oder neuer – bitte zuerst die App aktualisieren.`);
      if (!this.account?.state().connected) throw new Error('Verbinde die App zuerst mit deinem Ventoview-Konto (Einstellungen → Ventoview-Konto).');
      if (!this.account.allows(id)) throw new Error(`„${info.name}“ ist für dein Konto nicht freigeschaltet.`);

      const res = await fetch(new URL(info.package, this.siteUrl()), { cache: 'no-store', headers: this.account.authHeader() });
      if (res.status === 403) throw new Error(`„${info.name}“ ist für dein Konto nicht freigeschaltet.`);
      if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}).`);
      const raw = Buffer.from(await res.arrayBuffer());
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      if (hash !== info.sha256) throw new Error('Prüfsumme stimmt nicht – der Download ist beschädigt.');

      const pkg = JSON.parse(raw.toString('utf8'));
      if (pkg.id !== id) throw new Error('Paket gehört zu einem anderen Modul.');

      // In einen Temp-Ordner entpacken und erst danach austauschen
      const tmp = path.join(this.dir, `.tmp-${id}`);
      await fs.rm(tmp, { recursive: true, force: true });
      for (const [rel, content] of Object.entries(pkg.files)) {
        const target = path.resolve(tmp, rel);
        if (!target.startsWith(tmp + path.sep)) throw new Error('Ungültiger Dateipfad im Modul.');
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, Buffer.from(content, 'base64'));
      }

      await this.stop(id);
      const target = path.join(this.dir, id);
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(tmp, target);
      await this.start(id);
    } finally {
      this.busy.delete(id);
      this.emit('change');
    }
  }

  // Namen, die du selbst vergeben hast: Zufallsgeneratoren im Chat-Bot und eigene Keywords der App
  userNames() {
    const names = new Map(); // Name → wo
    for (const b of this.running.get('chatbot')?.settings?.blocks || []) {
      if (b?.type === 'generator' && b.name) names.set(b.name, `deinem Zufallsgenerator „${b.name}“ (Chat-Bot)`);
      if (b?.type === 'counter' && b.name) names.set(`zaehler_${b.name}`, `deinem Zähler „${b.name}“ (Chat-Bot)`);
    }
    for (const k of this.config?.get('keywords') || []) if (k?.key) names.set(k.key, `deinem eigenen Keyword „${k.key}“ (App → Keywords)`);
    return names;
  }

  // Feste Variablen aller Module (installiert und im Shop) → Name → Modulname. Eigene Keywords dürfen nicht so heißen.
  moduleNames() {
    const names = new Map();
    const add = (m) => { for (const k of m?.keywords || []) if (k?.key && !names.has(k.key)) names.set(k.key, m.name || m.id); };
    for (const entry of this.running.values()) add(entry.manifest);
    for (const m of this.registry?.modules || []) add(m);
    return names;
  }

  // Eigene Keywords, die (z. B. nach einem neuen Modul) schon anders vergeben sind → Name → Meldung
  keywordConflicts() {
    const taken = this.moduleNames();
    const generators = this.userNames();
    const out = {};
    for (const k of this.config?.get('keywords') || []) {
      if (!k?.key) continue;
      if (taken.has(k.key)) out[k.key] = `{${k.key}} gibt es schon im Modul „${taken.get(k.key)}“ – bitte umbenennen.`;
      else if (generators.has(k.key) && !generators.get(k.key).startsWith('deinem eigenen')) out[k.key] = `{${k.key}} heißt schon ${generators.get(k.key)} – bitte umbenennen.`;
    }
    return out;
  }

  // Meldung, wenn ein Modul eine Variable mitbringt, die schon vergeben ist – sonst null
  conflictMessage(id, manifest) {
    if (id === 'chatbot') return null;
    const names = this.userNames();
    const hit = (manifest.keywords || []).find((k) => names.has(k.key));
    return hit ? `Du verwendest {${hit.key}} schon in ${names.get(hit.key)}. Das Modul „${manifest.name || id}“ kann deshalb nicht aktiviert werden – benenne zuerst ${names.get(hit.key).startsWith('deinem eigenen') ? 'das Keyword' : 'den Generator'} um.` : null;
  }

  isInactive(id) {
    return (this.config?.get('inactive') || []).includes(id);
  }

  // Aktiv/inaktiv schalten – inaktive Module bleiben geladen, laufen aber nicht
  async setActive(id, active) {
    if (active) {
      const manifest = this.running.get(id)?.manifest || this.registry?.modules?.find((m) => m.id === id);
      const conflict = manifest && this.conflictMessage(id, manifest);
      if (conflict) throw new Error(conflict);
    }
    const list = new Set(this.config.get('inactive') || []);
    if (active) list.delete(id);
    else list.add(id);
    this.config.set({ inactive: [...list] });
    if (this.running.has(id)) {
      await this.stop(id);
      await this.start(id);
    } else if (active) {
      await this.install(id);
    }
    this.emit('change');
  }

  // Alles, was das Konto freischaltet, ist automatisch da – fehlende Module still herunterladen
  // Alles, was das Konto freischaltet, ist automatisch da und aktuell: fehlende Module still herunterladen,
  // veraltete auf die Version der Webseite bringen (Einstellungen und Daten bleiben – sie liegen getrennt)
  async autoInstall() {
    if (!this.registry || !this.account?.state().connected) return;
    for (const info of this.registry.modules || []) {
      if (this.busy.has(info.id) || !this.account.allows(info.id) || !this.supports(info)) continue;
      const current = this.running.get(info.id)?.manifest.version;
      if (current && current === info.version) continue;
      await this.install(info.id).catch((err) => console.error(`Modul "${info.id}" konnte nicht geladen werden:`, err.message));
    }
  }

  // Nach dem Laden oder Entfernen einer Erweiterung die Module neu starten, die sie brauchen
  async syncExtensions() {
    for (const [id, entry] of [...this.running.entries()]) {
      if (!entry.manifest.requires?.extension) continue;
      await this.stop(id);
      await this.start(id).catch((err) => console.error(`Modul "${id}" konnte nicht gestartet werden:`, err));
    }
  }

  async uninstall(id) {
    await this.stop(id);
    await fs.rm(path.join(this.dir, id), { recursive: true, force: true });
    this.emit('change');
  }

  // Nach einem neuen Lizenzschein: frei gewordene Module starten, gesperrte anhalten
  // Immer nur ein Abgleich gleichzeitig – zwei parallele würden dieselben Module gleichzeitig stoppen und starten,
  // und ein Modul bliebe womöglich gesperrt, obwohl das Konto es freischaltet
  syncLicense() {
    this.licenseQueue = (this.licenseQueue || Promise.resolve()).then(() => this.applyLicense()).catch((err) => console.error('Lizenz-Abgleich:', err));
    return this.licenseQueue;
  }

  async applyLicense() {
    let changed = false;
    for (const [id, entry] of [...this.running.entries()]) {
      // Freischaltung geändert – oder ein Namenskonflikt ist inzwischen gelöst (Generator/Keyword umbenannt)
      const resolved = entry.conflict && !this.conflictMessage(id, entry.manifest);
      if ((entry.locked === !this.account?.allows(id) && !resolved) || this.busy.has(id)) continue;
      changed = true;
      await this.stop(id);
      await this.start(id).catch((err) => console.error(`Modul "${id}" konnte nicht gestartet werden:`, err));
    }
    if (changed) this.emit('change');
  }

  // Felder und Werte der Modul-Einstellungen (für den Editor auf der Webseite)
  settingsOf(id) {
    const entry = this.running.get(id);
    if (!entry) throw new Error('Modul ist nicht installiert.');
    return { fields: entry.manifest.settings || [], values: entry.settings, suggestions: entry.suggestions };
  }

  async action(id, name, args) {
    const entry = this.running.get(id);
    if (!entry || entry.locked) throw new Error('Modul läuft nicht.');
    if (!entry.onAction) throw new Error('Dieses Modul hat keine Aktionen.');
    return entry.onAction(String(name), args || {});
  }

  state(id) {
    const entry = this.running.get(id);
    return { installed: Boolean(entry), locked: Boolean(entry?.locked), status: entry?.status ?? null };
  }

  list() {
    const available = this.registry?.modules ?? [];
    const installed = [...this.running.entries()].map(([id, { manifest, status, settings, suggestions, locked, inactive, needsExtension }]) => {
      const latest = available.find((m) => m.id === id);
      return {
        ...manifest,
        locked,
        inactive,
        needsExtension,
        status,
        settingsValues: settings,
        suggestions,
        busy: this.busy.has(id),
        update: latest && latest.version !== manifest.version ? latest.version : null,
      };
    });
    return {
      installed,
      available: available
        .filter((m) => !this.running.has(m.id))
        .map((m) => ({ ...m, busy: this.busy.has(m.id), unsupported: !this.supports(m), locked: !this.account?.allows(m.id) })),
      registryError: this.registryError,
    };
  }
}

// Zufallsgeneratoren (z. B. !lucky): Name (für {zufall_name}), Befehl, Abklingzeit, Antwort-Art, Antworttext
// mit {treffer} und Einträge mit Gewicht (Chance relativ zu den anderen; 0 = kommt nie)
function cleanRandomizers(raw) {
  const used = new Set();
  return (Array.isArray(raw) ? raw : []).slice(0, 30).map((r, i) => {
    let name = String(r?.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30) || `zufall${i + 1}`;
    while (used.has(name)) name += '2';
    used.add(name);
    const cooldown = r?.cooldown === '' || r?.cooldown == null ? null : Number(r.cooldown);
    return {
      name,
      command: String(r?.command || '').trim().split(/\s+/)[0].slice(0, 40),
      cooldown: Number.isFinite(cooldown) ? Math.max(0, Math.min(86400, cooldown)) : null,
      mode: ['all', 'reply', 'whisper', 'none'].includes(r?.mode) ? r.mode : 'reply',
      text: String(r?.text ?? '{treffer}').slice(0, 450),
      entries: (Array.isArray(r?.entries) ? r.entries : []).slice(0, 500)
        .map((e) => ({ text: String(e?.text ?? '').trim().slice(0, 400), weight: Math.max(0, Math.min(1000, Number(e?.weight ?? 1) || 0)) }))
        .filter((e) => e.text),
    };
  });
}

// Bot-Elemente des Chat-Bots: nur bekannte Arten und Felder, Texte begrenzt
const BLOCK_TYPES = ['command', 'generator', 'random', 'timer', 'schedule', 'shortcut', 'counter', 'welcome', 'event'];
const EVENT_KINDS = ['any', 'follow', 'sub', 'resub', 'giftsub', 'bits', 'raid', 'redeem'];
function cleanBlocks(raw) {
  const str = (v, max = 450) => String(v ?? '').slice(0, max);
  const word = (v) => String(v ?? '').trim().split(/\s+/)[0].slice(0, 40);
  // Mehrere Befehle mit Komma: „!rank, !elo“ – jeder nur ein Wort, höchstens 10
  const words = (v) => String(v ?? '').split(',').map(word).filter(Boolean).slice(0, 10).join(', ');
  const name = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
  const num = (v, min, max) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.max(min, Math.min(max, Number(v))));
  const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
  return raw.slice(0, 200).filter((b) => b && BLOCK_TYPES.includes(b.type)).map((b, i) => {
    // gens: zugeordnete Zufallsgeneratoren (stehen im Editor darunter) – bei jedem Element möglich
    const base = {
      id: /^[\w-]{1,40}$/.test(b.id || '') ? b.id : `b${i}${Date.now().toString(36)}`, type: b.type, on: b.on !== false,
      // Wann: true = nur live, false = immer, null = wie die Grundeinstellung des Bots
      live: b.live == null ? null : Boolean(b.live),
      gens: (Array.isArray(b.gens) ? b.gens : []).map((g) => String(g ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30)).filter(Boolean).slice(0, 20),
    };
    switch (b.type) {
      case 'command':
        return {
          ...base, trigger: words(b.trigger), mode: pick(b.mode, ['all', 'reply', 'whisper'], 'all'), text: str(b.text), cooldown: num(b.cooldown, 0, 86400),
          gens: (Array.isArray(b.gens) ? b.gens : []).map(name).filter(Boolean).slice(0, 20),
        };
      case 'generator':
        // Zufallsgenerator (Kind von Befehlen, gehört zu seinem Namen)
        return {
          id: base.id, type: 'generator', name: name(b.name),
          entries: (Array.isArray(b.entries) ? b.entries : []).slice(0, 500)
            .map((e) => ({ text: str(e?.text, 400).trim(), weight: num(e?.weight ?? 1, 0, 1000) ?? 1 })).filter((e) => e.text),
        };
      case 'random':
        return {
          ...base, name: name(b.name) || `zufall${i + 1}`, trigger: word(b.trigger), mode: pick(b.mode, ['all', 'reply', 'whisper', 'none'], 'reply'),
          text: str(b.text || '{treffer}'), cooldown: num(b.cooldown, 0, 86400),
          entries: (Array.isArray(b.entries) ? b.entries : []).slice(0, 500)
            .map((e) => ({ text: str(e?.text, 400).trim(), weight: num(e?.weight ?? 1, 0, 1000) ?? 1 })).filter((e) => e.text),
        };
      case 'timer':
        return { ...base, minutes: num(b.minutes, 1, 1440) ?? 20, text: str(b.text) };
      case 'schedule':
        return {
          ...base, time: /^\d{1,2}:\d{2}$/.test(b.time || '') ? b.time.padStart(5, '0') : '20:00', text: str(b.text),
          days: (Array.isArray(b.days) ? b.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        };
      case 'shortcut':
        return { ...base, shortcut: str(b.shortcut, 40).trim(), text: str(b.text) };
      case 'counter':
        return {
          ...base, trigger: words(b.trigger), name: name(b.name) || `zaehler${i + 1}`, text: str(b.text || '{zaehler}'), who: pick(b.who, ['all', 'mods'], 'mods'),
          step: num(b.step, 1, 1000) ?? 1, start: num(b.start, -1e6, 1e6) ?? 0, mode: pick(b.mode, ['all', 'reply'], 'all'), cooldown: num(b.cooldown, 0, 86400),
        };
      case 'welcome':
        return { ...base, text: str(b.text || 'Willkommen {user}!'), mode: pick(b.mode, ['all', 'reply'], 'reply') };
      default: // event
        return { ...base, on: b.on !== false, kinds: (Array.isArray(b.kinds) ? b.kinds : ['any']).filter((k) => EVENT_KINDS.includes(k)), text: str(b.text) };
    }
  }).filter((b) => b.type !== 'generator' || b.name); // Generator ohne Namen gibt es nicht
}

module.exports = { ModuleManager };
