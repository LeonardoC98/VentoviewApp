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
  // Ist ein Fenster (Dialog) offen, die Meldung darin zeigen – sonst läge sie dahinter
  const host = document.querySelector('dialog[open]') || document.body;
  if ($('toast').parentElement !== host) host.append($('toast'));
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
  // Eigenes Symbol aus den Einstellungen hat Vorrang
  const icon = state?.moduleIcons?.[mod.id];
  if (icon) return h('div', { class: 'tile has-icon' }, h('img', { src: icon, alt: '' }));
  const badge = mod.badge || mod.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3);
  return h('div', { class: 'tile', style: mod.accent ? `--tile:${mod.accent}` : null }, badge);
}

// Bild für ein Modul-Symbol vorbereiten: mindestens 128 px, mittig quadratisch zuschneiden, auf 256 × 256 PNG bringen
const ICON_SIZE = 256;
const ICON_MIN = 128;
function prepareIcon(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.type)) return reject(new Error('Bitte ein Bild wählen (PNG, JPG, WebP, GIF oder SVG).'));
    if (file.size > 5 * 1024 * 1024) return reject(new Error('Das Bild ist größer als 5 MB.'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const svg = file.type === 'image/svg+xml';
      const w = img.naturalWidth || (svg ? ICON_SIZE : 0);
      const hgt = img.naturalHeight || (svg ? ICON_SIZE : 0);
      if (!svg && (w < ICON_MIN || hgt < ICON_MIN)) return reject(new Error(`Das Bild ist zu klein (${w} × ${hgt} px) – mindestens ${ICON_MIN} × ${ICON_MIN} px.`));
      const side = Math.min(w, hgt);
      const canvas = document.createElement('canvas');
      canvas.width = ICON_SIZE;
      canvas.height = ICON_SIZE;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (w - side) / 2, (hgt - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
      resolve({ dataUrl: canvas.toDataURL('image/png'), cropped: Math.abs(w - hgt) > 2 });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Das Bild konnte nicht gelesen werden.'));
    };
    img.src = url;
  });
}

// Einstellungen → „Modul-Symbole anpassen …“: Fenster mit allen Modulen, je „Bild wählen“ und „Zurücksetzen“
function openIconDialog() {
  const dialog = $('moduleDialog');
  dialog.replaceChildren(
    h('div', { class: 'dialog-head' }, h('h3', {}, 'Modul-Symbole'), h('button', { type: 'button', class: 'btn ghost', onclick: () => dialog.close() }, '×')),
    h('p', { class: 'icon-help' }, 'Quadratisch, mindestens 128 × 128 px (ideal 512 × 512), PNG mit Transparenz sieht am besten aus. Andere Formate werden mittig zugeschnitten und auf 256 × 256 px gebracht. Gilt hier in der App und auf der Home-Seite.'),
    h('div', { class: 'icon-list', id: 'iconList' }));
  renderIcons();
  dialog.showModal();
}

