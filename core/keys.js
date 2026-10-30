// Globale Tastendrücke (auch wenn ein Spiel im Vordergrund ist) – über uiohook-napi.
// Läuft nur, solange ein Modul zuhört (z. B. Basic mit eingeschalteter Tasten-Anzeige), und gibt nur
// Tastenname + gedrückt/losgelassen weiter. Nichts wird gespeichert.
'use strict';

const MOUSE_NAMES = { 1: 'Linksklick', 2: 'Rechtsklick', 3: 'Mausrad-Klick' };

class KeyWatch {
  constructor() {
    this.listeners = new Set();
    this.hook = null;
    this.names = null;
    this.error = null;
  }

  // fn({ type: 'down' | 'up', code, name }) – gibt eine Abmelde-Funktion zurück
  on(fn) {
    this.listeners.add(fn);
    this.start();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.stop();
    };
  }

  start() {
    if (this.hook?.running) return;
    try {
      if (!this.hook) {
        const { uIOhook, UiohookKey } = require('uiohook-napi');
        this.names = Object.fromEntries(Object.entries(UiohookKey).map(([name, code]) => [code, name]));
        const emit = (type) => (e) => {
          const event = { type, code: e.keycode, name: this.names[e.keycode] || `Taste ${e.keycode}` };
          for (const fn of this.listeners) {
            try {
              fn(event);
            } catch (err) {
              console.error('Tasten-Zuhörer:', err);
            }
          }
        };
        uIOhook.on('keydown', emit('down'));
        uIOhook.on('keyup', emit('up'));
        // Maustasten: 1 links, 2 rechts, 3 Mitte (Mausrad), 4/5 … Zusatztasten
        const mouse = (type) => (e) => {
          const event = { type, device: 'mouse', code: e.button, name: MOUSE_NAMES[e.button] || `Maus ${e.button}` };
          for (const fn of this.listeners) {
            try {
              fn(event);
            } catch (err) {
              console.error('Tasten-Zuhörer:', err);
            }
          }
        };
        uIOhook.on('mousedown', mouse('down'));
        uIOhook.on('mouseup', mouse('up'));
        this.hook = { api: uIOhook, running: false };
      }
      this.hook.api.start();
      this.hook.running = true;
      this.error = null;
    } catch (err) {
      this.error = err.message;
      console.error('Tastenerkennung startet nicht:', err);
    }
  }

  // Nächste gedrückte Taste oder Maustaste aufnehmen (für „Extra-Taste hinzufügen“).
  // known = die Taste erkennt Ventoview ohnehin (normale Taste bzw. linke/rechte/mittlere Maustaste)
  capture(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let off = null;
      const timer = setTimeout(() => { off?.(); reject(new Error('Keine Taste gedrückt – bitte noch einmal.')); }, timeoutMs);
      off = this.on((e) => {
        if (e.type !== 'down') return;
        clearTimeout(timer);
        setTimeout(() => off(), 0);
        const known = e.device === 'mouse' ? e.code >= 1 && e.code <= 3 : !/^Taste \d+$/.test(e.name);
        resolve({ device: e.device === 'mouse' ? 'maus' : 'key', code: e.code, name: e.name, known });
      });
      if (this.error) {
        clearTimeout(timer);
        off();
        reject(new Error(`Tastenerkennung startet nicht: ${this.error}`));
      }
    });
  }

  stop() {
    if (!this.hook?.running) return;
    try {
      this.hook.api.stop();
    } catch {
      // schon gestoppt
    }
    this.hook.running = false;
  }
}

module.exports = { KeyWatch };
