const api = window.streamhub;
const $ = (id) => document.getElementById(id);

let state = null;
let toastTimer;

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

function showError(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}

async function run(action, ...args) {
  const res = await api[action](...args);
  if (!res.ok) showError(res.error);
  return res;
}

function tile(mod) {
  const badge = mod.badge || mod.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3);
  return h('div', { class: 'tile', style: mod.accent ? `--tile:${mod.accent}` : null }, badge);
}

function gearIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z');
  svg.append(path);
  return svg;
}

function installedCard(mod) {
  const status = mod.status || { state: 'idle', text: '' };
  return h('div', { class: 'card' },
    tile(mod),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-title' },
        mod.name,
        h('small', {}, `v${mod.version}`),
        mod.update && h('span', { class: 'badge' }, `Update ${mod.update}`),
      ),
      h('div', { class: 'card-status' }, h('span', { class: `dot ${status.state}` }), status.text),
    ),
    h('div', { class: 'card-actions' },
      mod.settings?.length && h('button', { class: 'btn icon-only', type: 'button', title: 'Einstellungen', 'aria-label': 'Einstellungen', onclick: () => openModuleSettings(mod.id) }, gearIcon()),
      mod.locked
        ? h('button', { class: 'btn primary', type: 'button', onclick: () => run('openAccount') }, state.account?.connected ? 'Freischalten' : 'Konto verbinden')
        : mod.needsExtension && !mod.inactive
          ? h('button', { class: 'btn primary', type: 'button', onclick: () => openExtensionWizard(mod) }, 'Erweiterung einrichten')
          : h('button', { class: 'btn primary', type: 'button', disabled: mod.inactive, onclick: () => run('openModule', mod.id) }, 'Overlay einrichten'),
      mod.update && h('button', {
        class: 'btn', type: 'button', disabled: mod.busy, onclick: () => run('install', mod.id),
      }, mod.busy ? 'Lädt …' : 'Aktualisieren'),
      !mod.locked && h('label', { class: 'active-switch', title: mod.inactive ? 'Modul ist aus – einschalten' : 'Modul ist an – ausschalten' },
        h('span', { class: 'switch' },
          h('input', { type: 'checkbox', checked: mod.inactive ? null : true, disabled: mod.busy, onchange: (e) => run('setActive', mod.id, e.target.checked) }),
          h('span')),
      ),
    ),
  );
}

// Modul braucht eine App-Erweiterung (z. B. Tastenkürzel): Schritt für Schritt erklären
function openExtensionWizard(mod) {
  const ext = mod.requires || {};
  const close = () => $('moduleDialog').close();
  $('moduleDialog').replaceChildren(
    h('div', { class: 'dialog-head' }, h('h3', {}, ext.name || 'Erweiterung'), h('button', { type: 'button', class: 'btn ghost', onclick: close }, '×')),
    h('div', { class: 'wizard' },
      h('p', {}, `„${mod.name}“ braucht eine Erweiterung, die die App auf deinem PC erweitert${ext.why ? ` – ${ext.why}` : ''}. Sie gehört zu deinem Kauf und wird nur geladen, wenn du sie brauchst.`),
      h('ol', {},
        h('li', {}, h('b', {}, 'Herunterladen: '), 'Die Datei ', h('code', {}, `${ext.extension}.vvext`), ' gibt es nach dem Kauf auf der Webseite. ',
          h('button', { type: 'button', class: 'btn small', onclick: () => run('downloadExtension', ext.extension) }, 'Download öffnen')),
        h('li', {}, h('b', {}, 'Einsetzen: '), 'Hier die heruntergeladene Datei auswählen (meist im Ordner „Downloads“). Die App prüft die Unterschrift und legt sie zu ihren Modulen. ',
          h('button', {
            type: 'button', class: 'btn small primary',
            onclick: async () => {
              const res = await run('installExtension');
              if (res.ok && res.result) close();
            },
          }, 'Datei auswählen …')),
        h('li', {}, h('b', {}, 'Fertig: '), 'Das Modul startet von selbst. Die Datei in „Downloads“ kannst du danach löschen.'),
      ),
    ),
  );
  $('moduleDialog').showModal();
}

function availableCard(mod) {
  const plan = (mod.plan || 'free') === 'free' ? h('span', { class: 'plan free' }, 'Gratis') : h('span', { class: 'plan premium' }, 'Premium');
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      tile(mod),
      h('div', { class: 'card-title' }, mod.name, h('small', {}, `v${mod.version}`), plan),
    ),
    h('p', { class: 'card-desc' }, mod.description),
    mod.unsupported
      ? h('button', { class: 'btn', type: 'button', disabled: true, title: 'Erst die App aktualisieren (Einstellungen → Updates)' }, `Braucht App ${mod.minApp}`)
      : mod.locked
        ? h('button', { class: 'btn', type: 'button', onclick: () => run('openAccount') }, state.account?.connected ? 'Freischalten' : 'Erst Konto verbinden')
        // Freigeschaltete Module lädt die App von selbst – der Knopf nur, falls das gerade hängt
        : h('button', { class: 'btn primary', type: 'button', disabled: mod.busy, onclick: () => run('setActive', mod.id, true) }, mod.busy ? 'Wird geladen …' : 'Aktivieren'),
  );
}

