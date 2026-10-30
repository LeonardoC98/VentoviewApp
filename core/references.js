// Wo wird ein Name (eigenes Keyword, Zufallsgenerator, Zähler, Tastenkürzel …) benutzt – und beim Umbenennen
// überall mitziehen. Durchsucht alle gespeicherten Designs und die Texte der Chat-Bot-Elemente.
// Ein Name zählt als benutzt: {name} in einem Text (Groß/klein egal), als Variable einer Bedingung oder eines Feldes
// (key / keys / source / …Key) oder als Name eines Tastenkürzel-Auslösers (word).
'use strict';

const NAME_FIELDS = (prop) => prop === 'key' || prop === 'keys' || prop === 'source' || /Key$/.test(prop);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class References {
  constructor({ designs, modules }) {
    this.designs = designs;
    this.modules = modules;
  }

  // Treffer in einem Wert zählen – optional gleich ersetzen (rename: { from, to })
  walk(value, name, rename, prop = '', parent = null) {
    const lower = name.toLowerCase();
    const brace = new RegExp(`\\{${escape(name)}\\}`, 'gi');
    let hits = 0;
    const visit = (v, p, holder, slot) => {
      if (typeof v === 'string') {
        const n = (v.match(brace) || []).length;
        let next = v;
        if (n) {
          hits += n;
          if (rename) next = next.replace(brace, `{${rename}}`);
        }
        const exact = (NAME_FIELDS(p) || (p === 'word' && holder?.kind === 'shortcut')) && v.toLowerCase() === lower;
        if (exact) {
          hits += 1;
          if (rename) next = rename;
        }
        if (rename && next !== v && holder) holder[slot] = next;
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => visit(x, p, v, i));
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) visit(x, k, v, k);
      }
    };
    visit(value, prop, parent, null);
    return hits;
  }

  // → [{ where, count }] je Design bzw. Chat-Bot
  async usage(name) {
    const out = [];
    if (!name) return out;
    for (const info of await this.designs.list()) {
      const design = await this.designs.get({ id: info.id });
      if (!design) continue;
      const count = this.walk({ layers: design.layers, groups: design.groups, triggers: design.triggers, replay: design.replay, hide: design.hide }, name);
      if (count) out.push({ where: `Design „${design.name || 'Ohne Namen'}“`, count });
    }
    const blocks = this.modules.running.get('chatbot')?.settings?.blocks;
    if (Array.isArray(blocks)) {
      const count = this.walk(blocks.map((b) => ({ text: b.text })), name);
      if (count) out.push({ where: 'Chat-Bot', count });
    }
    return out;
  }

  // Alle Vorkommen von „from“ in „to“ umbenennen → Anzahl geänderter Designs/Bereiche
  async rename(from, to, { designsOnly = false } = {}) {
    if (!from || !to || from === to) return 0;
    let changed = 0;
    for (const info of await this.designs.list()) {
      const design = await this.designs.get({ id: info.id });
      if (!design) continue;
      const holder = { layers: design.layers, groups: design.groups, triggers: design.triggers, replay: design.replay, hide: design.hide };
      if (!this.walk(holder, from, to)) continue;
      Object.assign(design, holder);
      await this.designs.save({ design });
      changed += 1;
    }
    const entry = this.modules.running.get('chatbot');
    const blocks = !designsOnly && entry?.settings?.blocks;
    if (Array.isArray(blocks)) {
      const texts = blocks.map((b) => ({ text: b.text }));
      if (this.walk(texts, from, to)) {
        const next = blocks.map((b, i) => ({ ...b, text: texts[i].text }));
        await this.modules.saveSettings('chatbot', { ...entry.settings, blocks: next });
        changed += 1;
      }
    }
    return changed;
  }
}

module.exports = { References };
