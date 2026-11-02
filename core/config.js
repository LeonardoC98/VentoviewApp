const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  port: 47800,
  // Vorerst die Test-Adresse über ngrok – später die eigene Domain. Lokal: in den Einstellungen auf http://localhost:8080 stellen
  siteUrl: 'https://schnapps-trance-vitally.ngrok-free.dev',
  autostart: true,
  // Audio-Schutz: harte Obergrenze für allen Ton in Overlays und Editor (dBFS). Standard an – abschalten oder
  // lockern nur nach Warnung, der Zeitpunkt der Bestätigung steht in audioLimitRisk
  audioLimit: { on: true, ceiling: -6 },
  trayHintShown: false,
  keywords: [], // eigene Keywords: [{ key, value }]
  // Sprache von App und Webseite: code + Zeitpunkt der Wahl (wer zuletzt gewählt hat, gewinnt beim Abgleich)
  language: { code: 'en', at: 0 },
};

class Config {
  constructor(file) {
    this.file = file;
    const stored = readJson(file);
    // Die Test-Adresse (ngrok) stand früher in jeder Einstellungs-Datei – bringt die App inzwischen eine andere Adresse
    // mit (die echte Domain), gilt die neue. Eine bewusst eingestellte andere Adresse (z. B. localhost) bleibt.
    if (/\.ngrok(-free)?\.(app|dev|io)\b/.test(stored.siteUrl || '') && !/ngrok/.test(DEFAULTS.siteUrl)) delete stored.siteUrl;
    this.values = { ...DEFAULTS, ...stored };
  }

  get(key) {
    return this.values[key];
  }

  set(patch) {
    Object.assign(this.values, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Nur speichern, was vom Standard abweicht – sonst bliebe z. B. die Webseiten-Adresse für immer stehen, auch wenn
    // eine neue App-Version eine andere mitbringt
    const own = Object.fromEntries(Object.entries(this.values).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(DEFAULTS[key])));
    // Erst in eine Temp-Datei schreiben, damit ein Absturz die Einstellungen nicht zerstört
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(own, null, 2));
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
