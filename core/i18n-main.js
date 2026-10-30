// Übersetzungen für das Hauptprogramm (Tray-Menü, Hinweise, Datei-Fenster). Nutzt dasselbe Wörterbuch wie die
// Oberfläche (ui/i18n-dict.js): deutscher Text → [English, Italiano, Español, Français].
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LANGS = ['de', 'en', 'it', 'es', 'fr'];
let dict = null;

function load() {
  if (dict) return dict;
  dict = {};
  try {
    const code = fs.readFileSync(path.join(__dirname, '..', 'ui', 'i18n-dict.js'), 'utf8');
    vm.runInNewContext(code, { VVI18n: { add: (d) => Object.assign(dict, d) } });
  } catch (err) {
    console.error('Übersetzungen konnten nicht geladen werden:', err.message);
  }
  return dict;
}

// tr('en', 'Update {0} installieren', '1.9.0') → „Install update 1.9.0“
function tr(lang, text, ...args) {
  const i = LANGS.indexOf(lang) - 1;
  const hit = i >= 0 ? load()[text] : null;
  const out = hit?.[i] || text;
  return out.replace(/\{(\d)\}/g, (_, n) => args[Number(n)] ?? '');
}

module.exports = { tr, LANGS };
