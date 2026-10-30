// Sprachen für Webseite und App (dieselbe Datei liegt auch in der App unter ui/i18n.js).
// Deutsch ist der Originaltext im Code. Wörterbücher (i18n-dict.js) ordnen jedem deutschen Text die
// Übersetzungen zu: { "Speichern": ["Save", "Salva", "Guardar", "Enregistrer"] } – Reihenfolge en, it, es, fr.
// Texte mit Platzhaltern: "Verbunden als {0}" passt auf „Verbunden als Vento“. Für Sonderfälle: "re:<RegExp>".
// Übersetzt werden Textknoten und title/placeholder/aria-label – laufend (MutationObserver), auch was später
// dazukommt. Nicht angefasst: Eingaben, Code, die Overlay-Vorschau (.sh-stage) und alles mit data-no-i18n.
(function (root) {
  const LANGS = ['de', 'en', 'it', 'es', 'fr'];
  const NAMES = { de: 'Deutsch', en: 'English', it: 'Italiano', es: 'Español', fr: 'Français' };
  const exact = new Map();   // normalisierter deutscher Text → [en, it, es, fr]
  const patterns = [];       // [RegExp, [en, it, es, fr]]
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const SKIP = 'script, style, textarea, code, pre, kbd, .sh-stage, [data-no-i18n], [contenteditable]';
  let lang = 'de';
  // Im Overlay (Browser-Quelle im Stream) nur t() für Vorlagen – die Seite selbst nicht übersetzen, das kostet Zeit
  const domless = typeof location !== 'undefined' && location.pathname.startsWith('/overlay');
  let observer = null;
  const listeners = new Set();

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function add(dict) {
    for (const [src, list] of Object.entries(dict)) {
      if (src.startsWith('re:')) {
        patterns.push([new RegExp(`^${src.slice(3)}$`), list, null]);
      } else if (/\{\d\}/.test(src)) {
        // „Verbunden als {0}“ → /^Verbunden als (.+?)$/ – Platzhalter in der Übersetzung wieder einsetzen
        const order = [...norm(src).matchAll(/\{(\d)\}/g)].map((m) => Number(m[1]));
        const re = norm(src).split(/\{\d\}/).map(esc).join('([\\s\\S]+?)');
        patterns.push([new RegExp(`^${re}$`), list, order]);
        exact.set(norm(src), list);
      } else {
        exact.set(norm(src), list);
      }
    }
    if (lang !== 'de') refresh();
  }

  // Übersetzung eines Textes in die aktuelle Sprache – null, wenn keine bekannt ist
  function lookup(text) {
    if (lang === 'de') return null;
    const i = LANGS.indexOf(lang) - 1;
    const key = norm(text);
    if (!key) return null;
    return lookupOne(key, i) ?? lookupParts(key, i);
  }

  function lookupOne(key, i) {
    const hit = exact.get(key);
    if (hit && !/\{\d\}/.test(key)) return hit[i] ?? null;
    for (const [re, list, order] of patterns) {
      const m = re.exec(key);
      if (!m || list[i] == null) continue;
      // Eingesetzte Werte mit übersetzen, wenn sie selbst im Wörterbuch stehen (z. B. „Keyframe-Spur für „Höhe“ anlegen“)
      const fill = (v = '') => (v && exact.get(v)?.[i]) || v;
      if (!order) return list[i].replace(/\$(\d)/g, (_, n) => fill(m[Number(n)]));
      return list[i].replace(/\{(\d)\}/g, (_, n) => fill(m[order.indexOf(Number(n)) + 1]));
    }
    return null;
  }

  // Zusammengesetzte Beschriftungen wie „League of Legends · Solo/Duo: Tier-Farbe {tiercolorsoloduo}“: die Stücke
  // zwischen den Trennern einzeln übersetzen; eine Variable am Ende eines Stücks bleibt stehen
  const SPLIT = /( · | – |: )/;
  function lookupParts(key, i) {
    if (!SPLIT.test(key)) return null;
    let found = false;
    const out = key.split(SPLIT).map((part, n) => {
      if (n % 2) return part;
      const [, body, tail = ''] = part.match(/^(.*?)((?:\s*\{[\w.]+\})*)$/);
      const tr = body ? lookupOne(body, i) : null;
      if (tr == null) return part;
      found = true;
      return tr + tail;
    });
    return found ? out.join('') : null;
  }

  // Für Code: t('Speichern') bzw. t('Verbunden als {0}', name)
  function t(text, ...args) {
    const out = lookup(text) ?? text;
    return args.length ? out.replace(/\{(\d)\}/g, (_, n) => args[Number(n)] ?? '') : out;
  }

  function translateText(node) {
    const src = node.vvSrc ?? node.data;
    if (node.vvSet !== undefined && node.data !== node.vvSet) {
      // Der Code hat den Text inzwischen selbst geändert → das ist das neue Original
      node.vvSrc = node.data;
    } else if (node.vvSrc === undefined) {
      node.vvSrc = src;
    }
    const original = node.vvSrc;
    const tr = lookup(original);
    // Leerraum vorn und hinten behalten (Abstände zwischen Textstücken)
    const next = tr == null ? original : `${original.match(/^\s*/)[0]}${tr}${original.match(/\s*$/)[0]}`;
    if (node.data !== next) node.data = next;
    node.vvSet = next;
  }

  function translateAttrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const store = (el.vvAttr ||= {});
      const now = el.getAttribute(a);
      if (store[a] === undefined || (store[`${a}:set`] !== undefined && now !== store[`${a}:set`])) store[a] = now;
      const tr = lookup(store[a]);
      const next = tr ?? store[a];
      if (now !== next) el.setAttribute(a, next);
      store[`${a}:set`] = next;
    }
  }

  function skip(el) {
    return !el || (el.closest && el.closest(SKIP));
  }

  function walk(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) {
      if (!skip(rootNode.parentElement)) translateText(rootNode);
      return;
    }
    if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9 && rootNode.nodeType !== 11) return;
    if (rootNode.nodeType === 1 && skip(rootNode)) return;
    if (rootNode.nodeType === 1) translateAttrs(rootNode);
    const tw = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.nodeType === 3) translateText(n);
      else translateAttrs(n);
    }
  }

  function refresh() {
    if (typeof document === 'undefined' || !document.documentElement || domless) return;
    if (document.title) {
      document.vvTitle ??= document.title;
      const tr = lookup(document.vvTitle);
      document.title = tr ?? document.vvTitle;
    }
    document.documentElement.lang = lang;
    walk(document.body || document.documentElement);
  }

  function observe() {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver((list) => {
      if (lang === 'de') return;
      for (const m of list) {
        if (m.type === 'characterData') {
          if (!skip(m.target.parentElement)) translateText(m.target);
        } else if (m.type === 'attributes') {
          if (!skip(m.target)) translateAttrs(m.target);
        } else {
          for (const n of m.addedNodes) walk(n);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  // Native Rückfragen (confirm/alert/prompt) gehen am DOM vorbei – deshalb hier übersetzen
  if (typeof window !== 'undefined') {
    for (const name of ['confirm', 'alert', 'prompt']) {
      const orig = window[name]?.bind(window);
      if (!orig) continue;
      window[name] = (msg, ...rest) => orig(typeof msg === 'string' ? msg.split('\n').map((line) => (line.trim() ? t(line) : line)).join('\n') : msg, ...rest);
    }
  }

  function setLang(code) {
    const next = LANGS.includes(code) ? code : 'en';
    if (next === lang) return;
    lang = next;
    refresh();
    for (const fn of listeners) fn(lang);
  }

  // Sprache der Webseite (Browser) – mit Zeitstempel, damit App und Webseite sich auf die neueste Wahl einigen
  const KEY = 'vv-lang';
  function stored() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && LANGS.includes(v.code)) return v;
    } catch { /* kein Speicher */ }
    return null;
  }
  function browserLang() {
    for (const l of (typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : [])) {
      const code = String(l || '').slice(0, 2).toLowerCase();
      if (LANGS.includes(code)) return code;
    }
    return 'en';
  }
  const clients = new Set(); // Verbindungen zur App auf dieser Seite
  function choose(code, { at = Date.now(), save = true, push = true } = {}) {
    if (save) {
      try { localStorage.setItem(KEY, JSON.stringify({ code, at })); } catch { /* egal */ }
    }
    setLang(code);
    // Auf der Webseite gewählt → auch die App umstellen
    if (push) for (const c of clients) if (c.connected) c.request('app.language.set', { code, at }).catch(() => {});
  }

  // Sprachwahl-Felder (<select class="lang-pick">) in Kopf- oder Fußzeile
  function bindPickers() {
    for (const sel of document.querySelectorAll('select.lang-pick')) {
      if (sel.vvBound) { sel.value = lang; continue; }
      sel.vvBound = true;
      if (!sel.options.length) for (const code of LANGS) sel.append(new Option(NAMES[code], code));
      sel.value = lang;
      sel.addEventListener('change', () => choose(sel.value));
    }
  }
  listeners.add(() => { if (typeof document !== 'undefined') bindPickers(); });

  // Mit der App abgleichen: wer zuletzt gewählt hat, gewinnt
  async function syncWithApp(client) {
    clients.add(client);
    try {
      const app = await client.request('app.language');
      const mine = stored();
      if (app && LANGS.includes(app.code) && (!mine || (app.at || 0) > mine.at)) {
        choose(app.code, { at: app.at || Date.now(), push: false });
      } else if (mine && (!app || mine.at > (app.at || 0))) {
        await client.request('app.language.set', { code: mine.code, at: mine.at });
      }
    } catch { /* ältere App ohne Sprachen */ }
  }

  const api = { LANGS, NAMES, add, t, setLang, choose, syncWithApp, get lang() { return lang; }, onChange: (fn) => listeners.add(fn), refresh, stored, browserLang };
  root.VVI18n = api;

  if (typeof document !== 'undefined' && !domless) {
    const start = () => {
      observe();
      refresh();
      bindPickers();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
  // Webseite: gespeicherte Wahl oder Browsersprache. Die App setzt ihre Sprache selbst (setLang aus dem Zustand).
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    const s = stored();
    lang = s ? s.code : browserLang();
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }
})(typeof window !== 'undefined' ? window : globalThis);