function renderIcons() {
  if (!$('iconList')) return;
  const mods = (state.installed || []).filter((m) => !m.locked);
  $('iconList').replaceChildren(...(mods.length ? mods.map((mod) => {
    const input = h('input', {
      type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', hidden: true,
      onchange: async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          const { dataUrl, cropped } = await prepareIcon(file);
          const res = await run('setModuleIcon', mod.id, dataUrl);
          if (res.ok && cropped) showError('Nicht quadratisch – das Bild wurde mittig zugeschnitten.');
        } catch (err) {
          showError(err.message);
        }
      },
    });
    const custom = Boolean(state.moduleIcons?.[mod.id]);
    return h('div', { class: 'icon-row' },
      tile(mod),
      h('span', { class: 'icon-name' }, mod.name, custom ? h('small', {}, 'eigenes Bild') : null),
      input,
      h('button', { type: 'button', class: 'btn small', onclick: () => input.click() }, custom ? 'Ändern …' : 'Bild wählen …'),
      custom ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => run('setModuleIcon', mod.id, null) }, 'Zurücksetzen') : null);
  }) : [h('p', { class: 'empty small' }, 'Noch keine Module.')]));
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
      mod.settings?.length > 0 && h('button', { class: 'btn icon-only', type: 'button', title: 'Einstellungen', 'aria-label': 'Einstellungen', onclick: () => openModuleSettings(mod.id) }, gearIcon()),
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

  // Oben nur, was freigeschaltet ist – gesperrte Module (z. B. Abo beendet) stehen unten bei „Module entdecken“
  const mine = installed.filter((m) => !m.locked);
  const locked = installed.filter((m) => m.locked);
  $('installed').replaceChildren(...(mine.length
    ? mine.map(installedCard)
    : [h('div', { class: 'empty' }, state.account?.connected ? 'Module werden geladen …' : 'Verbinde die App mit deinem Konto (Einstellungen) – deine Module erscheinen dann von selbst.')]));

  let discover;
  if (registryError) {
    discover = [h('div', { class: 'empty error' }, registryError)];
  } else if (!available.length && !locked.length) {
    discover = [h('div', { class: 'empty' }, installed.length ? 'Du hast schon alle Module.' : 'Lade Module …')];
  } else {
    discover = [...locked, ...available].map(availableCard);
  }
  $('available').replaceChildren(...discover);

  renderAccount();
  renderTwitch();
  renderExtensions();
  renderIcons();
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
  // Auswahl beim Neuzeichnen behalten; Filter (Modul, Suche) blenden nur aus – Angehakte bleiben angehakt
  const checked = new Set([...$('shareDesigns').querySelectorAll('input:checked')].map((el) => el.value));
  const modName = (id) => [...(state?.installed || []), ...(state?.available || [])].find((m) => m.id === id)?.name || id;
  $('shareDesigns').replaceChildren(...(designs.length
    ? designs.map((d) => h('label', { class: 'check', 'data-mods': (d.modules || []).join(','), 'data-text': `${d.name || ''} ${(d.modules || []).map(modName).join(' ')}`.toLowerCase() },
      h('input', { type: 'checkbox', value: d.id, checked: checked.has(d.id) }), h('span', {}, d.name || 'Ohne Namen'), h('small', {}, (d.modules || []).map(modName).join(', '))))
    : [h('small', {}, 'Noch keine gespeicherten Vorlagen – im Editor auf der Webseite speichern.')]));
  const used = [...new Set(designs.flatMap((d) => d.modules || []))].sort((a, b) => modName(a).localeCompare(modName(b), 'de'));
  $('shareMods').replaceChildren(...['', ...used].map((id) => h('button', {
    type: 'button', class: `chip${shareFilter.module === id ? '' : ' added'}`,
    onclick: () => { shareFilter.module = id; renderSharing(); },
  }, id ? modName(id) : 'Alle Module')));
  applyShareFilter();
  $('shareFolders').replaceChildren(...(folders.length
    ? folders.map((f) => h('div', { class: 'row' },
      h('span', {}, h('strong', {}, f.name), h('small', {}, [f.designs.join(', ') || 'keine Vorlagen', f.home ? ' · Home' : '', f.media ? ` · ${f.media} Medien` : ''].join(''))),
      h('button', { type: 'button', class: 'btn', onclick: () => importShare(f.dir) }, 'Importieren'),
    ))
    : [h('div', { class: 'row last' }, h('small', {}, 'Hier liegt noch nichts. Leg einen Export-Ordner in den Teilen-Ordner.'))]));
}

const shareFilter = { module: '', q: '' };

function applyShareFilter() {
  const q = shareFilter.q.trim().toLowerCase();
  const rows = [...$('shareDesigns').querySelectorAll('label.check')];
  for (const row of rows) {
    const mods = row.dataset.mods.split(',');
    row.hidden = Boolean((shareFilter.module && !mods.includes(shareFilter.module)) || (q && !row.dataset.text.includes(q)));
  }
  const n = rows.filter((r) => r.querySelector('input').checked).length;
  $('shareCount').textContent = `${rows.filter((r) => !r.hidden).length} von ${rows.length} sichtbar · ${n} ausgewählt`;
}

