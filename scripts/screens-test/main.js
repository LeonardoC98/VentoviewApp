// Bildschirm-Test (Prototyp, nicht Teil der App): Bildschirme erkennen und ein Overlay auf einem Bildschirm zeigen –
// über allem, über dem Desktop (unter den Fenstern) oder als Hintergrund hinter den Desktop-Symbolen.
// Start: „Bildschirm-Test starten.bat“ im App-Ordner.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

app.setName('Ventoview Bildschirm-Test'); // eigener Datenordner – stört die installierte App nicht

// ---------- Windows-Helfer (PowerShell, läuft die ganze Zeit) ----------
let helper = null;
const waiting = [];
let buffer = '';
function startHelper() {
  helper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'win32.ps1')], { windowsHide: true });
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line === 'bereit') continue;
      waiting.shift()?.(line);
    }
  });
  helper.stderr.on('data', (d) => console.error('Helfer:', String(d)));
}
const ask = (command) => new Promise((resolve) => {
  waiting.push(resolve);
  helper.stdin.write(`${command}\n`);
});
const hwnd = (win) => win.getNativeWindowHandle().readBigUInt64LE(0).toString();

// ---------- Bildschirme ----------
function displays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays()
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((d, i) => {
      const px = screen.dipToScreenRect(null, d.bounds); // echte Pixel
      return {
        id: d.id, nr: i + 1, label: d.label || `Bildschirm ${i + 1}`, primary: d.id === primary,
        width: px.width, height: px.height, scale: d.scaleFactor, x: px.x, y: px.y, hz: d.displayFrequency, rotation: d.rotation,
        internal: d.internal,
      };
    });
}

// ---------- Anzeige-Fenster je Bildschirm ----------
const shown = new Map(); // display.id → { win, mode, timer }

function hide(id) {
  const entry = shown.get(id);
  if (!entry) return;
  clearInterval(entry.timer);
  if (!entry.win.isDestroyed()) entry.win.destroy();
  shown.delete(id);
}

async function show(id, mode, content) {
  hide(id);
  const d = screen.getAllDisplays().find((x) => x.id === id);
  if (!d) return 'FEHLER: Bildschirm nicht gefunden';
  const info = displays().find((x) => x.id === id);
  const win = new BrowserWindow({
    ...d.bounds, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, show: false,
    webPreferences: { backgroundThrottling: false },
  });
  win.setIgnoreMouseEvents(true); // Klicks gehen durch
  const url = content && /^https?:\/\//.test(content)
    ? content
    : `file://${path.join(__dirname, 'demo.html').replace(/\\/g, '/')}?nr=${info.nr}&name=${encodeURIComponent(info.label)}&w=${info.width}&h=${info.height}&mode=${mode}`;
  await win.loadURL(url);
  win.setBounds(d.bounds);
  const entry = { win, mode, timer: null };
  shown.set(id, entry);
  let result = 'OK';
  if (mode === 'top') {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.showInactive();
    result = 'OK: über allem';
  } else if (mode === 'above') {
    win.showInactive();
    result = await ask(`above ${hwnd(win)}`);
    // Ab und zu wieder einsortieren, falls Windows die Reihenfolge ändert
    entry.timer = setInterval(() => { if (!win.isDestroyed()) ask(`above ${hwnd(win)}`); }, 3000);
  } else if (mode === 'behind') {
    win.showInactive();
    result = await ask(`behind ${hwnd(win)} ${info.x} ${info.y} ${info.width} ${info.height}`);
  }
  return result;
}

// ---------- Steuer-Fenster ----------
let control = null;
app.whenReady().then(() => {
  startHelper();
  control = new BrowserWindow({
    width: 980, height: 720, title: 'Ventoview – Bildschirm-Test', backgroundColor: '#0b0b0f', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  control.loadFile(path.join(__dirname, 'index.html'));
  const changed = () => control?.webContents.send('displays', displays());
  screen.on('display-added', changed).on('display-removed', changed).on('display-metrics-changed', changed);
  control.on('closed', () => app.quit());
});

ipcMain.handle('displays', () => displays());
ipcMain.handle('desktop-info', () => ask('info'));
ipcMain.handle('show', (_e, id, mode, content) => show(id, mode, content));
ipcMain.handle('hide', (_e, id) => { hide(id); return 'aus'; });

app.on('before-quit', () => {
  for (const id of [...shown.keys()]) hide(id);
  helper?.kill();
});
app.on('window-all-closed', () => app.quit());