function render() {
  const { bridge, installed, available, registryError, version } = state;

  const dot = $('service').querySelector('.dot');
  dot.className = `dot ${bridge.error ? 'error' : 'ok'}`;
  $('serviceText').textContent = bridge.error || `Lokaler Dienst aktiv · Port ${bridge.port}`;

  $('installed').replaceChildren(...(installed.length
    ? installed.map(installedCard)
    : [h('div', { class: 'empty' }, state.account?.connected ? 'Module werden geladen …' : 'Verbinde die App mit deinem Konto (Einstellungen) – deine Module erscheinen dann von selbst.')]));

  let discover;
  if (registryError) {
    discover = [h('div', { class: 'empty error' }, registryError)];
  } else if (!available.length) {
    discover = [h('div', { class: 'empty' }, installed.length ? 'Du hast schon alle Module.' : 'Lade Module …')];
  } else {
    discover = available.map(availableCard);
  }
  $('available').replaceChildren(...discover);

  renderAccount();
  renderTwitch();
  renderExtensions();
  $('about').textContent = `Ventoview ${version}${state.installed ? '' : ' · nicht installiert (Test- oder Entwicklungsversion)'}`;
  renderUpdate();
  if (!$('tab-keywords').hidden) updateKeywordPreviews();
  updateSuggestions();
}

// Geladene App-Erweiterungen (.vvext)
function renderExtensions() {
  const list = state.extensions || [];
  $('extensionList').replaceChildren(...(list.length
    ? list.map((ext) => h('div', { class: 'row' },
      h('span', {}, h('strong', {}, ext.name || ext.id), h('small', {}, `Version ${ext.version} · ${ext.id}.vvext`)),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { if (confirm(`„${ext.name}“ entfernen? Module, die sie brauchen, laufen dann nicht.`)) run('removeExtension', ext.id); } }, 'Entfernen'),
    ))
    : [h('div', { class: 'row last' }, h('small', {}, 'Keine Erweiterungen. Braucht ein Modul eine, sagt dir die App Bescheid.'))]));
}

// Vorlagen teilen: Export als Ordner, Import aus Dokumente\Ventoview\Teilen
async function renderSharing() {
  const res = await api.shareList();
  if (!res.ok) return showError(res.error);
  const { designs, folders, shareDir } = res.result;
  $('shareDir').textContent = shareDir;
  $('shareDesigns').replaceChildren(...(designs.length
    ? designs.map((d) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: d.id }), h('span', {}, d.name || 'Ohne Namen'), h('small', {}, (d.modules || []).join(', '))))
    : [h('small', {}, 'Noch keine gespeicherten Vorlagen – im Editor auf der Webseite speichern.')]));
  $('shareFolders').replaceChildren(...(folders.length
    ? folders.map((f) => h('div', { class: 'row' },
      h('span', {}, h('strong', {}, f.name), h('small', {}, [f.designs.join(', ') || 'keine Vorlagen', f.home ? ' · Home' : '', f.media ? ` · ${f.media} Medien` : ''].join(''))),
      h('button', { type: 'button', class: 'btn', onclick: () => importShare(f.dir) }, 'Importieren'),
    ))
    : [h('div', { class: 'row last' }, h('small', {}, 'Hier liegt noch nichts. Leg einen Export-Ordner in den Teilen-Ordner.'))]));
}

async function importShare(dir) {
  const res = await run('shareImport', dir);
  if (!res.ok || !res.result) return;
  const { designs, media, home } = res.result;
  $('shareMessage').textContent = `Importiert: ${designs} Vorlage${designs === 1 ? '' : 'n'}, ${media} Medien${home ? ', Home-Einstellungen' : ''}. Du findest sie im Editor unter „Öffnen“.`;
  renderSharing();
}

// Ventoview-Konto: ohne Verbindung laufen keine Module
function renderAccount() {
  const acc = state.account || {};
  const panel = $('accountPanel');
  if (acc.connected) {
    const until = new Date(acc.expires).toLocaleDateString('de-DE');
    panel.replaceChildren(
      h('div', { class: 'connection-text' },
        h('b', {}, 'Ventoview-Konto'),
        h('span', {}, h('span', { class: 'dot ok' }), `Verbunden als ${acc.name} · ${acc.modules.length} Module frei · gültig bis ${until} (erneuert sich von selbst)`),
      ),
      h('div', { class: 'connection-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => run('openAccount') }, 'Konto'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { if (confirm('App vom Konto trennen? Module laufen dann nicht mehr.')) run('disconnectAccount'); } }, 'Trennen'),
      ),
    );
    return;
  }
  // Eingabe beim Neuzeichnen behalten
  const old = panel.querySelector('input');
  const input = old || h('input', { type: 'text', placeholder: 'K7F2-9Q3X', maxlength: '9', class: 'code-input' });
  const pair = async () => {
    const res = await run('pairAccount', input.value.trim());
    if (res.ok) input.value = '';
  };
  if (!old) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });
  panel.replaceChildren(
    h('div', { class: 'connection-text' },
      h('b', {}, 'Ventoview-Konto'),
      h('span', {}, h('span', { class: 'dot warn' }), acc.error || 'Nicht verbunden – auf der Kontoseite anmelden und „Diesen PC verbinden“ klicken. Oder den Code von dort eingeben:'),
    ),
    h('div', { class: 'connection-actions' },
      input,
      h('button', { class: 'btn', type: 'button', onclick: pair }, 'Verbinden'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => run('openAccount') }, 'Zur Kontoseite'),
    ),
  );
}

