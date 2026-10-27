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
      mod.locked
        ? h('button', { class: 'btn primary', type: 'button', onclick: () => run('openAccount') }, state.account?.connected ? 'Freischalten' : 'Konto verbinden')
        : h('button', { class: 'btn primary', type: 'button', onclick: () => run('openModule', mod.id) }, 'Overlay einrichten'),
      mod.settings?.length && h('button', { class: 'btn', type: 'button', onclick: () => openModuleSettings(mod.id) }, 'Einstellungen'),
      mod.update && h('button', {
        class: 'btn', type: 'button', disabled: mod.busy, onclick: () => run('install', mod.id),
      }, mod.busy ? 'Lädt …' : 'Aktualisieren'),
      h('button', {
        class: 'btn danger', type: 'button', disabled: mod.busy,
        onclick: () => {
          if (confirm(`„${mod.name}“ entfernen? Overlays dieses Moduls zeigen dann nichts mehr an.`)) run('uninstall', mod.id);
        },
      }, 'Entfernen'),
    ),
  );
}

function availableCard(mod) {
  const plan = (mod.plan || 'free') === 'free' ? h('span', { class: 'plan free' }, 'Gratis') : h('span', { class: 'plan premium' }, 'Premium');
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      tile(mod),
      h('div', { class: 'card-title' }, mod.name, h('small', {}, `v${mod.version}`), plan),
    ),
    h('p', { class: 'card-desc' }, mod.description),
    mod.locked && !mod.unsupported ? h('button', { class: 'btn', type: 'button', onclick: () => run('openAccount') },
      state.account?.connected ? 'Freischalten' : 'Erst Konto verbinden') : h('button', {
      class: 'btn primary', type: 'button', disabled: mod.busy || mod.unsupported, onclick: () => run('install', mod.id),
      title: mod.unsupported ? 'Erst die App aktualisieren (Einstellungen → Updates)' : null,
    }, mod.unsupported ? `Braucht App ${mod.minApp}` : mod.busy ? 'Installiere …' : 'Installieren'),
  );
}

function render() {
  const { bridge, installed, available, registryError, version } = state;

  const dot = $('service').querySelector('.dot');
  dot.className = `dot ${bridge.error ? 'error' : 'ok'}`;
  $('serviceText').textContent = bridge.error || `Lokaler Dienst aktiv · Port ${bridge.port}`;

  $('installed').replaceChildren(...(installed.length
    ? installed.map(installedCard)
    : [h('div', { class: 'empty' }, 'Noch keine Module installiert. Such dir unten eins aus.')]));

  let discover;
  if (registryError) {
    discover = [h('div', { class: 'empty error' }, registryError)];
  } else if (!available.length) {
    discover = [h('div', { class: 'empty' }, installed.length ? 'Du hast schon alle Module installiert.' : 'Lade Module …')];
  } else {
    discover = available.map(availableCard);
  }
  $('available').replaceChildren(...discover);

  renderAccount();
  renderTwitch();
  $('about').textContent = `VentoView ${version}${state.installed ? '' : ' · nicht installiert (Test- oder Entwicklungsversion)'}`;
  renderUpdate();
  if (!$('tab-keywords').hidden) updateKeywordPreviews();
  updateSuggestions();
}

// VentoView-Konto: ohne Verbindung laufen keine Module
function renderAccount() {
  const acc = state.account || {};
  const panel = $('accountPanel');
  if (acc.connected) {
    const until = new Date(acc.expires).toLocaleDateString('de-DE');
    panel.replaceChildren(
      h('div', { class: 'connection-text' },
        h('b', {}, 'VentoView-Konto'),
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
      h('b', {}, 'VentoView-Konto'),
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
  pill.title = status === 'ready' ? 'VentoView schließt sich kurz und startet in der neuen Version' : '';
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
    ? 'VentoView startet beim Hochfahren unsichtbar im Tray.'
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
    if (field.type === 'lines') {
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
      input[field.key] = field.type === 'toggle' ? el.checked : el.value;
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
    for (const name of ['modules', 'keywords', 'settings']) $(`tab-${name}`).hidden = tab.dataset.tab !== name;
    if (tab.dataset.tab === 'settings') {
      fillSettings();
      $('settingsMessage').textContent = '';
    }
    if (tab.dataset.tab === 'keywords') fillKeywords();
  });
});

$('refreshBtn').addEventListener('click', () => run('refresh'));

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
