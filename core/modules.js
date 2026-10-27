const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

/**
 * Installiert, startet und entfernt Module.
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

  constructor({ dir, dataDir, siteUrl, bridge, appVersion, account, twitch }) {
    super();
    this.appVersion = appVersion || '0.0.0';
    this.account = account; // Lizenzschein: welche Module freigeschaltet sind
    this.twitch = twitch;   // gemeinsame Twitch-Verbindung für Module
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
    };
    this.running.set(id, entry);

    // Ohne Freischaltung bleibt das Modul installiert, läuft aber nicht
    if (entry.locked) {
      entry.status = this.account?.state().connected
        ? { state: 'warn', text: 'Für dein Konto nicht freigeschaltet' }
        : { state: 'warn', text: 'Erst mit deinem VentoView-Konto verbinden' };
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
      // Twitch-Verbindung der App: user, token(), clientId, onChange()
      twitch: this.twitch && {
        get user() { return manager.twitch.user; },
        token: () => this.twitch.token(),
        invalidate: () => this.twitch.invalidate(),
        clientId: this.twitch.clientId,
        onChange: (callback) => {
          this.twitch.on('change', callback);
          entry.cleanups.push(() => this.twitch.off('change', callback));
        },
      },
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
    try {
      return { ...defaults, ...JSON.parse(await fs.readFile(path.join(this.dataDir, id, 'settings.json'), 'utf8')) };
    } catch {
      return defaults;
    }
  }

  async saveSettings(id, input) {
    const entry = this.running.get(id);
    if (!entry) throw new Error('Modul ist nicht installiert.');
    const values = {};
    for (const field of entry.manifest.settings || []) {
      const raw = input?.[field.key];
      if (field.type === 'lines') {
        values[field.key] = (Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n/))
          .map((line) => String(line).trim()).filter(Boolean).slice(0, 200).map((line) => line.slice(0, 200));
      } else if (field.type === 'toggle') {
        values[field.key] = Boolean(raw);
      } else if (field.type === 'number') {
        const n = Number(raw);
        values[field.key] = Number.isFinite(n) ? n : field.default ?? 0;
      } else {
        values[field.key] = String(raw ?? '').slice(0, 1000);
      }
    }
    await fs.writeFile(path.join(this.dataDir, id, 'settings.json'), JSON.stringify(values, null, 2));
    entry.settings = values;
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
      if (!this.supports(info)) throw new Error(`„${info.name}“ braucht VentoView ${info.minApp} oder neuer – bitte zuerst die App aktualisieren.`);
      if (!this.account?.state().connected) throw new Error('Verbinde die App zuerst mit deinem VentoView-Konto (Einstellungen → VentoView-Konto).');
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

  async uninstall(id) {
    await this.stop(id);
    await fs.rm(path.join(this.dir, id), { recursive: true, force: true });
    this.emit('change');
  }

  // Nach einem neuen Lizenzschein: frei gewordene Module starten, gesperrte anhalten
  async syncLicense() {
    for (const [id, entry] of [...this.running.entries()]) {
      if (entry.locked === !this.account?.allows(id)) continue;
      await this.stop(id);
      await this.start(id).catch((err) => console.error(`Modul "${id}" konnte nicht gestartet werden:`, err));
    }
    this.emit('change');
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
    return { installed: Boolean(entry), status: entry?.status ?? null };
  }

  list() {
    const available = this.registry?.modules ?? [];
    const installed = [...this.running.entries()].map(([id, { manifest, status, settings, suggestions, locked }]) => {
      const latest = available.find((m) => m.id === id);
      return {
        ...manifest,
        locked,
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

module.exports = { ModuleManager };