// Twitch-Verbindung für Chat-Befehle, Bits, Abos, Follower und Kanalpunkte
function renderTwitch() {
  const tw = state.twitch || { status: 'off' };
  const panel = $('twitchPanel');
  const text = {
    off: 'Nicht verbunden – nötig für Twitch-Chat und Alerts (Bits, Abos, Follows, Raids, Kanalpunkte).',
    error: tw.error,
    connected: `Verbunden als ${tw.login}`,
  }[tw.status];
  panel.replaceChildren(
    h('div', { class: 'connection-text' },
      h('b', {}, 'Twitch'),
      tw.status === 'pending'
        ? h('span', {}, 'Im Browser auf twitch.tv/activate den Code ', h('code', { class: 'code' }, tw.code), ' bestätigen …')
        : h('span', {}, h('span', { class: `dot ${tw.status === 'connected' ? 'ok' : tw.status === 'error' ? 'error' : 'idle'}` }), text),
    ),
    h('div', { class: 'connection-actions' },
      tw.status === 'connected'
        ? h('button', { class: 'btn ghost', type: 'button', onclick: () => run('disconnectTwitch') }, 'Trennen')
        : tw.status === 'pending'
          ? h('button', { class: 'btn ghost', type: 'button', onclick: () => run('cancelTwitch') }, 'Abbrechen')
          : h('button', { class: 'btn twitch', type: 'button', onclick: () => run('connectTwitch') }, 'Mit Twitch verbinden'),
    ),
  );
}

function renderUpdate() {
  const { status, version, progress, error } = state.update;
  const texts = {
    disabled: 'Automatische Updates gibt es nur in der installierten App.',
    idle: 'Wird geprüft …',
    checking: 'Suche nach Updates …',
    latest: `Du hast die neueste Version (${state.version}).`,
    downloading: `Version ${version} wird geladen … ${progress ?? 0} %`,
    ready: `Version ${version} ist bereit und wird beim Beenden installiert.`,
    error: error || 'Update-Prüfung fehlgeschlagen.',
  };
  $('updateText').textContent = texts[status];
  $('updateText').classList.toggle('error', status === 'error');
  $('checkUpdateBtn').disabled = ['disabled', 'checking', 'downloading', 'ready'].includes(status);
  $('installUpdateBtn').hidden = status !== 'ready';

  const pill = $('updatePill');
  pill.hidden = !['downloading', 'ready'].includes(status);
  pill.classList.toggle('ready', status === 'ready');
  pill.textContent = status === 'ready' ? `Update ${version} installieren` : `Update ${version} … ${progress ?? 0} %`;
  pill.title = status === 'ready' ? 'Ventoview schließt sich kurz und startet in der neuen Version' : '';
}

$('updatePill').addEventListener('click', () => {
  if (state.update.status === 'ready') run('installUpdate');
});
$('installUpdateBtn').addEventListener('click', () => run('installUpdate'));
$('checkUpdateBtn').addEventListener('click', () => run('checkUpdate'));

function fillSettings() {
  const form = $('settingsForm');
  form.port.value = state.settings.port;
  form.siteUrl.value = state.settings.siteUrl;
  form.autostart.checked = state.settings.autostart;
  form.autostart.disabled = !state.installed;
  $('autostartHint').textContent = state.installed
    ? 'Ventoview startet beim Hochfahren unsichtbar im Tray.'
    : 'Nur in der installierten App verfügbar.';
}

// ---------- Modul-Einstellungen ----------

let settingsModule = null;

