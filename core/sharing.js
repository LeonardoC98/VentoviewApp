const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const FORMAT = 'ventoview-export';
const MANIFEST = 'ventoview-export.json';
const MEDIA_FILE = /^[a-f0-9]{32}\.(png|jpg|gif|webp|mp4|webm|mov|mp3|wav|ogg|m4a)$/;
const HUB_PATH = /^hub\/[\w-]{1,60}\/$/;
const LAYOUTS = ['grid', 'list', 'ring'];
const SIZES = ['s', 'm', 'l'];

/**
 * Vorlagen teilen: ein Export ist ein Ordner mit ventoview-export.json (Designs, auf Wunsch Home-Einstellungen)
 * und media/ mit allen eigenen Bildern, Videos und Tönen, die die Designs benutzen.
 * Zum Importieren legt man den Ordner in Dokumente\Ventoview\Teilen – dort listet die App ihn auf.
 */
class Sharing {
  constructor({ designs, config, siteUrl, documents }) {
    this.designs = designs;
    this.config = config;
    this.siteUrl = siteUrl;
    this.shareDir = path.join(documents, 'Ventoview', 'Teilen');
  }

  async ensureShareDir() {
    await fs.mkdir(this.shareDir, { recursive: true });
  }

  // Für die App: eigene Designs zum Exportieren und Ordner, die im Teilen-Ordner zum Import bereitliegen
  async overview() {
    await this.ensureShareDir();
    const folders = [];
    for (const entry of await fs.readdir(this.shareDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const data = JSON.parse(await fs.readFile(path.join(this.shareDir, entry.name, MANIFEST), 'utf8'));
        if (data.format !== FORMAT) continue;
        folders.push({ dir: path.join(this.shareDir, entry.name), name: entry.name, designs: (data.designs || []).map((d) => d.name), home: Boolean(data.home), media: (data.media || []).length });
      } catch {
        // Kein Export-Ordner
      }
    }
    return { shareDir: this.shareDir, designs: await this.designs.list(), folders };
  }

