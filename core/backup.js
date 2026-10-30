const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const MAGIC = 'VVIEW1';
const FORMAT = 'ventoview-backup';
// Was gesichert wird (Ordner in den App-Daten) – Modul-Code und Erweiterungen nicht: die lädt die App selbst,
// und fremder Code aus einer Datei darf nie ausgeführt werden
const DIRS = ['designs', 'assets', 'module-data'];
// Verbindungen bleiben auf diesem PC: mit ihnen könnte jeder, der die Datei bekommt, das Konto benutzen
const LOCAL_ONLY = ['account', 'twitch', 'trayHintShown'];
const MAX_FILES = 20000;

/**
 * Komplette Sicherung der App-Daten als .vview: Designs, eigene Medien, Modul-Einstellungen und -Daten,
 * Keywords, Home-Anordnung und App-Einstellungen.
 * Aufbau (gzip): „VVIEW1\n“, Länge des Inhaltsverzeichnisses + „\n“, Inhaltsverzeichnis (JSON), dann die Dateien
 * nacheinander in der Reihenfolge des Verzeichnisses.
 */
class Backup {
  constructor({ userData, config, version, documents }) {
    this.userData = userData;
    this.config = config;
    this.version = version;
    this.dir = path.join(documents, 'Ventoview', 'Sicherungen');
  }

  async files() {
    const list = [];
    const walk = async (rel) => {
      let entries = [];
      try {
        entries = await fsp.readdir(path.join(this.userData, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() && !entry.name.endsWith('.tmp') && !entry.name.endsWith('.part')) {
          const { size } = await fsp.stat(path.join(this.userData, child));
          list.push({ path: child, size });
        }
      }
    };
    for (const dir of DIRS) await walk(dir);
    return list;
  }

  async save(file) {
    const files = await this.files();
    const config = { ...this.config.values };
    for (const key of LOCAL_ONLY) delete config[key];
    const manifest = Buffer.from(JSON.stringify({ format: FORMAT, version: 1, app: this.version, createdAt: new Date().toISOString(), config, files }));
    const userData = this.userData;
    async function* chunks() {
      yield Buffer.from(`${MAGIC}\n${manifest.length}\n`);
      yield manifest;
      for (const f of files) {
        // Größe wie im Verzeichnis: wurde die Datei inzwischen kürzer/länger, auffüllen bzw. abschneiden
        let sent = 0;
        for await (const chunk of fs.createReadStream(path.join(userData, f.path))) {
          const part = chunk.subarray(0, Math.max(0, f.size - sent));
          sent += part.length;
          if (part.length) yield part;
          if (sent >= f.size) break;
        }
        if (sent < f.size) yield Buffer.alloc(f.size - sent);
      }
    }
    const tmp = `${file}.part`;
    await pipeline(Readable.from(chunks()), zlib.createGzip(), fs.createWriteStream(tmp));
    await fsp.rename(tmp, file);
    return { file, files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) };
  }

  // Sicherung lesen und prüfen – noch nichts überschreiben
  async read(file) {
    const raw = zlib.gunzipSync(await fsp.readFile(file));
    const first = raw.indexOf(10);
    const second = raw.indexOf(10, first + 1);
    if (raw.subarray(0, first).toString() !== MAGIC) throw new Error('Das ist keine Ventoview-Sicherung (.vview).');
    const length = Number(raw.subarray(first + 1, second).toString());
    const manifest = JSON.parse(raw.subarray(second + 1, second + 1 + length).toString('utf8'));
    if (manifest.format !== FORMAT || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) throw new Error('Die Sicherung ist beschädigt.');
    let offset = second + 1 + length;
    const files = manifest.files.map((f) => {
      const rel = String(f.path || '');
      // Nur in die gesicherten Ordner, nie nach außen
      if (!DIRS.includes(rel.split('/')[0]) || rel.split('/').some((part) => part === '..' || part === '') || path.isAbsolute(rel)) {
        throw new Error('Die Sicherung enthält ungültige Dateipfade.');
      }
      const size = Number(f.size) || 0;
      const data = raw.subarray(offset, offset + size);
      offset += size;
      if (data.length !== size) throw new Error('Die Sicherung ist unvollständig.');
      return { path: rel, data };
    });
    const commands = (manifest.config?.keywords || []).filter((k) => k?.source === 'command' || k?.source === 'python').map((k) => k.key);
    return { manifest, files, commands };
  }

  // Alles ersetzen: Ordner leeren, Dateien schreiben, Einstellungen übernehmen (Verbindungen dieses PCs bleiben)
  async restore(backup) {
    const staging = path.join(this.userData, '.restore');
    await fsp.rm(staging, { recursive: true, force: true });
    for (const f of backup.files) {
      const target = path.join(staging, ...f.path.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, f.data);
    }
    for (const dir of DIRS) {
      await fsp.rm(path.join(this.userData, dir), { recursive: true, force: true });
      const from = path.join(staging, dir);
      if (fs.existsSync(from)) await fsp.rename(from, path.join(this.userData, dir));
      else await fsp.mkdir(path.join(this.userData, dir), { recursive: true });
    }
    await fsp.rm(staging, { recursive: true, force: true });
    const keep = Object.fromEntries(LOCAL_ONLY.map((key) => [key, this.config.get(key)]));
    const next = { ...backup.manifest.config };
    for (const key of LOCAL_ONLY) delete next[key];
    // Alte Einstellungen ganz ersetzen (nicht nur ergänzen), Verbindungen behalten
    for (const key of Object.keys(this.config.values)) if (!(key in next) && !LOCAL_ONLY.includes(key)) delete this.config.values[key];
    this.config.set({ ...next, ...keep });
  }

  // Vor dem Laden automatisch den jetzigen Stand sichern
  async autoBackup() {
    await fsp.mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-');
    return this.save(path.join(this.dir, `Automatisch vor dem Laden ${stamp}.vview`));
  }
}

module.exports = { Backup };