function openModuleSettings(id) {
  const mod = state.installed.find((m) => m.id === id);
  if (!mod) return;
  settingsModule = id;
  const values = mod.settingsValues || {};
  const fields = mod.settings.map((field) => {
    let control;
    if (field.type === 'hotkeys') {
      control = hotkeyEditor(field, values[field.key] || []);
    } else if (field.type === 'randomizers') {
      control = randomizerEditor(field, values[field.key] || []);
    } else if (field.type === 'dials') {
      control = dialEditor(field, values[field.key] || []);
    } else if (field.type === 'lines') {
      control = h('textarea', { name: field.key, rows: 6, spellcheck: 'false', placeholder: field.placeholder || '' }, (values[field.key] || []).join('\n'));
    } else if (field.type === 'toggle') {
      control = h('span', { class: 'switch' }, h('input', { type: 'checkbox', name: field.key, checked: values[field.key] ? true : null }), h('span'));
    } else {
      control = h('input', { type: field.type === 'number' ? 'number' : 'text', name: field.key, value: values[field.key] ?? '' });
    }
    return h('div', { class: `setting${field.type === 'toggle' ? ' inline' : ''}`, 'data-key': field.key },
      h('div', { class: 'setting-label' }, h('strong', {}, field.label), field.help ? h('small', {}, field.help) : null),
      control,
      field.type === 'lines' ? h('div', { class: 'suggestions' }) : null,
    );
  });
  const message = h('span', { class: 'message', role: 'status' });
  const form = h('form', { class: 'settings-form' },
    ...fields,
    h('div', { class: 'actions' },
      message,
      h('button', { type: 'button', class: 'btn ghost', onclick: () => $('moduleDialog').close() }, 'Abbrechen'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Speichern'),
    ),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = {};
    for (const field of mod.settings) {
      const el = form.querySelector(`[name="${field.key}"]`);
      input[field.key] = field.type === 'toggle' ? el.checked : ['hotkeys', 'dials', 'randomizers'].includes(field.type) ? JSON.parse(el.value) : el.value;
    }
    const res = await api.saveModuleSettings(id, input);
    message.classList.toggle('error', !res.ok);
    message.textContent = res.ok ? 'Gespeichert.' : res.error;
    if (res.ok) setTimeout(() => $('moduleDialog').close(), 500);
  });
  $('moduleDialog').replaceChildren(
    h('div', { class: 'dialog-head' }, h('h3', {}, `${mod.name} – Einstellungen`), h('button', { type: 'button', class: 'btn ghost', onclick: () => $('moduleDialog').close() }, '×')),
    form,
  );
  $('moduleDialog').showModal();
  updateSuggestions();
}

// Tastenkürzel aufnehmen: Name eingeben, „Aufnehmen“, Tasten drücken → „results = Ctrl+Alt+R“
const KEY_NAMES = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' };

function accelerator(event) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(event.key)) return null;
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');
  let key = KEY_NAMES[event.key] || event.key;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
  else if (/^Numpad\d$/.test(event.code)) key = `num${event.code.slice(6)}`;
  else if (key.length === 1) key = key.toUpperCase();
  // Einzelne Tasten ohne Strg/Alt würden beim Tippen und Zocken ständig auslösen
  if (!parts.length && !/^F\d{1,2}$/.test(key) && !/^num\d$/.test(key)) return '';
  return [...parts, key].join('+');
}

// Controller-/MIDI-Eingaben lesbar machen: pad:b0 → „Controller A / ✕“, midi:cc74 → „MIDI-Regler CC 74“
const PAD_NAMES = ['A / ✕', 'B / ○', 'X / □', 'Y / △', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2', 'Back / Share', 'Start / Options',
  'Linker Stick drücken', 'Rechter Stick drücken', 'Steuerkreuz ↑', 'Steuerkreuz ↓', 'Steuerkreuz ←', 'Steuerkreuz →', 'Home / PS'];
const AXIS_NAMES = ['Linker Stick ↔', 'Linker Stick ↕', 'Rechter Stick ↔', 'Rechter Stick ↕'];

function inputLabel(id) {
  let m = /^pad:b(\d+)$/.exec(id);
  if (m) return `🎮 ${PAD_NAMES[m[1]] || `Taste ${Number(m[1]) + 1}`}`;
  m = /^pad:a(\d+)$/.exec(id);
  if (m) return `🎮 ${AXIS_NAMES[m[1]] || `Achse ${Number(m[1]) + 1}`}`;
  m = /^midi:n(\d+)$/.exec(id);
  if (m) return `🎹 MIDI-Pad/Note ${m[1]}`;
  m = /^midi:cc(\d+)$/.exec(id);
  if (m) return `🎹 MIDI-Regler CC ${m[1]}`;
  if (id === 'midi:pb') return '🎹 Pitch-Bend';
  return id;
}

// Nächste Eingabe am Controller/MIDI-Gerät abwarten (kind: 'button' oder 'value')
async function recordInput(button, kind) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = kind === 'value' ? 'Regler/Stick bewegen …' : 'Taste am Controller drücken …';
  const res = await api.recordInput(kind);
  button.disabled = false;
  button.textContent = old;
  if (!res.ok) {
    showError(res.error);
    return null;
  }
  if (!res.result) showError('Nichts erkannt – ist das Gerät angeschlossen? Gamepads einmal kurz eine Taste drücken lassen.');
  return res.result;
}