$('shareSearch').addEventListener('input', (e) => { shareFilter.q = e.target.value; applyShareFilter(); });
$('shareDesigns').addEventListener('change', applyShareFilter);
$('shareAll').addEventListener('click', () => {
  $('shareDesigns').querySelectorAll('label.check:not([hidden]) input').forEach((el) => { el.checked = true; });
  applyShareFilter();
});
$('shareNone').addEventListener('click', () => {
  $('shareDesigns').querySelectorAll('input').forEach((el) => { el.checked = false; });
  applyShareFilter();
});

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
  // Aufbau wie im Web-Editor (Reiter „Einstellungen“): gleiche Reihenfolge, gleiche Felder, Hinweis unter dem Feld.
  // Was es nur in der App gibt (Tasten aufnehmen, Bot exportieren …), steht ganz unten hinter einer feinen Linie.
  const help = (field) => (field.help ? h('p', { class: 'hint' }, field.help) : null);
  const label = (field) => h('label', {}, field.label);
  const extras = [];
  const fields = mod.settings.map((field) => {
    const row = (...children) => h('div', { class: 'setting field', 'data-key': field.key }, ...children);
    if (field.type === 'toggle') {
      return row(h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', name: field.key, checked: (values[field.key] ?? field.default) ? true : null, onchange: () => preview() }),
        h('span', { class: 'tswitch' }), field.label), help(field));
    }
    if (field.type === 'select') {
      return row(label(field),
        h('select', { name: field.key, onchange: () => preview() }, ...(field.options || []).map(([v, text]) => h('option', { value: v, selected: String(values[field.key] ?? field.default) === String(v) ? true : null }, text))),
        help(field));
    }
    if (field.type === 'lines') {
      return row(label(field),
        h('textarea', { name: field.key, rows: 4, spellcheck: 'false', placeholder: field.placeholder || '' }, (values[field.key] || []).join('\n')),
        help(field), h('div', { class: 'suggestions' }));
    }
    if (field.type === 'randomizers') return row(label(field), randomizerEditor(field, values[field.key] || []), help(field));
    if (field.type === 'blocks') {
      // Wie im Web: Hinweis + Weg in den Editor. Export/Import gibt es nur hier → unten bei „Nur in der App“
      const count = Array.isArray(values[field.key]) ? values[field.key].length : null;
      extras.push(h('div', { class: 'setting field' }, h('label', {}, `${field.label}: Datei`),
        h('div', { class: 'blocks-file' },
          h('button', {
            type: 'button', class: 'btn small', title: 'Alle Bot-Elemente und Bot-Einstellungen als .vviewbot-Datei speichern (ohne deinen Kanal)',
            onclick: async () => { const res = await run('exportBot'); if (res.ok && res.result) showError(`Exportiert: ${res.result.blocks} Elemente.`); },
          }, 'Exportieren …'),
          h('button', {
            type: 'button', class: 'btn small ghost', title: 'Bot aus einer .vviewbot-Datei laden – ersetzt alle Bot-Elemente',
            onclick: async () => {
              const res = await run('importBot');
              if (res.ok && res.result) { $('moduleDialog').close(); showError(`Importiert: ${res.result.blocks} Elemente. Im Editor die Seite neu laden.`); }
            },
          }, 'Importieren …')),
        h('input', { type: 'hidden', name: field.key, value: JSON.stringify(values[field.key] ?? null) })));
      return row(label(field),
        h('p', { class: 'hint' }, `${count === null ? '' : `${count} Elemente eingerichtet. `}Befehle, Zufallsgeneratoren, Timer, Uhrzeiten und mehr baust du im Chat-Bot-Editor im Tab „Ventoview-Bot“.`),
        h('div', {}, h('button', { type: 'button', class: 'btn small', onclick: () => { $('moduleDialog').close(); run('openModule', mod.id); } }, 'Im Chat-Bot-Editor öffnen')));
    }
    if (field.type === 'hotkeys' || field.type === 'dials' || field.type === 'extrakeys') {
      // Wie im Web nur die Anzahl – aufnehmen geht unten (die App hört Tastatur, Gamepad und MIDI)
      const editor = field.type === 'hotkeys' ? hotkeyEditor(field, values[field.key] || [])
        : field.type === 'dials' ? dialEditor(field, values[field.key] || []) : extraKeyEditor(field, values[field.key] || []);
      extras.push(h('div', { class: 'setting field', 'data-key': field.key }, label(field), editor));
      const count = (values[field.key] || []).length;
      return row(label(field), h('p', { class: 'hint' }, `${count ? `${count} eingerichtet. ` : ''}Aufnehmen: unten bei „Nur in der App“.`), help(field));
    }
    return row(label(field),
      h('input', { type: field.type === 'number' ? 'number' : 'text', name: field.key, value: values[field.key] ?? '', placeholder: field.placeholder || '' }),
      help(field));
  });
  const message = h('span', { class: 'message', role: 'status' });
  const form = h('form', { class: 'settings-form' },
    ...fields,
    extras.length ? h('div', { class: 'app-extras' }, h('p', { class: 'app-extras-head' }, 'Nur in der App'), ...extras) : null,
    h('div', { class: 'actions' },
      message,
      h('button', { type: 'button', class: 'btn ghost', onclick: () => closeSettings() }, 'Schließen'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Speichern'),
    ),
  );
  // Jede Änderung gilt sofort vorläufig (das Modul arbeitet schon damit – z. B. ein gelöschtes Tastenkürzel ist gleich
  // frei für ein neues), gespeichert wird erst mit „Speichern“. Schließen ohne Speichern nimmt alles zurück.
  const collect = () => {
    const input = {};
    for (const field of mod.settings) {
      const el = form.querySelector(`[name="${field.key}"]`);
      if (!el) continue;
      input[field.key] = field.type === 'toggle' ? el.checked : ['hotkeys', 'dials', 'randomizers', 'blocks', 'extrakeys'].includes(field.type) ? JSON.parse(el.value) : el.value;
    }
    return input;
  };
  let saved = JSON.parse(JSON.stringify(values)); // Stand in der Datei
  let dirty = false;
  async function preview() {
    dirty = true;
    message.classList.remove('error');
    message.textContent = 'Noch nicht gespeichert';
    const res = await (api.previewModuleSettings || api.saveModuleSettings)(id, collect());
    if (!res.ok) {
      message.classList.add('error');
      message.textContent = res.error;
    }
  }
  async function save() {
    const input = collect();
    const res = await api.saveModuleSettings(id, input);
    message.classList.toggle('error', !res.ok);
    message.textContent = res.ok ? 'Gespeichert – gilt für alle Overlays dieses Moduls.' : res.error;
    if (!res.ok) return;
    saved = input;
    dirty = false;
    setTimeout(() => $('moduleDialog').close(), 500);
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  // Tastenkürzel, Extra-Tasten, Regler: ihre Listen melden jede Änderung (verstecktes Feld) → vorläufig übernehmen
  form.addEventListener('vv-change', () => preview());
  // Texte: erst mit „Speichern“ – aber als ungespeichert merken
  form.addEventListener('input', (event) => {
    if (!event.target.matches('input[type=text], input[type=number], textarea')) return;
    dirty = true;
    message.classList.remove('error');
    message.textContent = 'Noch nicht gespeichert';
  });
  // Schließen (×, Schließen, Esc) mit Ungespeichertem: nachfragen, sonst zurück auf den gespeicherten Stand
  $('moduleDialog').oncancel = (event) => {
    if (dirty && !confirm('Änderungen nicht gespeichert – verwerfen?')) event.preventDefault();
  };
  $('moduleDialog').onclose = () => {
    $('moduleDialog').onclose = null;
    if (dirty) api.previewModuleSettings?.(id, saved);
    dirty = false;
  };
  function closeSettings() {
    if (dirty && !confirm('Änderungen nicht gespeichert – verwerfen?')) return;
    $('moduleDialog').close();
  }
  $('moduleDialog').replaceChildren(
    h('div', { class: 'dialog-head' }, h('h3', {}, `${mod.name} – Einstellungen`), h('button', { type: 'button', class: 'btn ghost', onclick: () => closeSettings() }, '×')),
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

// Extra-Tasten (Basic → Tasten-Anzeige): Zusatztasten an Maus oder Tastatur, die Ventoview sonst nicht kennt.
// „+ Extra aufnehmen“ wartet auf die nächste Taste; ist sie eine normale, gibt es nur einen Hinweis.
// Gespeichert als Zeilen „maus:4 = Maus vor“ bzw. „key:57416 = Makro 1“.
function extraKeyEditor(field, lines) {
  const list = lines.map((line) => {
    const i = line.indexOf('=');
    return i > 0 ? { id: line.slice(0, i).trim(), name: line.slice(i + 1).trim() } : null;
  }).filter((x) => x && /^(maus|key):\d+$/.test(x.id) && x.name);
  const hidden = h('input', { type: 'hidden', name: field.key });
  const rows = h('div', { class: 'hotkeys' });
  const info = h('small', { class: 'extra-info' });
  const nameInput = h('input', { type: 'text', placeholder: 'Name (optional), z. B. Daumentaste', maxlength: '30' });
  const button = h('button', { type: 'button', class: 'btn primary' }, '+ Extra aufnehmen');
  const sync = () => {
    hidden.value = JSON.stringify(list.map((x) => `${x.id} = ${x.name}`));
    if (hidden.isConnected) hidden.dispatchEvent(new Event('vv-change', { bubbles: true })); // Fenster übernimmt vorläufig
    rows.replaceChildren(...(list.length ? list.map((x) => h('div', { class: 'hotkey' },
      h('b', {}, x.name), h('kbd', {}, x.id.startsWith('maus:') ? `Maustaste ${x.id.slice(5)}` : `Taste ${x.id.slice(4)}`),
      h('button', { type: 'button', class: 'btn ghost small', title: 'Entfernen', onclick: () => { list.splice(list.indexOf(x), 1); sync(); } }, '×'),
    )) : [h('div', { class: 'empty small' }, 'Keine Extra-Tasten.')]));
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Drücke jetzt die Taste …';
    info.textContent = 'Taste an Maus oder Tastatur drücken (10 Sekunden).';
    const res = await api.captureKey();
    button.disabled = false;
    button.textContent = '+ Extra aufnehmen';
    if (!res.ok) { info.textContent = res.error; return; }
    const key = res.result;
    const id = `${key.device}:${key.code}`;
    if (key.known) {
      info.textContent = `„${key.name}“ erkennt Ventoview schon von selbst – nichts Neues registriert.`;
      return;
    }
    if (list.some((x) => x.id === id)) {
      info.textContent = `Diese Taste ist schon als „${list.find((x) => x.id === id).name}“ eingetragen.`;
      return;
    }
    const name = (nameInput.value.trim().replace(/=/g, '') || (key.device === 'maus' ? `Maus ${key.code}` : `Taste ${key.code}`)).slice(0, 30);
    nameInput.value = '';
    list.push({ id, name });
    info.textContent = `„${name}“ hinzugefügt – Speichern nicht vergessen.`;
    sync();
  });
  sync();
  return h('div', { class: 'extra-keys' }, rows, h('div', { class: 'hotkey-add' }, nameInput, button), info, hidden);
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
    if (hidden.isConnected) hidden.dispatchEvent(new Event('vv-change', { bubbles: true })); // Fenster übernimmt vorläufig
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
  const list = JSON.parse(JSON.stringify(Array.isArray(initial) ? initial : field.default || []));
  const hidden = h('input', { type: 'hidden', name: field.key });
  const wrap = h('div', { class: 'randomizers' });
  const open = new Set(list.length === 1 ? [0] : []);
  const many = new Set(); // Zufallsgeneratoren mit offenem „Mehrere …“
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
        // Aufbau wie im Web-Editor (Einstellungen → Zufallsgeneratoren)
        h('div', { class: 'rnd-head', onclick: () => { if (isOpen) open.delete(index); else open.add(index); draw(); } },
          h('span', {}, isOpen ? '▾' : '▸'),
          h('b', {}, `🎲 ${r.command || r.name}`),
          h('small', { class: 'muted' }, `${r.entries.length} Einträge · {zufall_${r.name}}`),
          h('button', { type: 'button', class: 'btn ghost small', title: 'Löschen', onclick: (ev) => { ev.stopPropagation(); if (confirm(`„${r.command || r.name}“ löschen?`)) { list.splice(index, 1); open.delete(index); draw(); } } }, '×')),
        isOpen ? h('div', { class: 'rnd-body' },
          h('div', { class: 'rnd-grid' },
            h('label', {}, 'Befehl', input('command', { placeholder: '!lucky' })),
            h('label', {}, 'Name', input('name', { placeholder: 'lucky' })),
            h('label', {}, 'Pause s', input('cooldown', { type: 'number', min: 0, placeholder: 'Std.' })),
            h('label', {}, 'Antwort', h('select', { onchange: (e) => { r.mode = e.target.value; sync(); } },
              ...RANDOM_MODES.map(([value, label]) => h('option', { value, selected: r.mode === value ? true : null }, label)))),
          ),
          h('label', { class: 'rnd-text' }, 'Text', input('text', { placeholder: '🍀 {treffer}' })),
          h('p', { class: 'hint' }, `{treffer} = gezogener Eintrag, dazu {user} und alle Variablen. Überall sonst: {zufall_${r.name}}.`),
          h('div', { class: 'rnd-entries' },
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
              type: 'button', class: 'btn small', title: 'Viele Einträge auf einmal',
              onclick: () => { if (many.has(index)) many.delete(index); else many.add(index); draw(); },
            }, 'Mehrere …'),
            h('button', { type: 'button', class: 'btn small ghost', onclick: () => { r.entries.forEach((e) => { e.weight = 1; }); draw(); } }, 'Alle gleich'),
          ),
          // Mehrere Einträge auf einmal – wie im Web: neue Zeile trennt immer, Komma auch (abschaltbar für Sprüche mit Komma)
          many.has(index) ? (() => {
            const area = h('textarea', { rows: 6, placeholder: 'Ahri, Teemo, Jinx\noder ein Eintrag pro Zeile' });
            const commas = h('input', { type: 'checkbox', checked: true });
            return h('div', { class: 'rnd-many' },
              h('p', { class: 'hint' }, 'Einfach einfügen oder tippen. Neue Zeile trennt immer, Komma auch – außer du schaltest es ab (für Sprüche mit Komma).'),
              area,
              h('label', { class: 'toggle' }, commas, h('span', { class: 'tswitch' }), 'Komma trennt Einträge'),
              h('div', { class: 'rnd-actions' },
                h('button', { type: 'button', class: 'btn small ghost', onclick: () => { many.delete(index); draw(); } }, 'Abbrechen'),
                h('button', {
                  type: 'button', class: 'btn small primary',
                  onclick: () => {
                    const texts = area.value.split(commas.checked ? /[\r\n,]+/ : /\r?\n/).map((t) => t.trim()).filter(Boolean);
                    r.entries.push(...texts.map((text) => ({ text, weight: 1 })));
                    many.delete(index);
                    draw();
                  },
                }, 'Einfügen')));
          })() : null,
        ) : null,
      );
    }), h('button', {
      type: 'button', class: 'btn small',
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
    if (hidden.isConnected) hidden.dispatchEvent(new Event('vv-change', { bubbles: true })); // Fenster übernimmt vorläufig
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
  python: { label: 'Python', placeholder: 'test = ping * 2  # andere Variablen einfach mit Namen nutzen', interval: 5 },
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
    title: 'Mit Python rechnen',
    text: 'Eigener Python-Code (sicherer Modus): Minuten seit Mitternacht. Andere Variablen nutzt du einfach mit Namen, z. B. ping * 2.',
    keyword: { key: 'minuten', source: 'python', target: 'from datetime import datetime\njetzt = datetime.now()\nminuten = jetzt.hour * 60 + jetzt.minute', interval: 30 },
  },
  {
    title: 'Python mit Gedächtnis',
    text: 'Zählt, wie oft der Ping seit dem Start über 80 ms lag – „speicher“ bleibt zwischen den Läufen erhalten. Braucht {ping}.',
    keyword: { key: 'lags', source: 'python', target: 'if ping > 80:\n    speicher["n"] = speicher.get("n", 0) + 1\nlags = speicher.get("n", 0)', interval: 10 },
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
    h('button', {
      class: 'btn danger', type: 'button', title: 'Entfernen',
      onclick: async () => {
        const saved = row.dataset.saved;
        const used = saved ? (await api.keywordUsage(saved)).result || [] : [];
        if (used.length && !confirm(`{${saved}} wird benutzt:\n${usageText(used)}\n\nWenn du es löschst, funktionieren diese Stellen nicht mehr. Trotzdem löschen?`)) return;
        row.remove();
      },
    }, '×'),
  );
  keyInput.addEventListener('input', updateKeywordPreviews);

  // Eingabefelder passend zur Quelle aufbauen
  const buildTarget = (src) => {
    const value = src === 'text' ? entry.value ?? '' : entry.target ?? '';
    const main = src === 'command' || src === 'python'
      ? h('textarea', { name: 'target', rows: src === 'python' ? Math.min(14, Math.max(3, String(value).split('\n').length + 1)) : 1, spellcheck: 'false', placeholder: SOURCES[src].placeholder, class: src === 'python' ? 'kw-code' : null }, value)
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
    if (src === 'python') {
      // Tab rückt ein statt das Feld zu verlassen
      main.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab' || e.shiftKey) return;
        e.preventDefault();
        main.setRangeText('    ', main.selectionStart, main.selectionEnd, 'end');
      });
      const full = h('input', { type: 'checkbox', name: 'full' });
      full.checked = Boolean(entry.full);
      full.addEventListener('change', () => {
        if (full.checked && !confirm('Voller Zugriff für dieses Python-Keyword?\n\nDer Code darf dann alles, was du auf diesem PC darfst: Dateien lesen, ändern und löschen, Programme starten, ins Internet senden.\n\nNur einschalten, wenn du den Code selbst geschrieben hast und genau verstehst. Niemals für Code aus dem Chat, Discord oder von Fremden.')) full.checked = false;
        row.classList.toggle('kw-full', full.checked);
      });
      row.classList.toggle('kw-full', full.checked);
      parts.push(h('div', { class: 'kw-py-foot' },
        h('small', { class: 'kw-help' },
          'Andere Variablen einfach mit Namen nutzen (z. B. ping, songtitle) – Zahlen sind schon Zahlen. Den Wert setzt du mit ',
          h('code', {}, `${entry.key || 'name'} = …`), '. Sicherer Modus: nur Rechnen und Text, keine Dateien oder Programme.'),
        h('label', { class: 'kw-full-toggle', title: 'Ohne sicheren Modus – der Code darf alles, was du darfst' }, full, h('span', {}, 'Voller Zugriff'))));
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
    const taken = keywordTaken(current);
    row.classList.toggle('conflict', Boolean(taken));
    if (taken) {
      preview.textContent = taken;
      preview.className = 'kw-preview error';
      preview.title = taken;
      continue;
    }
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

// Meldung, wenn ein Name schon vergeben ist – sonst ''
function keywordTaken(key) {
  if (!key) return '';
  if (state.keywordConflicts?.[key]) return state.keywordConflicts[key];
  const mod = state.reservedNames?.[key];
  return mod ? `{${key}} gibt es schon im Modul „${mod}“ – bitte anders nennen.` : '';
}

const usageText = (list) => list.map((u) => `• ${u.where}${u.count > 1 ? ` (${u.count}×)` : ''}`).join('\n');

// Hinweis oben im Tab, wenn ein (neu installiertes) Modul einen deiner Namen belegt
function renderKeywordConflicts() {
  const list = Object.values(state.keywordConflicts || {});
  $('keywordConflicts').hidden = !list.length;
  $('keywordConflicts').textContent = list.length ? `Namenskonflikt: ${list.join(' ')}` : '';
  document.querySelector('.tabs button[data-tab=keywords]')?.classList.toggle('alert', list.length > 0);
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
  const rows = [...$('keywordRows').children];
  // Umbenannt: Name geändert, der alte war gespeichert → überall mitziehen (nach Rückfrage, wenn er benutzt wird)
  const renames = rows.map((row) => ({ from: row.dataset.saved, to: row.querySelector('[name=key]').value.trim().toLowerCase() }))
    .filter((r) => r.from && r.to && r.from !== r.to);
  const notes = [];
  for (const r of renames) {
    const used = (await api.keywordUsage(r.from)).result || [];
    if (used.length) notes.push(`{${r.from}} → {${r.to}}:\n${usageText(used)}`);
  }
  if (notes.length && !confirm(`Umbenannte Keywords werden benutzt – die Umbenennung wird dort übernommen:\n\n${notes.join('\n\n')}\n\nWeiter?`)) return;
  const list = rows.map((row) => {
    const source = row.querySelector('[name=source]').value;
    const target = row.querySelector('[name=target]').value;
    return {
      key: row.querySelector('[name=key]').value,
      source,
      value: source === 'text' ? target : undefined,
      target: source === 'text' ? undefined : target,
      path: row.querySelector('[name=path]')?.value,
      interval: row.querySelector('[name=interval]').value,
      full: source === 'python' ? Boolean(row.querySelector('[name=full]')?.checked) : undefined,
    };
  });
  const res = await api.saveKeywords(list, renames);
  if (res.ok) fillKeywords();
  $('keywordsMessage').classList.toggle('error', !res.ok);
  const changed = res.result?.changed;
  $('keywordsMessage').textContent = res.ok
    ? `Gespeichert – dynamische Werte werden jetzt gelesen.${changed ? ` Umbenennung an ${changed} Stelle${changed === 1 ? '' : 'n'} übernommen.` : ''}`
    : res.error;
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
    if (tab.dataset.tab === 'keywords') {
      fillKeywords();
      keywordWarning();
    }
    if (tab.dataset.tab === 'share') renderSharing();
  });
});

