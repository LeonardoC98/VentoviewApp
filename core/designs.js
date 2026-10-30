const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DESIGN_ID = /^[a-z0-9]{8,32}$/;
const ASSET_FILE = /^[a-f0-9]{32}\.(png|jpg|gif|webp|mp4|webm|mov|mp3|wav|ogg|m4a)$/;
const MB = 1024 * 1024;
const TYPES = {
  'image/png': { ext: 'png', kind: 'image', max: 10 * MB },
  'image/jpeg': { ext: 'jpg', kind: 'image', max: 10 * MB },
  'image/gif': { ext: 'gif', kind: 'image', max: 25 * MB },
  'image/webp': { ext: 'webp', kind: 'image', max: 10 * MB },
  'video/mp4': { ext: 'mp4', kind: 'video', max: 200 * MB },
  'video/webm': { ext: 'webm', kind: 'video', max: 200 * MB },
  'video/quicktime': { ext: 'mov', kind: 'video', max: 500 * MB },
  'audio/mpeg': { ext: 'mp3', kind: 'audio', max: 30 * MB },
  'audio/mp3': { ext: 'mp3', kind: 'audio', max: 30 * MB },
  'audio/wav': { ext: 'wav', kind: 'audio', max: 50 * MB },
  'audio/x-wav': { ext: 'wav', kind: 'audio', max: 50 * MB },
  'audio/wave': { ext: 'wav', kind: 'audio', max: 50 * MB },
  'audio/ogg': { ext: 'ogg', kind: 'audio', max: 30 * MB },
  'audio/mp4': { ext: 'm4a', kind: 'audio', max: 30 * MB },
  'audio/x-m4a': { ext: 'm4a', kind: 'audio', max: 30 * MB },
};
const MAX_DESIGN = 512 * 1024;

/**
 * Speichert Overlay-Designs und eigene Medien (Bilder, Videos) lokal auf dem PC.
 *   <dir>/designs/<id>.json
 *   <dir>/assets/<zufall>.<ext>  +  assets/index.json mit Originalnamen
 */
class DesignStore {
  constructor(dir) {
    this.designsDir = path.join(dir, 'designs');
    this.assetsDir = path.join(dir, 'assets');
    this.indexFile = path.join(this.assetsDir, 'index.json');
    this.indexQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.designsDir, { recursive: true });
    await fs.mkdir(this.assetsDir, { recursive: true });
  }

  async list() {
    const designs = [];
    for (const name of await fs.readdir(this.designsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await fs.readFile(path.join(this.designsDir, name), 'utf8'));
        designs.push({ id: d.id, name: d.name, modules: d.modules, width: d.width, height: d.height, updatedAt: d.updatedAt });
      } catch {
        // Kaputte Datei überspringen statt die ganze Liste scheitern zu lassen
      }
    }
    return designs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get({ id }) {
    if (!DESIGN_ID.test(id || '')) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.designsDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  async save({ design }) {
    if (!design || typeof design !== 'object' || !Array.isArray(design.layers)) {
      throw new Error('Ungültiges Design.');
    }
    const id = DESIGN_ID.test(design.id || '') ? design.id : crypto.randomBytes(8).toString('hex');
    const saved = { ...design, id, updatedAt: Date.now() };
    const json = JSON.stringify(saved);
    if (json.length > MAX_DESIGN) throw new Error('Das Design ist zu groß.');
    await writeAtomic(path.join(this.designsDir, `${id}.json`), json);
    return saved;
  }

  async remove({ id }) {
    if (!DESIGN_ID.test(id || '')) throw new Error('Ungültige Design-ID.');
    await fs.rm(path.join(this.designsDir, `${id}.json`), { force: true });
  }

  async listAssets() {
    const index = await this.readIndex();
    return Object.entries(index)
      .map(([file, info]) => ({ file, ...info }))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  async addAsset({ name, mime, length, stream }) {
    const type = TYPES[mime];
    if (!type) throw new Error('Nur PNG, JPG, GIF, WebP, MP4, WebM, MP3, WAV, OGG oder M4A werden unterstützt.');
    const tooBig = new Error(`Die Datei ist zu groß (höchstens ${type.max / MB} MB).`);
    if (length > type.max) throw tooBig;

    const file = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
    const target = path.join(this.assetsDir, file);
    const part = `${target}.part`;
    let size = 0;
    try {
      await pipeline(
        stream,
        new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            callback(size > type.max ? tooBig : null, chunk);
          },
        }),
        createWriteStream(part),
      );
      if (!size) throw new Error('Die Datei ist leer.');
      await fs.rename(part, target);
    } catch (err) {
      await fs.rm(part, { force: true });
      throw err;
    }

    const info = { name: String(name || file).slice(0, 120), kind: type.kind, size, addedAt: Date.now() };
    await this.updateIndex((index) => { index[file] = info; });
    return { file, ...info };
  }

  async removeAsset({ file }) {
    if (!ASSET_FILE.test(file || '')) throw new Error('Ungültiger Dateiname.');
    await fs.rm(path.join(this.assetsDir, file), { force: true });
    await this.updateIndex((index) => { delete index[file]; });
  }

  assetPath(file) {
    return ASSET_FILE.test(file) ? path.join(this.assetsDir, file) : null;
  }

  async readIndex() {
    try {
      return JSON.parse(await fs.readFile(this.indexFile, 'utf8'));
    } catch {
      return {};
    }
  }

  // Änderungen am Index nacheinander ausführen, damit parallele Uploads sich nicht überschreiben
  updateIndex(change) {
    this.indexQueue = this.indexQueue.catch(() => {}).then(async () => {
      const index = await this.readIndex();
      change(index);
      await writeAtomic(this.indexFile, JSON.stringify(index, null, 2));
    });
    return this.indexQueue;
  }
}

async function writeAtomic(file, content) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

module.exports = { DesignStore };