  async exportTo({ ids = [], home = false, name = '' }) {
    if (!ids.length && !home) throw new Error('Wähle mindestens eine Vorlage oder die Home-Einstellungen.');
    const designs = [];
    const queue = [...ids];
    while (queue.length) {
      const design = await this.designs.get({ id: queue.shift() });
      if (!design || designs.some((d) => d.id === design.id)) continue;
      designs.push(design);
      // Eingebettete gespeicherte Designs (Modul Link) gehören mit dazu
      walk(design, (node) => { if (node.kind === 'saved' && node.id) queue.push(node.id); });
    }
    const files = new Set();
    for (const design of designs) walk(design, (node) => { if (node.kind === 'asset' && MEDIA_FILE.test(node.file || '')) files.add(node.file); });
    // Fotos der Home-Kacheln kommen mit, wenn die Home-Einstellungen exportiert werden
    if (home) for (const photo of Object.values(this.config.get('home')?.photos || {})) if (MEDIA_FILE.test(photo?.file || '')) files.add(photo.file);

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    const folder = safeName(name) || `Ventoview ${stamp}`;
    const dir = await freeDir(path.join(this.shareDir, folder));
    await fs.mkdir(path.join(dir, 'media'), { recursive: true });

    const index = await this.designs.readIndex();
    const media = [];
    for (const file of files) {
      try {
        await fs.copyFile(path.join(this.designs.assetsDir, file), path.join(dir, 'media', file));
        media.push({ file, name: index[file]?.name || file, kind: index[file]?.kind || null });
      } catch {
        // Datei wurde gelöscht – das Design zeigt an der Stelle dann nichts
      }
    }
    const data = {
      format: FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      designs: designs.map(({ updatedAt, ...design }) => design),
      // (Fotos der Home-Kacheln stehen in media, die Verweise in home.photos)
      media,
      home: home ? this.config.get('home') || null : undefined,
    };
    await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify(data, null, 2));
    return dir;
  }

  async importFrom(dir) {
    let data;
    try {
      data = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8'));
    } catch {
      throw new Error(`In diesem Ordner liegt keine ${MANIFEST}. Wähle den Ordner, den Ventoview beim Exportieren erstellt hat.`);
    }
    return this.apply(data, async (file) => fs.readFile(path.join(dir, 'media', file)));
  }

  // Vorlage aus dem Hub der Webseite (/hub/<name>/) – gleiches Format, Dateien kommen per HTTP
  async importFromSite(rel) {
    if (!HUB_PATH.test(rel)) throw new Error('Ungültige Hub-Vorlage.');
    const base = new URL(rel, this.siteUrl());
    const get = async (name) => {
      const res = await fetch(new URL(name, base), { cache: 'no-store' });
      if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}).`);
      return Buffer.from(await res.arrayBuffer());
    };
    const data = JSON.parse((await get(MANIFEST)).toString('utf8'));
    return this.apply(data, (file) => get(`media/${file}`));
  }

  async apply(data, readMedia) {
    if (data?.format !== FORMAT || !Array.isArray(data.designs)) throw new Error('Das ist kein Ventoview-Export.');

    let media = 0;
    const index = await this.designs.readIndex();
    for (const item of data.media || []) {
      if (!MEDIA_FILE.test(item.file || '')) continue;
      const target = path.join(this.designs.assetsDir, item.file);
      if (index[item.file]) continue; // schon da (gleicher zufälliger Name = gleiche Datei)
      const content = await readMedia(item.file).catch(() => null);
      if (!content) continue;
      await fs.writeFile(target, content);
      await this.designs.updateIndex((idx) => {
        idx[item.file] = { name: String(item.name || item.file).slice(0, 120), kind: item.kind || kindOf(item.file), size: content.length, addedAt: Date.now() };
      });
      media++;
    }

    // Vorhandene Designs nie überschreiben: bei gleicher ID eine neue vergeben und Verweise anpassen
    const ids = new Map();
    for (const design of data.designs) {
      ids.set(design.id, (await this.designs.get({ id: design.id })) ? crypto.randomBytes(8).toString('hex') : design.id);
    }
    const saved = [];
    for (const design of data.designs) {
      const copy = JSON.parse(JSON.stringify(design));
      walk(copy, (node) => { if (node.kind === 'saved' && ids.has(node.id)) node.id = ids.get(node.id); });
      copy.id = ids.get(design.id);
      saved.push(await this.designs.save({ design: copy }));
    }

    let home = false;
    if (data.home) {
      this.config.set({ home: this.cleanHome(data.home) });
      home = true;
    }
    return { saved, media, home };
  }

  // Home-Bildschirm der Webseite: Anordnung (Raster, Liste, Ring), Reihenfolge, Größe je Modul, Ring mit/ohne Namen
  cleanHome(input) {
    const home = input && typeof input === 'object' ? input : {};
    const sizes = {};
    for (const [id, size] of Object.entries(home.sizes || {})) {
      if (/^[\w-]{1,40}$/.test(id) && SIZES.includes(size)) sizes[id] = size;
    }
    const pos = {};
    for (const [id, at] of Object.entries(home.pos || {})) {
      const [c, r] = Array.isArray(at) ? at.map(Number) : [];
      if (/^[\w-]{1,40}$/.test(id) && Number.isInteger(c) && Number.isInteger(r) && c >= 1 && c <= 60 && r >= 1 && r <= 100) pos[id] = [c, r];
    }
    const photos = {};
    for (const [id, p] of Object.entries(home.photos || {}).slice(0, 40)) {
      if (!/^photo_[a-z0-9]{4,20}$/.test(id)) continue;
      const link = typeof p?.link === 'string' && /^https?:\/\/\S+$/i.test(p.link) ? p.link.slice(0, 500) : null;
      const title = typeof p?.title === 'string' ? p.title.trim().slice(0, 40) : '';
      photos[id] = { title, link, file: MEDIA_FILE.test(p?.file || '') ? p.file : null, fit: ['contain', 'cover', 'fill'].includes(p?.fit) ? p.fit : 'cover', caption: p?.caption === true };
    }
    // Ordner im Schachbrett: { folder_xxx: { name, items: [Modul-ID oder photo_…] } }
    const folders = {};
    for (const [id, f] of Object.entries(home.folders || {}).slice(0, 40)) {
      if (!/^folder_[a-z0-9]{4,20}$/.test(id)) continue;
      const items = (Array.isArray(f?.items) ? f.items : []).map(String).filter((x) => /^[\w-]{1,40}$/.test(x) && !x.startsWith('folder_')).slice(0, 100);
      folders[id] = { name: typeof f?.name === 'string' ? f.name.trim().slice(0, 40) : 'Ordner', items: [...new Set(items)] };
    }
    return {
      layout: LAYOUTS.includes(home.layout) ? home.layout : 'grid',
      order: (Array.isArray(home.order) ? home.order : []).filter((id) => /^[\w-]{1,40}$/.test(id)).slice(0, 100),
      sizes,
      labels: home.labels !== false, // Ring: mit Namen oder nur Symbole
      locked: home.locked === true, // gesperrt: im Home lässt sich nichts verschieben
      pos, // Schachbrett: frei gesetzte Kacheln { id: [Spalte, Zeile] }
      photos, // Schachbrett: Items { photo_xxx: { title, link, file, fit, caption } }
      folders, // Schachbrett: Ordner { folder_xxx: { name, items } }
    };
  }
}

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const value of Object.values(node)) walk(value, fn);
}

function safeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 60);
}

async function freeDir(dir) {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? dir : `${dir} (${i})`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

function kindOf(file) {
  const ext = file.split('.').pop();
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio';
  return 'image';
}

module.exports = { Sharing };