function hotkeyEditor(field, lines) {
  const list = lines.map((line) => {
    const i = line.indexOf('=');
    return { name: line.slice(0, i).trim(), keys: line.slice(i + 1).trim() };
  }).filter((x) => x.name && x.keys);
  const hidden = h('input', { type: 'hidden', name: field.key });
  const rows = h('div', { class: 'hotkeys' });
  const nameInput = h('input', { type: 'text', placeholder: 'Name, z. B. results', maxlength: '40' });
  const recordBtn = h('button', { type: 'button', class: 'btn primary', title: 'Tastatur' }, 'Aufnehmen');
  // Taste an Gamepad oder MIDI-Gerät statt Tastatur
  const padBtn = h('button', { type: 'button', class: 'btn', title: 'Gamepad (Xbox, PS4 …) oder MIDI-Gerät' }, '🎮 Controller');
  let stopRecording = null;
  padBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim().replace(/=/g, '');
    if (!name) return nameInput.focus();
    if (list.some((x) => x.name.toLowerCase() === name.toLowerCase())) return showError(`„${name}“ gibt es schon.`);
    const keys = await recordInput(padBtn, 'button');
    if (!keys) return;
    if (list.some((x) => x.keys === keys)) return showError(`${inputLabel(keys)} ist schon vergeben.`);
    list.push({ name, keys });
    nameInput.value = '';
    sync();
  });

  const sync = () => {
    hidden.value = JSON.stringify(list.map((x) => `${x.name} = ${x.keys}`));
    rows.replaceChildren(...(list.length ? list.map((x) => h('div', { class: 'hotkey' },
      h('b', {}, x.name), h('kbd', {}, /^(pad|midi):/.test(x.keys) ? inputLabel(x.keys) : x.keys),
      h('button', { type: 'button', class: 'btn ghost small', title: 'Löschen', onclick: () => { list.splice(list.indexOf(x), 1); sync(); } }, '×'),
    )) : [h('div', { class: 'empty small' }, 'Noch keine Tastenkürzel.')]));
  };

  recordBtn.addEventListener('click', () => {
    if (stopRecording) return stopRecording();
    const name = nameInput.value.trim().replace(/=/g, '');
    if (!name) return nameInput.focus();
    if (list.some((x) => x.name.toLowerCase() === name.toLowerCase())) return showError(`„${name}“ gibt es schon.`);
    recordBtn.textContent = 'Tasten drücken … (Esc = abbrechen)';
    const onKey = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape' && !event.ctrlKey && !event.altKey) return stopRecording();
      const keys = accelerator(event);
      if (keys === null) return;
      if (!keys) return showError('Bitte mit Strg, Alt oder Shift kombinieren (oder F1–F24).');
      if (list.some((x) => x.keys === keys)) return showError(`${keys} ist schon vergeben.`);
      list.push({ name, keys });
      nameInput.value = '';
      sync();
      stopRecording();
    };
    stopRecording = () => {
      window.removeEventListener('keydown', onKey, true);
      recordBtn.textContent = 'Aufnehmen';
      stopRecording = null;
    };
    window.addEventListener('keydown', onKey, true);
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); recordBtn.click(); } });
  sync();
  return h('div', { class: 'hotkey-editor' }, rows, h('div', { class: 'hotkey-new' }, nameInput, recordBtn, padBtn), hidden);
}

// Zufallsgeneratoren (Chat-Bot): je ein Befehl wie !lucky, ein Antworttext mit {treffer} und Einträge mit Chance
const RANDOM_MODES = [['reply', 'Antwort an den Nutzer'], ['all', 'An alle'], ['whisper', 'Als Whisper'], ['none', 'Kein Befehl (nur als Variable)']];
const CHANCES = [[0, 'Nie'], [0.1, 'Sehr selten'], [0.33, 'Selten'], [1, 'Normal'], [3, 'Häufig'], [10, 'Sehr häufig']];

