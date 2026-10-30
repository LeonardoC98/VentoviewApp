const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  port: 47800,
  siteUrl: 'http://localhost:8080',
  autostart: true,
  trayHintShown: false,
  keywords: [], // eigene Keywords: [{ key, value }]
  // Sprache von App und Webseite: code + Zeitpunkt der Wahl (wer zuletzt gewählt hat, gewinnt beim Abgleich)
  language: { code: 'en', at: 0 },
};

class Config {
  constructor(file) {
    this.file = file;
    this.values = { ...DEFAULTS, ...readJson(file) };
  }

  get(key) {
    return this.values[key];
  }

  set(patch) {
    Object.assign(this.values, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Erst in eine Temp-Datei schreiben, damit ein Absturz die Einstellungen nicht zerstört
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

function readJson(file) {
  try {
    // BOM entfernen, falls die Datei mit einem Windows-Editor gespeichert wurde
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return {};
  }
}

module.exports = { Config, DEFAULTS };