// Hinweis-Fenster beim Öffnen der Keywords: Befehle und Python laufen mit deinen Rechten
function keywordWarning() {
  try {
    if (localStorage.getItem('vv-keyword-warning-off') === '1') return;
  } catch { /* ohne Speicher: jedes Mal zeigen */ }
  const dialog = h('dialog', { class: 'modal warning-dialog' });
  const never = h('input', { type: 'checkbox' });
  const close = () => {
    try {
      if (never.checked) localStorage.setItem('vv-keyword-warning-off', '1');
    } catch { /* egal */ }
    dialog.close();
  };
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(
    h('div', { class: 'warning-icon' }, '!'),
    h('h3', {}, 'Bevor du loslegst'),
    h('p', {}, 'Eigene Keywords können auf diesem PC Dinge ausführen: Befehle laufen in PowerShell, Python-Code in Python – mit deinen Rechten.'),
    h('ul', {},
      h('li', {}, h('b', {}, 'Nur eigenen Code eintragen'), ' oder Code, den du Zeile für Zeile verstehst.'),
      h('li', {}, h('b', {}, 'Niemals Code aus Chat, Discord oder von Fremden'), ' übernehmen – auch nicht „nur zum Testen“.'),
      h('li', {}, h('b', {}, 'Python läuft im sicheren Modus:'), ' nur Rechnen und Text. „Voller Zugriff“ schaltest du pro Keyword bewusst ein.'),
      h('li', {}, h('b', {}, 'Text, Datei und Webadresse'), ' sind harmlos – sie lesen nur.')),
    h('p', { class: 'muted' }, 'Mehr dazu im Handbuch unter „Eigene Keywords & Python“.'),
    h('div', { class: 'warning-actions' },
      h('label', { class: 'check' }, never, h('span', {}, 'Nicht mehr anzeigen')),
      h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Verstanden')));
  document.body.append(dialog);
  dialog.showModal();
}

$('refreshBtn').addEventListener('click', () => run('refresh'));
$('iconsBtn').addEventListener('click', openIconDialog);
$('brandBtn').addEventListener('click', () => run('openHome'));
$('addExtension').addEventListener('click', () => run('installExtension'));
$('saveBackupBtn').addEventListener('click', async () => {
  const res = await run('saveBackup');
  if (res.ok && res.result) showError(`Gesichert: ${res.result.files} Dateien (${(res.result.bytes / 1048576).toFixed(1)} MB).`);
});
$('loadBackupBtn').addEventListener('click', () => run('loadBackup'));
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

// Sprache aus dem App-Zustand (gilt auch für die Webseite)
let i18nStamp = 0;
function applyLanguage() {
  const code = state?.language?.code || 'en';
  // Modul-Texte (Namen, Einstellungen, Meldungen) kommen als Wörterbuch von der Webseite
  if (state?.i18nStamp && state.i18nStamp !== i18nStamp) {
    i18nStamp = state.i18nStamp;
    api.i18nExtra().then((res) => VVI18n.add(res?.result || {})).catch(() => {});
  }
  VVI18n.setLang(code);
  if ($('langSelect').value !== code) $('langSelect').value = code;
}
$('langSelect').addEventListener('change', (e) => run('setLanguage', e.target.value));

api.onState((next) => {
  const before = Object.keys(state?.keywordConflicts || {}).join();
  state = next;
  applyLanguage();
  render();
  renderKeywordConflicts();
  updateKeywordPreviews();
  // Neu entstandener Konflikt (z. B. Modul installiert): einmal melden
  const now = Object.keys(state.keywordConflicts || {});
  if (now.length && now.join() !== before) showError(`Namenskonflikt bei ${now.map((k) => `{${k}}`).join(', ')} – unter „Keywords“ umbenennen.`);
});

api.getState().then((res) => {
  state = res.result;
  applyLanguage();
  render();
  renderKeywordConflicts();
  fillSettings();
});
