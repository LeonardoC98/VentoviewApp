// Bibliothek aus dem Hub: Vorlagen und Effekt-Pakete (in config.library), Medien landen bei den eigenen Medien.
// Pro-Inhalte lädt die App mit ihrem Lizenzschein – der Server liefert sie nur bei aktivem Ventoview Pro.
// Standard-Vorlagen der Module lassen sich im Editor ausblenden (hidden) und über den Hub zurückholen.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MEDIA_EXT = { '.png': 'image', '.jpg': 'image', '.gif': 'image', '.webp': 'image', '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.m4a': 'audio', '.mp4': 'video', '.webm': 'video', '.mov': 'video' };
const MAX_JSON = 2 * 1024 * 1024;
const MAX_MEDIA = 60 * 1024 * 1024;
const text = (v, max) => String(v ?? '').slice(0, max);

class Library {
  constructor({ config, designs, account, siteUrl }) {
    this.config = config;
    this.designs = designs;
    this.account = account;
    this.siteUrl = siteUrl; // () => string
  }

  state() {
    const lib = this.config.get('library') || {};
    return {
      templates: Array.isArray(lib.templates) ? lib.templates : [],
      effects: Array.isArray(lib.effects) ? lib.effects : [],
      hidden: Array.isArray(lib.hidden) ? lib.hidden : [],
    };
  }

  save(next) {
    this.config.set({ library: next });
    return next;
  }

  async fetchFrom(rel, auth) {
    const res = await fetch(new URL(rel, this.siteUrl()), { cache: 'no-store', headers: auth ? this.account.authHeader() : {} });
    if (res.status === 403) throw new Error('Das gibt es nur mit Ventoview Pro – im Shop abonnieren, dann klappt es.');
    if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}).`);
    return res;
  }

  async import(id) {
    const index = await (await this.fetchFrom('library/index.json')).json();
    const item = (Array.isArray(index) ? index : []).find((x) => x.id === id);
    if (!item) throw new Error('Diesen Eintrag gibt es im Hub nicht mehr.');
    const lib = this.state();

    // Standard-Vorlage: nur wieder einblenden – sie steckt ohnehin im Modul
    if (item.standard) {
      this.save({ ...lib, hidden: lib.hidden.filter((k) => k !== `${item.module}:${item.name}`) });
      return { type: 'template', name: item.name, restored: true };
    }
    const pro = item.plan === 'pro';
    if (pro && !this.account.license?.pro) throw new Error('Das gibt es nur mit Ventoview Pro – im Shop abonnieren, dann klappt es.');
    const res = await this.fetchFrom(item.path, pro);

    if (item.type === 'template' || item.type === 'effect') {
      const raw = Buffer.from(await res.arrayBuffer());
      if (raw.length > MAX_JSON) throw new Error('Der Eintrag ist zu groß.');
      const data = JSON.parse(raw.toString('utf8'));
      if (item.type === 'template') {
        if (!Array.isArray(data.design?.layers)) throw new Error('Diese Vorlage ist beschädigt.');
        const entry = { id: item.id, name: text(item.name, 80), description: text(item.description, 300), module: text(item.module, 40), plan: item.plan, design: data.design, addedAt: Date.now() };
        this.save({ ...lib, templates: [...lib.templates.filter((t) => t.id !== item.id), entry] });
        return { type: 'template', name: entry.name };
      }
      if (!Array.isArray(data.fx) || !data.fx.length) throw new Error('Dieses Effekt-Paket ist beschädigt.');
      const fx = data.fx.slice(0, 12).filter((f) => f && typeof f.type === 'string').map((f) => JSON.parse(JSON.stringify(f)));
      const entry = { id: item.id, name: text(item.name, 80), description: text(item.description, 300), category: text(item.category, 20), plan: item.plan, fx, addedAt: Date.now() };
      this.save({ ...lib, effects: [...lib.effects.filter((e) => e.id !== item.id), entry] });
      return { type: 'effect', name: entry.name };
    }

    if (item.type === 'media') {
      const ext = path.extname(String(item.file || '')).toLowerCase();
      const kind = MEDIA_EXT[ext];
      if (!kind) throw new Error('Unbekannte Mediendatei.');
      const content = Buffer.from(await res.arrayBuffer());
      if (content.length > MAX_MEDIA) throw new Error('Die Datei ist zu groß.');
      // Schon übernommen? Dann nicht doppelt ablegen
      const known = Object.entries(await this.designs.readIndex()).find(([, info]) => info.hub === item.id);
      if (known) return { type: 'media', name: item.name, file: known[0], already: true };
      const file = `${crypto.randomBytes(16).toString('hex')}${ext === '.jpg' ? '.jpg' : ext}`;
      await fs.writeFile(path.join(this.designs.assetsDir, file), content);
      await this.designs.updateIndex((idx) => {
        idx[file] = { name: text(item.name, 120), kind, size: content.length, addedAt: Date.now(), hub: item.id };
      });
      return { type: 'media', name: item.name, file };
    }
    throw new Error('Unbekannter Hub-Eintrag.');
  }

  // Aus Vorlagen bzw. Effekten entfernen; Standard-Vorlagen werden nur ausgeblendet
  remove({ kind, id, module, name } = {}) {
    const lib = this.state();
    if (kind === 'template') return this.save({ ...lib, templates: lib.templates.filter((t) => t.id !== id) });
    if (kind === 'effect') return this.save({ ...lib, effects: lib.effects.filter((e) => e.id !== id) });
    if (kind === 'standard') {
      const key = `${text(module, 40)}:${text(name, 120)}`;
      return this.save({ ...lib, hidden: [...new Set([...lib.hidden, key])] });
    }
    throw new Error('Unbekannte Art.');
  }
}

module.exports = { Library };
