const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ID = /^[a-z0-9-]{2,40}$/;
const MAX_FILE = 5 * 1024 * 1024;

/**
 * Erweiterungen (.vvext) erweitern die App selbst, z. B. um globale Tastenkürzel. Man lädt sie nach dem Kauf
 * auf der Webseite herunter; die Datei ist vom Server unterschrieben (derselbe Schlüssel wie der Lizenzschein),
 * damit die App keinen fremden Code ausführt.
 *   Datei: { payload: base64url(JSON { id, name, version, files: { rel: base64 } }), signature }
 *   Entpackt: <dir>/<id>/ – index.js exportiert { start(api), stop() }
 * Module nutzen eine Erweiterung über ctx.extension(id) (module.json → "requires": { "extension": id }).
 */
class ExtensionManager extends EventEmitter {
  constructor({ dir, account, electron }) {
    super();
    this.dir = dir;
    this.account = account;
    this.electron = electron; // { globalShortcut } – was Erweiterungen von Electron bekommen
    this.loaded = new Map();  // id → { info, instance, api }
  }

  async loadInstalled() {
    await fs.mkdir(this.dir, { recursive: true });
    for (const entry of await fs.readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      await this.start(entry.name).catch((err) => console.error(`Erweiterung "${entry.name}" konnte nicht starten:`, err));
    }
  }

  // Unterschrift mit dem Schlüssel des Kontos prüfen und den Inhalt zurückgeben
  verify(raw) {
    const publicKey = this.account?.data?.publicKey;
    if (!publicKey) throw new Error('Verbinde die App zuerst mit deinem Ventoview-Konto.');
    let file;
    try {
      file = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('Das ist keine Ventoview-Erweiterung (.vvext).');
    }
    const ok = typeof file.payload === 'string' && typeof file.signature === 'string'
      && crypto.verify(null, Buffer.from(file.payload), crypto.createPublicKey(publicKey), Buffer.from(file.signature, 'base64url'));
    if (!ok) throw new Error('Die Unterschrift der Erweiterung stimmt nicht – bitte nur Dateien von der Ventoview-Webseite benutzen.');
    const pkg = JSON.parse(Buffer.from(file.payload, 'base64url').toString('utf8'));
    if (!ID.test(pkg.id || '') || !pkg.files?.['index.js']) throw new Error('Die Erweiterung ist unvollständig.');
    return pkg;
  }

  async installFile(file) {
    const stat = await fs.stat(file);
    if (stat.size > MAX_FILE) throw new Error('Die Datei ist zu groß.');
    const pkg = this.verify(await fs.readFile(file));

    const tmp = path.join(this.dir, `.tmp-${pkg.id}`);
    await fs.rm(tmp, { recursive: true, force: true });
    for (const [rel, content] of Object.entries(pkg.files)) {
      const target = path.resolve(tmp, rel);
      if (!target.startsWith(tmp + path.sep)) throw new Error('Ungültiger Dateipfad in der Erweiterung.');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(content, 'base64'));
    }
    await fs.writeFile(path.join(tmp, 'extension.json'), JSON.stringify({ id: pkg.id, name: pkg.name, version: pkg.version }));

    await this.stop(pkg.id);
    const target = path.join(this.dir, pkg.id);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(tmp, target);
    await this.start(pkg.id);
    return { id: pkg.id, name: pkg.name, version: pkg.version };
  }

  async start(id) {
    const dir = path.join(this.dir, id);
    const info = JSON.parse(await fs.readFile(path.join(dir, 'extension.json'), 'utf8'));
    const entry = { info, instance: null, api: null };
    const api = {
      ...this.electron,
      dir, // eigene Dateien der Erweiterung (z. B. ein unsichtbares Fenster)
      // Was Module über ctx.extension(id) bekommen
      provide: (value) => { entry.api = value; },
      log: (...args) => console.log(`[ext:${id}]`, ...args),
    };
    entry.instance = require(path.join(dir, 'index.js'));
    await entry.instance.start(api);
    this.loaded.set(id, entry);
    this.emit('change', id);
  }

  async stop(id) {
    const entry = this.loaded.get(id);
    if (!entry) return;
    this.loaded.delete(id);
    try {
      await entry.instance?.stop?.();
    } catch (err) {
      console.error(`Erweiterung "${id}" ließ sich nicht sauber beenden:`, err);
    }
    const prefix = path.join(this.dir, id) + path.sep;
    for (const key of Object.keys(require.cache)) if (key.startsWith(prefix)) delete require.cache[key];
    this.emit('change', id);
  }

  async remove(id) {
    if (!ID.test(id || '')) throw new Error('Ungültige Erweiterung.');
    await this.stop(id);
    await fs.rm(path.join(this.dir, id), { recursive: true, force: true });
  }

  async stopAll() {
    await Promise.all([...this.loaded.keys()].map((id) => this.stop(id)));
  }

  has(id) {
    return this.loaded.has(id);
  }

  get(id) {
    return this.loaded.get(id)?.api ?? null;
  }

  list() {
    return [...this.loaded.values()].map(({ info }) => info);
  }
}

module.exports = { ExtensionManager };