function randomizerEditor(field, initial) {
  const list = JSON.parse(JSON.stringify(initial));
  const hidden = h('input', { type: 'hidden', name: field.key });
  const wrap = h('div', { class: 'randomizers' });
  const open = new Set(list.length === 1 ? [0] : []);
  const sync = () => { hidden.value = JSON.stringify(list); };

  const draw = () => {
    sync();
    wrap.replaceChildren(...list.map((r, index) => {
      const total = r.entries.reduce((sum, e) => sum + (Number(e.weight) || 0), 0) || 1;
      const chance = (e) => `${((Number(e.weight) || 0) / total * 100).toFixed((Number(e.weight) || 0) / total < 0.01 ? 2 : 1)} %`;
      const input = (key, attrs = {}) => h('input', {
        type: 'text', value: r[key] ?? '', ...attrs,
        oninput: (e) => { r[key] = attrs.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value; sync(); },
      });
      const isOpen = open.has(index);
      return h('div', { class: 'rnd' },
        h('div', { class: 'rnd-head' },
          h('button', { type: 'button', class: 'btn ghost small', onclick: () => { if (isOpen) open.delete(index); else open.add(index); draw(); } }, isOpen ? '▾' : '▸'),
          h('b', {}, `🎲 ${r.command || r.name}`),
          h('small', { class: 'muted' }, `${r.entries.length} Einträge · {zufall_${r.name}}`),
          h('button', { type: 'button', class: 'btn ghost small', title: 'Zufallsgenerator löschen', onclick: () => { if (confirm(`„${r.command || r.name}“ löschen?`)) { list.splice(index, 1); open.delete(index); draw(); } } }, '×')),
        isOpen ? h('div', { class: 'rnd-body' },
          h('div', { class: 'rnd-grid' },
            h('label', {}, 'Befehl', input('command', { placeholder: '!lucky' })),
            h('label', {}, 'Name (Variable)', input('name', { placeholder: 'lucky', title: 'Ergibt {zufall_name} – auch in anderen Befehlen, Timern und Tastenkürzeln nutzbar' })),
            h('label', {}, 'Abklingzeit (s)', input('cooldown', { type: 'number', min: 0, placeholder: 'Standard' })),
            h('label', {}, 'Antwort-Art', h('select', { onchange: (e) => { r.mode = e.target.value; sync(); } },
              ...RANDOM_MODES.map(([value, label]) => h('option', { value, selected: r.mode === value ? true : null }, label)))),
          ),
          h('label', { class: 'rnd-text' }, 'Antworttext – {treffer} ist der gezogene Eintrag, dazu {user} und alle Variablen', input('text', { placeholder: '🍀 {treffer}' })),
          h('div', { class: 'rnd-entries' },
            h('div', { class: 'rnd-entry head' }, h('span', {}, 'Eintrag'), h('span', {}, 'Chance'), h('span', {}, '')),
            ...r.entries.map((e, i) => h('div', { class: 'rnd-entry' },
              h('input', { type: 'text', value: e.text, oninput: (ev) => { e.text = ev.target.value; sync(); } }),
              h('span', { class: 'rnd-chance' },
                h('select', {
                  title: 'Wie oft der Eintrag im Vergleich zu den anderen kommt',
                  onchange: (ev) => { e.weight = Number(ev.target.value); draw(); },
                }, ...CHANCES.map(([value, label]) => h('option', { value, selected: Number(e.weight ?? 1) === value ? true : null }, label)),
                  CHANCES.some(([value]) => value === Number(e.weight ?? 1)) ? null : h('option', { value: e.weight, selected: true }, `×${e.weight}`)),
                h('small', {}, chance(e))),
              h('button', { type: 'button', class: 'btn ghost small', title: 'Eintrag löschen', onclick: () => { r.entries.splice(i, 1); draw(); } }, '×'))),
          ),
          h('div', { class: 'rnd-actions' },
            h('button', { type: 'button', class: 'btn small', onclick: () => { r.entries.push({ text: '', weight: 1 }); draw(); wrap.querySelector('.rnd-entry:last-child input')?.focus(); } }, '+ Eintrag'),
            h('button', {
              type: 'button', class: 'btn small', title: 'Viele Einträge auf einmal: eine Zeile pro Eintrag',
              onclick: () => {
                const text = prompt('Einträge einfügen – einer pro Zeile (kommen zu den vorhandenen dazu):');
                if (!text) return;
                for (const line of text.split(/\r?\n/)) if (line.trim()) r.entries.push({ text: line.trim(), weight: 1 });
                draw();
              },
            }, 'Mehrere einfügen …'),
            h('button', { type: 'button', class: 'btn small ghost', onclick: () => { r.entries.forEach((e) => { e.weight = 1; }); draw(); } }, 'Alle gleich oft'),
          ),
        ) : null,
      );
    }), h('button', {
      type: 'button', class: 'btn',
      onclick: () => {
        list.push({ name: `zufall${list.length + 1}`, command: '', cooldown: null, mode: 'reply', text: '🎲 {treffer}', entries: [] });
        open.add(list.length - 1);
        draw();
      },
    }, '+ Zufallsgenerator'));
  };
  draw();
  return h('div', { class: 'randomizer-editor' }, wrap, hidden);
}

// Regler 1–8: je ein Drehknopf, Fader, Stick oder Trigger → {regler1} … {regler8}
function dialEditor(field, lines) {
  const map = {};
  for (const line of lines) {
    const i = line.indexOf('=');
    const n = Number(line.slice(0, i));
    if (n >= 1 && n <= 8) map[n] = line.slice(i + 1).trim();
  }
  const hidden = h('input', { type: 'hidden', name: field.key });
  const rows = h('div', { class: 'hotkeys' });
  const sync = () => {
    hidden.value = JSON.stringify(Object.entries(map).map(([n, id]) => `${n} = ${id}`));
    rows.replaceChildren(...Array.from({ length: 8 }, (_, k) => {
      const n = k + 1;
      const assign = h('button', { type: 'button', class: 'btn small' }, map[n] ? 'Ändern' : 'Zuweisen');
      assign.addEventListener('click', async () => {
        const id = await recordInput(assign, 'value');
        if (!id) return;
        for (const key of Object.keys(map)) if (map[key] === id) delete map[key];
        map[n] = id;
        sync();
      });
      return h('div', { class: 'hotkey' },
        h('b', {}, `Regler ${n}`), h('code', {}, `{regler${n}}`),
        map[n] ? h('kbd', {}, inputLabel(map[n])) : h('small', { class: 'muted' }, 'frei'),
        assign,
        map[n] ? h('button', { type: 'button', class: 'btn ghost small', title: 'Lösen', onclick: () => { delete map[n]; sync(); } }, '×') : null);
    }));
  };
  sync();
  return h('div', { class: 'hotkey-editor' }, rows, hidden);
}

// Vorschläge (z. B. gerade erkannte Quellen) live aktualisieren, ohne die Eingaben anzufassen
function updateSuggestions() {
  if (!settingsModule || !$('moduleDialog').open) return;
  const mod = state.installed.find((m) => m.id === settingsModule);
  for (const box of $('moduleDialog').querySelectorAll('.setting')) {
    const target = box.querySelector('.suggestions');
    if (!target) continue;
    const area = box.querySelector('textarea');
    const list = mod?.suggestions?.[box.dataset.key] || [];
    const present = new Set(area.value.split(/\r?\n/).map((l) => l.trim().toLowerCase()));
    target.replaceChildren(
      list.length ? h('small', {}, 'Gerade erkannt – zum Hinzufügen klicken:') : h('small', {}, 'Starte etwas, dann erscheinen hier die erkannten Quellen.'),
      ...list.map((item) => h('button', {
        type: 'button', class: `chip${present.has(item.toLowerCase()) ? ' added' : ''}`,
        onclick: () => {
          if (!present.has(item.toLowerCase())) area.value = `${area.value.trim()}\n${item}`.trim();
          updateSuggestions();
        },
      }, present.has(item.toLowerCase()) ? `✓ ${item}` : `+ ${item}`)),
    );
  }
}

