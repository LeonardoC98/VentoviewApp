const { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, ipcMain, nativeImage, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Account } = require('./core/account');
const { Config } = require('./core/config');
const { Bridge } = require('./core/bridge');
const { DesignStore } = require('./core/designs');
const { ExtensionManager } = require('./core/extensions');
const { Sharing } = require('./core/sharing');
const { PcInfo } = require('./core/pcinfo');
const { KeywordSources, normalizeKeywords } = require('./core/keywords');
const { ModuleManager } = require('./core/modules');
const { TwitchAuth } = require('./core/twitch');
const { Updater } = require('./core/updater');

const ASSETS = path.join(__dirname, 'assets');

// Nur die per Installer installierte App (mit Deinstallationsprogramm daneben) trägt sich in den
// Autostart ein und sucht nach Updates – nicht der Entwicklungsmodus und keine Kopie aus dist/win-unpacked
const INSTALLED = app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`));

let config;
let bridge;
let designs;
let modules;
let extensions;
let sharing;
let updater;
let keywordSources;
let account;
let twitch;
let win = null;
let tray = null;
let quitting = false;
let bridgeError = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(init);
}

async function init() {
  Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  migrateFromStreamHub(userData);
  config = new Config(path.join(userData, 'config.json'));
  designs = new DesignStore(userData);
  await designs.init();

  updater = new Updater({ enabled: INSTALLED });
  updater.on('change', (state) => {
    pushState();
    tray?.setContextMenu(trayMenu());
    if (state.status === 'ready' && Notification.isSupported()) {
      const note = new Notification({
        title: `Ventoview ${state.version} ist bereit`,
        body: 'Wird beim Beenden installiert – oder jetzt in der App auf „Installieren“ klicken.',
      });
      note.on('click', showWindow);
      note.show();
    }
  });

  bridge = new Bridge({
    version: app.getVersion(),
    allowedOrigins: () => [originOf(config.get('siteUrl'))],
    // 'core' ist die Grund-App selbst: sie liefert die eigenen Keywords
    moduleState: (id) => (id === 'core' ? { installed: true, status: { state: 'ok', text: 'Ventoview' } } : modules.state(id)),
    assetPath: (file) => designs.assetPath(file),
    moduleFile: (id, name) => modules?.publicFile(id, name),
    uploadAsset: (upload) => designs.addAsset(upload),
  });
  bridge.handle('designs.list', () => designs.list());
  bridge.handle('design.get', (msg) => designs.get(msg));
  bridge.handle('design.save', async (msg) => {
    const saved = await designs.save(msg);
    bridge.designChanged(saved.id, saved);
    return saved;
  });
  bridge.handle('design.delete', async (msg) => {
    await designs.remove(msg);
    bridge.designChanged(msg.id, null);
  });
  bridge.handle('assets.list', () => designs.listAssets());
  bridge.handle('asset.delete', (msg) => designs.removeAsset(msg));
  // Eigene Keywords: feste Werte sofort, Dateien/Befehle/Webadressen laufend neu lesen
  keywordSources = new KeywordSources({
    onChange: () => {
      bridge.publish('core', { ...keywordSources.values });
      pushState();
    },
  });
  keywordSources.apply(config.get('keywords'));

  // Ventoview-Konto (Lizenzschein) und Twitch-Verbindung für Module
  account = new Account({ config, siteUrl: () => config.get('siteUrl') });
  twitch = new TwitchAuth({ config, safeStorage, openExternal: (url) => shell.openExternal(url) });
  twitch.on('change', pushState);
  bridge.handle('license.state', () => account.state());
  bridge.handle('license.set', (msg) => account.set(msg));
  bridge.handle('license.refresh', () => account.refresh());
  bridge.handle('module.action', (msg) => modules.action(msg.module, msg.action, msg.args));
  bridge.handle('module.settings', (msg) => modules.settingsOf(msg.module));
  bridge.handle('module.settings.save', async (msg) => {
    await modules.saveSettings(msg.module, msg.values);
    return modules.settingsOf(msg.module);
  });

  extensions = new ExtensionManager({ dir: path.join(userData, 'extensions'), account, electron: { globalShortcut, BrowserWindow, ipcMain } });
  extensions.on('change', () => {
    modules?.syncExtensions();
    pushState();
  });

  modules = new ModuleManager({
    dir: path.join(userData, 'modules'),
    dataDir: path.join(userData, 'module-data'),
    siteUrl: () => config.get('siteUrl'),
    bridge,
    appVersion: app.getVersion(),
    account,
    twitch,
    config,
    extensions,
  });
  modules.on('change', pushState);
  account.on('change', async () => {
    await modules.syncLicense();
    modules.autoInstall();
    pushState();
  });

  // Vorlagen und Home-Einstellungen teilen (Export/Import als Ordner)
  sharing = new Sharing({ designs, config, siteUrl: () => config.get('siteUrl'), documents: app.getPath('documents') });

  // Für die Webseite (Home, Module): Liste der Module, aktiv/inaktiv, Anordnung des Home-Bildschirms
  bridge.handle('modules.list', () => modules.list().installed.map((m) => ({
    id: m.id, name: m.name, version: m.version, accent: m.accent, badge: m.badge,
    locked: m.locked, inactive: m.inactive, needsExtension: m.needsExtension, requires: m.requires || null, status: m.status,
  })));
  bridge.handle('module.active', (msg) => modules.setActive(String(msg.module), Boolean(msg.active)));
  // PC-Info (Webseite → Home → PC-Info): Hardware einmal sammeln, Live-Werte bei jedem Abruf
  const pcInfo = new PcInfo();
  bridge.handle('pc.info', async (msg) => ({ hardware: await pcInfo.hardware(Boolean(msg.force)), live: await pcInfo.live() }));
  bridge.handle('pc.live', () => pcInfo.live());
  bridge.handle('home.get', () => config.get('home') || null);
  bridge.handle('home.save', (msg) => {
    const home = sharing.cleanHome(msg.home);
    config.set({ home });
    return home;
  });
  bridge.handle('hub.import', async (msg) => {
    const result = await sharing.importFromSite(String(msg.path || ''));
    for (const design of result.saved) bridge.designChanged(design.id, design);
    pushState();
    return { designs: result.saved.length, media: result.media };
  });

  await startBridge();
  await extensions.loadInstalled();
  await modules.loadInstalled();
  account.start();
  modules.fetchRegistry().then(() => modules.autoInstall());
  // War die Webseite beim Start nicht erreichbar, regelmäßig neu versuchen
  setInterval(() => {
    if (modules.registryError) modules.fetchRegistry().then(() => modules.autoInstall());
  }, 10_000);
  applyAutostart();
  createTray();
  updater.start();

  if (!process.argv.includes('--hidden')) showWindow();
}

// Die App hieß früher „StreamHub“: Einstellungen, Konto, Designs, eigene Medien und Module einmalig übernehmen
// („Local State“ enthält den Schlüssel, mit dem die Twitch-Verbindung verschlüsselt ist)
function migrateFromStreamHub(userData) {
  const legacy = path.join(app.getPath('appData'), 'StreamHub');
  if (fs.existsSync(path.join(userData, 'config.json')) || !fs.existsSync(path.join(legacy, 'config.json'))) return;
  for (const entry of ['config.json', 'Local State', 'designs', 'assets', 'modules', 'module-data']) {
    const from = path.join(legacy, entry);
    if (!fs.existsSync(from)) continue;
    try {
      fs.cpSync(from, path.join(userData, entry), { recursive: true });
    } catch (err) {
      console.error(`Übernahme von „${entry}“ fehlgeschlagen:`, err.message);
    }
  }
}

async function startBridge() {
  await bridge.close();
  try {
    await bridge.listen(config.get('port'));
    bridgeError = null;
  } catch (err) {
    bridgeError = err.code === 'EADDRINUSE'
      ? `Port ${config.get('port')} wird schon von einem anderen Programm benutzt.`
      : err.message;
  }
  pushState();
}

function applyAutostart() {
  if (!INSTALLED) return;
  app.setLoginItemSettings({ openAtLogin: config.get('autostart'), args: ['--hidden'] });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setToolTip('Ventoview');
  tray.setContextMenu(trayMenu());
  tray.on('click', showWindow);
}

function trayMenu() {
  const { status, version } = updater.state;
  return Menu.buildFromTemplate([
    { label: 'Ventoview öffnen', click: showWindow },
    { label: 'Webseite öffnen', click: () => shell.openExternal(config.get('siteUrl')) },
    ...(status === 'ready' ? [{ label: `Update ${version} installieren`, click: () => updater.install() }] : []),
    { type: 'separator' },
    { label: 'Beenden', click: () => app.quit() },
  ]);
}

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 560,
    title: 'Ventoview',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: '#0e0e12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Links nie im App-Fenster öffnen, sondern im normalen Browser
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // Schließen versteckt nur das Fenster, die Overlays sollen weiterlaufen
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!config.get('trayHintShown') && Notification.isSupported()) {
      new Notification({ title: 'Ventoview läuft weiter', body: 'Du findest Ventoview unten rechts im Tray.' }).show();
      config.set({ trayHintShown: true });
    }
  });
  win.on('closed', () => { win = null; });
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function getState() {
  return {
    version: app.getVersion(),
    installed: INSTALLED,
    bridge: { port: bridge.port, error: bridgeError },
    settings: { port: config.get('port'), siteUrl: config.get('siteUrl'), autostart: config.get('autostart') },
    keywords: config.get('keywords'),
    keywordValues: keywordSources?.values ?? {},
    keywordErrors: keywordSources?.errors ?? {},
    keywordChildren: keywordSources?.children ?? {},
    update: updater.state,
    account: account?.state() ?? null,
    twitch: twitch?.state() ?? null,
    extensions: extensions?.list() ?? [],
    shareDir: sharing?.shareDir ?? null,
    ...modules.list(),
  };
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', getState());
}

// Fehler als Ergebnis zurückgeben statt zu werfen, damit die Oberfläche sie anzeigen kann
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, result: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

handle('state:get', getState);
handle('modules:refresh', async () => {
  await modules.fetchRegistry();
  await modules.autoInstall();
});
handle('modules:active', (id, active) => modules.setActive(id, active));
handle('extensions:install', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Ventoview-Erweiterung wählen',
    properties: ['openFile'],
    filters: [{ name: 'Ventoview-Erweiterung', extensions: ['vvext'] }],
  });
  return canceled ? null : extensions.installFile(filePaths[0]);
});
handle('extensions:remove', (id) => extensions.remove(id));
// Controller-/MIDI-Eingabe aufnehmen (Modul Tastenkürzel): 'button' oder 'value' → z. B. pad:b3, midi:cc74
handle('input:record', (kind) => {
  const ext = extensions.get('shortcuts');
  if (!ext?.record) throw new Error('Dafür braucht es die Tastenkürzel-Erweiterung ab Version 1.1 – auf der Webseite neu herunterladen.');
  return ext.record(kind === 'value' ? 'value' : 'button');
});
handle('extensions:download', (id) => shell.openExternal(new URL(`api/extensions/${encodeURIComponent(id)}`, config.get('siteUrl')).href));
handle('share:list', () => sharing.overview());
handle('share:export', async (opts) => {
  const dir = await sharing.exportTo(opts);
  shell.showItemInFolder(path.join(dir, 'ventoview-export.json'));
  return dir;
});
handle('share:import', async (dir) => {
  if (!dir) {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Export-Ordner wählen', defaultPath: sharing.shareDir, properties: ['openDirectory'],
    });
    if (canceled) return null;
    dir = filePaths[0];
  }
  const result = await sharing.importFrom(dir);
  for (const design of result.saved) bridge.designChanged(design.id, design);
  pushState();
  return { designs: result.saved.length, media: result.media, home: result.home };
});
handle('share:open', async () => {
  await sharing.ensureShareDir();
  return shell.openPath(sharing.shareDir);
});
handle('modules:install', (id) => modules.install(id));
handle('modules:uninstall', (id) => modules.uninstall(id));
handle('modules:settings', (id, values) => modules.saveSettings(id, values));
handle('modules:open', (id) => {
  const url = new URL(`modules/${encodeURIComponent(id)}/`, config.get('siteUrl'));
  if (config.get('port') !== 47800) url.searchParams.set('port', config.get('port'));
  return shell.openExternal(url.href);
});
handle('site:open', () => shell.openExternal(config.get('siteUrl')));
// Logo oben links: Home-Seite (Home, Module, Hub) – mit Port, falls nicht der Standard
handle('site:home', () => {
  const url = new URL('home/', config.get('siteUrl'));
  if (config.get('port') !== 47800) url.searchParams.set('port', config.get('port'));
  return shell.openExternal(url.href);
});
handle('account:open', () => shell.openExternal(new URL('konto/', config.get('siteUrl')).href));
handle('account:pair', (code) => account.pair(code));
handle('account:disconnect', () => account.clear());
handle('twitch:connect', () => twitch.connect());
handle('twitch:cancel', () => twitch.cancel());
handle('twitch:disconnect', () => twitch.disconnect());
handle('modules:action', (id, name) => modules.action(id, name));
handle('update:check', () => updater.check());
handle('update:install', () => updater.install());
handle('keywords:save', (list) => {
  const keywords = normalizeKeywords(list);
  config.set({ keywords });
  keywordSources.apply(keywords);
  pushState();
});
handle('dialog:file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Datei für das Keyword wählen',
    properties: ['openFile'],
    filters: [{ name: 'Textdateien', extensions: ['txt', 'json', 'log', 'csv'] }, { name: 'Alle Dateien', extensions: ['*'] }],
  });
  return canceled ? null : filePaths[0];
});
handle('settings:save', async (patch) => {
  const next = {};
  if ('port' in patch) {
    const port = Number(patch.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Der Port muss zwischen 1024 und 65535 liegen.');
    next.port = port;
  }
  if ('siteUrl' in patch) {
    const url = new URL(patch.siteUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Die Webseite muss mit http:// oder https:// beginnen.');
    next.siteUrl = url.href;
  }
  if ('autostart' in patch) next.autostart = Boolean(patch.autostart);

  const portChanged = next.port !== undefined && next.port !== config.get('port');
  const siteChanged = next.siteUrl !== undefined && next.siteUrl !== config.get('siteUrl');
  config.set(next);

  if (portChanged) await startBridge();
  if (siteChanged) await modules.fetchRegistry();
  applyAutostart();
  pushState();
});

app.on('window-all-closed', () => {
  // Bewusst leer: Ventoview läuft im Tray weiter
});

app.on('before-quit', async (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  keywordSources?.stop();
  await modules?.stopAll();
  await extensions?.stopAll();
  await bridge?.close();
  app.quit();
});
