const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');

const MAX_LENGTH = 500;
const SOURCES = {
  text: { min: 0, fallback: 0 },
  file: { min: 1, fallback: 2 },
  command: { min: 2, fallback: 30 },
  url: { min: 5, fallback: 30 },
};

/**
 * Eigene Keywords der Grund-App. Jedes hat eine Quelle:
 *   text     fester Wert
 *   file     Inhalt einer Textdatei (z. B. von einem anderen Stream-Tool geschrieben)
 *   command  Ausgabe eines PowerShell-Befehls
 *   url      Antwort einer Webadresse, optional ein Feld daraus (JSON-Pfad wie "data.title")
 * Dynamische Quellen werden alle `interval` Sekunden neu gelesen.
 */
class KeywordSources {
  constructor({ onChange }) {
    this.onChange = onChange;
    this.values = {};
    this.errors = {};
    this.children = {}; // Keyword → aus JSON-Ausgabe erzeugte Unter-Keywords (keyword_feld)
    this.timers = [];
    this.generation = 0;
  }

  apply(list) {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.generation += 1;
    this.values = {};
    this.errors = {};
    this.children = {};
    for (const keyword of list) {
      if (keyword.source === 'text' || !SOURCES[keyword.source]) {
        this.values[keyword.key] = keyword.value;
        continue;
      }
      this.values[keyword.key] = '';
      const run = this.reader(keyword, this.generation);
      run();
      this.timers.push(setInterval(run, keyword.interval * 1000));
    }
    this.onChange();
  }

  reader(keyword, generation) {
    let busy = false;
    return async () => {
      if (busy) return; // langsamer Befehl → nicht überlappend starten
      busy = true;
      let value;
      let error = null;
      try {
        value = String(await READERS[keyword.source](keyword)).trim().slice(0, MAX_LENGTH);
      } catch (err) {
        error = err.message.split(/\r?\n/)[0].trim().slice(0, 200);
      }
      busy = false;
      if (generation !== this.generation) return; // Einstellungen wurden inzwischen geändert
      const before = JSON.stringify([this.values, this.errors]);
      if (error) {
        this.errors[keyword.key] = error;
      } else {
        this.values[keyword.key] = value;
        delete this.errors[keyword.key];
        this.setChildren(keyword.key, keyword.path ? null : value);
      }
      if (JSON.stringify([this.values, this.errors]) !== before) this.onChange();
    };
  }

  // Ist die Ausgabe ein JSON-Objekt, wird jedes Feld zu einem eigenen Keyword: pc + {"gpu": …} → pc_gpu
  setChildren(key, output) {
    let data = null;
    if (output && output.startsWith('{')) {
      try {
        data = JSON.parse(output);
      } catch {
        data = null;
      }
    }
    for (const child of this.children[key] || []) delete this.values[child];
    this.children[key] = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    for (const [field, raw] of Object.entries(data)) {
      const child = `${key}_${field}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 48);
      if (child in this.values && !this.children[key].includes(child)) continue; // eigenes Keyword hat Vorrang
      this.values[child] = (raw !== null && typeof raw === 'object' ? JSON.stringify(raw) : String(raw ?? '')).slice(0, MAX_LENGTH);
      this.children[key].push(child);
    }
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.generation += 1;
  }
}

const READERS = {
  file: async ({ target }) => fs.readFile(target, 'utf8'),

  command: ({ target }) => new Promise((resolve, reject) => {
    const [shell, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', target]]
      : ['/bin/sh', ['-c', target]];
    execFile(shell, args, { timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(stdout);
    });
  }),

  url: async ({ target, path }) => {
    const res = await fetch(target, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json, text/plain, */*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (!path) return body;
    const value = jsonPath(JSON.parse(body), path);
    if (value === undefined || value === null) throw new Error(`Feld „${path}“ nicht gefunden`);
    return typeof value === 'object' ? JSON.stringify(value) : value;
  },
};

/**
 * Einfacher JSON-Pfad:
 *   data.title            Feld in Feld
 *   items[0].name         Element einer Liste
 *   **[Text=CPU Package]  irgendwo im Baum das erste Objekt, dessen Feld „Text“ genau so heißt
 *   **[Text~Tctl]         … dessen Feld „Text“ das Wort enthält (Groß-/Kleinschreibung egal)
 */
function jsonPath(root, path) {
  let value = root;
  for (const part of path.match(/\*\*\[[^\]]+\]|\[\d+\]|[^.[\]]+/g) || []) {
    if (part.startsWith('**[')) {
      const [, field, op, wanted] = /^\*\*\[([^=~]+)([=~])(.*)\]$/.exec(part) || [];
      if (!field) return undefined;
      value = deepFind(value, field.trim(), op, wanted.trim().toLowerCase());
    } else if (part.startsWith('[')) {
      value = value?.[Number(part.slice(1, -1))];
    } else {
      value = value?.[part];
    }
    if (value === undefined) return undefined;
  }
  return value;
}

function deepFind(node, field, op, wanted) {
  const queue = [node];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const own = current[field];
    if (typeof own === 'string' || typeof own === 'number') {
      const text = String(own).toLowerCase();
      if (op === '=' ? text === wanted : text.includes(wanted)) return current;
    }
    for (const child of Object.values(current)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return undefined;
}

// Eingaben aus der Oberfläche prüfen und vereinheitlichen
function normalizeKeywords(list) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const key = String(item.key || '').trim().toLowerCase();
    if (!key) continue;
    if (!/^[a-z0-9_]{1,32}$/.test(key)) throw new Error(`„${key}“: nur a–z, 0–9 und _ erlaubt (max. 32 Zeichen).`);
    if (key.startsWith('modul_')) throw new Error(`„${key}“: „modul_“ ist reserviert.`);
    if (seen.has(key)) throw new Error(`„${key}“ gibt es doppelt.`);
    seen.add(key);

    const source = SOURCES[item.source] ? item.source : 'text';
    const entry = { key, source };
    if (source === 'text') {
      entry.value = String(item.value ?? '').slice(0, MAX_LENGTH);
    } else {
      const target = String(item.target ?? '').trim().slice(0, 2000);
      if (!target) throw new Error(`„${key}“: bitte ${source === 'file' ? 'eine Datei' : source === 'url' ? 'eine Webadresse' : 'einen Befehl'} angeben.`);
      if (source === 'url' && !/^https?:\/\//i.test(target)) throw new Error(`„${key}“: die Webadresse muss mit http:// oder https:// beginnen.`);
      entry.target = target;
      const { min, fallback } = SOURCES[source];
      entry.interval = Math.max(min, Math.min(3600, Math.round(Number(item.interval) || fallback)));
      if (source === 'url') {
        const path = String(item.path ?? '').trim();
        if (path.length > 200 || /[\u0000-\u001f]/.test(path)) throw new Error(`„${key}“: ungültiger JSON-Pfad.`);
        entry.path = path;
      }
    }
    result.push(entry);
  }
  return result;
}

module.exports = { KeywordSources, normalizeKeywords, jsonPath, SOURCES };