// ---------- Eigene Keywords ----------

const SOURCES = {
  text: { label: 'Text', placeholder: 'Wert, z. B. Vento', interval: null },
  file: { label: 'Datei', placeholder: 'C:\\Stream\\song.txt', interval: 2 },
  command: { label: 'Befehl', placeholder: 'PowerShell-Befehl, z. B. (Get-Date).Year', interval: 30 },
  url: { label: 'Webadresse', placeholder: 'https://…', interval: 30 },
};

const EXAMPLES = [
  {
    title: 'Name der Grafikkarte',
    text: 'Fragt Windows alle 5 Minuten nach deiner GPU. (Das Basic-Modul liefert {gpu} auch fertig.)',
    keyword: { key: 'grafikkarte', source: 'command', target: '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name', interval: 300 },
  },
  {
    title: 'Mehrere PC-Infos auf einmal',
    text: 'Ein Befehl gibt JSON aus → jedes Feld wird eine Variable: {pc_cpu}, {pc_system}, {pc_neustart}.',
    keyword: {
      key: 'pc', source: 'command', interval: 300,
      target: "$os = Get-CimInstance Win32_OperatingSystem; @{ cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name.Trim(); system = $os.Caption; neustart = $os.LastBootUpTime.ToString('dd.MM. HH:mm') } | ConvertTo-Json -Compress",
    },
  },
  {
    title: 'Ping ins Internet',
    text: 'Antwortzeit zu einem DNS-Server in Millisekunden, alle 10 Sekunden.',
    keyword: { key: 'ping', source: 'command', target: '(Test-Connection 1.1.1.1 -Count 1).ResponseTime', interval: 10 },
  },
  {
    title: 'CPU-Temperatur',
    text: 'Braucht LibreHardwareMonitor mit eingeschaltetem Webserver (siehe Anleitung unten).',
    keyword: { key: 'cputemp', source: 'url', target: 'http://localhost:8085/data.json', path: '**[Text~Tctl].Value', interval: 3 },
  },
  {
    title: 'Song aus einer Textdatei',
    text: 'Für Musik-Tools, die den aktuellen Song in eine .txt-Datei schreiben.',
    keyword: { key: 'song', source: 'file', target: 'C:\\Stream\\song.txt', interval: 2 },
  },
  {
    title: 'Fester Text',
    text: 'Z. B. dein Name, Discord oder deine PC-Teile.',
    keyword: { key: 'streamer', source: 'text', value: 'Dein Name' },
  },
];

function keywordRow(entry = { source: 'text' }) {
  const source = SOURCES[entry.source] ? entry.source : 'text';
  const keyInput = h('input', { type: 'text', name: 'key', value: entry.key || '', placeholder: 'name', maxlength: 32, spellcheck: 'false' });
  const sourceSelect = h('select', { name: 'source' },
    ...Object.entries(SOURCES).map(([id, s]) => h('option', { value: id }, s.label)));
  sourceSelect.value = source;
  const target = h('div', { class: 'kw-target' });
  const interval = h('input', { type: 'number', name: 'interval', min: 1, max: 3600, value: entry.interval ?? SOURCES[source].interval ?? '' });
  const preview = h('div', { class: 'kw-preview' });
  const row = h('div', { class: 'kw-row', 'data-saved': entry.key || '' },
    keyInput, sourceSelect, target,
    h('span', { class: 'kw-interval' }, interval, h('small', {}, 's')),
    preview,
    h('button', { class: 'btn danger', type: 'button', title: 'Entfernen', onclick: () => row.remove() }, '×'),
  );

  // Eingabefelder passend zur Quelle aufbauen
  const buildTarget = (src) => {
    const value = src === 'text' ? entry.value ?? '' : entry.target ?? '';
    const main = src === 'command'
      ? h('textarea', { name: 'target', rows: 1, spellcheck: 'false', placeholder: SOURCES[src].placeholder }, value)
      : h('input', { type: 'text', name: 'target', value, spellcheck: 'false', placeholder: SOURCES[src].placeholder });
    const parts = [main];
    if (src === 'file') {
      parts.push(h('button', {
        class: 'btn', type: 'button', title: 'Datei wählen',
        onclick: async () => {
          const res = await api.pickFile();
          if (res.ok && res.result) main.value = res.result;
        },
      }, '…'));
    }
    if (src === 'url') parts.push(h('input', { type: 'text', name: 'path', value: entry.path || '', placeholder: 'JSON-Pfad (optional)', spellcheck: 'false' }));
    target.className = `kw-target kw-${src}`;
    target.replaceChildren(...parts);
    interval.disabled = src === 'text';
    if (src === 'text') interval.value = '';
    else if (!interval.value) interval.value = SOURCES[src].interval;
  };
  sourceSelect.addEventListener('change', () => {
    entry = { ...entry, value: '', target: '', path: '' };
    interval.value = '';
    buildTarget(sourceSelect.value);
    updateKeywordPreviews();
  });
  buildTarget(source);
  return row;
}

// Aktuelle Werte live anzeigen, ohne die Eingabefelder neu aufzubauen
function updateKeywordPreviews() {
  for (const row of $('keywordRows').children) {
    const preview = row.querySelector('.kw-preview');
    const saved = row.dataset.saved;
    const current = row.querySelector('[name=key]').value.trim().toLowerCase();
    if (!saved || saved !== current) {
      preview.textContent = 'Speichern zum Testen';
      preview.className = 'kw-preview muted';
      preview.title = '';
      continue;
    }
    const error = state.keywordErrors?.[saved];
    const children = state.keywordChildren?.[saved] || [];
    preview.className = `kw-preview${error ? ' error' : ''}`;
    if (error) {
      preview.textContent = `Fehler: ${error}`;
      preview.title = preview.textContent;
    } else if (children.length) {
      // JSON-Ausgabe → die entstandenen Variablen zeigen statt des rohen Textes
      preview.replaceChildren(h('span', { class: 'kw-children' }, `${children.length} Variablen: `), children.map((c) => `{${c}}`).join(' '));
      preview.title = children.map((c) => `{${c}} = ${state.keywordValues?.[c] ?? ''}`).join('\n');
    } else {
      preview.textContent = state.keywordValues?.[saved] || '(leer)';
      preview.title = preview.textContent;
    }
  }
}

function fillKeywords() {
  $('keywordRows').replaceChildren(...state.keywords.map((entry) => keywordRow({ ...entry })));
  $('keywordsMessage').textContent = '';
  updateKeywordPreviews();
}

function renderExamples() {
  $('keywordExamples').replaceChildren(...EXAMPLES.map((example) => h('div', { class: 'card example' },
    h('div', { class: 'card-title' }, example.title, h('small', {}, `{${example.keyword.key}}`)),
    h('p', { class: 'card-desc' }, example.text),
    h('button', {
      class: 'btn', type: 'button',
      onclick: () => {
        const row = keywordRow({ ...example.keyword });
        $('keywordRows').append(row);
        updateKeywordPreviews();
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        $('keywordsMessage').classList.remove('error');
        $('keywordsMessage').textContent = 'Übernommen – mit „Speichern“ aktivieren.';
      },
    }, 'Übernehmen'),
  )));
}

$('addKeyword').addEventListener('click', () => {
  const row = keywordRow();
  $('keywordRows').append(row);
  updateKeywordPreviews();
  row.querySelector('input').focus();
});

$('keywordsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const list = [...$('keywordRows').children].map((row) => {
    const source = row.querySelector('[name=source]').value;
    const target = row.querySelector('[name=target]').value;
    return {
      key: row.querySelector('[name=key]').value,
      source,
      value: source === 'text' ? target : undefined,
      target: source === 'text' ? undefined : target,
      path: row.querySelector('[name=path]')?.value,
      interval: row.querySelector('[name=interval]').value,
    };
  });
  const res = await api.saveKeywords(list);
  if (res.ok) fillKeywords();
  $('keywordsMessage').classList.toggle('error', !res.ok);
  $('keywordsMessage').textContent = res.ok ? 'Gespeichert – dynamische Werte werden jetzt gelesen.' : res.error;
});

renderExamples();

document.querySelectorAll('.tabs button').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    for (const name of ['modules', 'keywords', 'share', 'settings']) $(`tab-${name}`).hidden = tab.dataset.tab !== name;
    if (tab.dataset.tab === 'settings') {
      fillSettings();
      $('settingsMessage').textContent = '';
    }
    if (tab.dataset.tab === 'keywords') fillKeywords();
    if (tab.dataset.tab === 'share') renderSharing();
  });
});

$('refreshBtn').addEventListener('click', () => run('refresh'));
$('brandBtn').addEventListener('click', () => run('openHome'));
$('addExtension').addEventListener('click', () => run('installExtension'));
$('openShareDir').addEventListener('click', () => run('shareOpen'));
$('pickShare').addEventListener('click', () => importShare(null));
$('exportBtn').addEventListener('click', async () => {
  const ids = [...$('shareDesigns').querySelectorAll('input:checked')].map((el) => el.value);
  const res = await run('shareExport', { ids, home: $('shareHome').checked, name: $('shareName').value });
  if (res.ok) $('shareMessage').textContent = `Exportiert nach ${res.result}. Den ganzen Ordner weitergeben – siehe „So teilst du“.`;
});

$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const res = await api.saveSettings({
    port: form.port.value,
    siteUrl: form.siteUrl.value,
    autostart: form.autostart.checked,
  });
  $('settingsMessage').classList.toggle('error', !res.ok);
  $('settingsMessage').textContent = res.ok ? 'Gespeichert.' : res.error;
});

api.onState((next) => {
  state = next;
  render();
});

api.getState().then((res) => {
  state = res.result;
  render();
  fillSettings();
});
