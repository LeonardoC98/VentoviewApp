// Export (Modul Videoschnitt): rendert ein gespeichertes Design Bild für Bild und speichert MP4, WebM (durchsichtig),
// GIF (durchsichtig) oder WAV.
// Bild: die Overlay-Seite läuft unsichtbar (Offscreen-Fenster) im Export-Modus – für jedes Bild Zeit setzen, warten,
// bis alles gezeichnet ist, Bild abgreifen. Kodiert wird in einem zweiten unsichtbaren Fenster (ui/export.html,
// WebCodecs H.264 + AAC, MP4 über mp4-muxer). Ton: die Overlay-Seite mischt alle Ton-Ebenen zu einer WAV.
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Exporter {
  constructor({ BrowserWindow, ipcMain, dialog, shell, config, modules, siteUrl, port, videosDir }) {
    Object.assign(this, { BrowserWindow, ipcMain, dialog, shell, config, modules, siteUrl, port, videosDir });
    this.job = null;
  }

  // Standard: Videos\Ventoview Exporte – wählt man einen anderen Ordner, merkt sich die App ihn
  dir() {
    return this.config.get('exportDir') || path.join(this.videosDir, 'Ventoview Exporte');
  }

  async settings(module) {
    try {
      return (await this.modules.settingsOf(String(module || 'videoschnitt')))?.values || {};
    } catch {
      return {};
    }
  }

  async info({ module } = {}) {
    const s = await this.settings(module);
    // formats: was diese App exportieren kann – der Editor bietet nur das an
    return { dir: this.dir(), fps: Number(s.fps) || 30, formats: ['mp4', 'webm', 'gif', 'wav'] };
  }

  async pickDir() {
    const res = await this.dialog.showOpenDialog({ title: 'Export-Ordner wählen', defaultPath: this.dir(), properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths?.[0]) return { dir: null };
    this.config.set({ exportDir: res.filePaths[0] });
    return { dir: res.filePaths[0] };
  }

  status() {
    if (!this.job) return { running: false };
    const { running, progress, phase, file, error, note } = this.job;
    return { running, progress, phase, file, error, note };
  }

  cancel() {
    if (this.job?.running) this.job.cancel = true;
    return { ok: true };
  }

  // Nur Dateien im Export-Ordner zeigen
  reveal({ file } = {}) {
    if (file && path.resolve(file).startsWith(path.resolve(this.dir()))) this.shell.showItemInFolder(file);
    return { ok: true };
  }

  async start(msg = {}) {
    if (this.job?.running) throw new Error('Es läuft schon ein Export.');
    const format = ['wav', 'webm', 'gif'].includes(msg.format) ? msg.format : 'mp4';
    const name = String(msg.name || 'Export').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'Export';
    const dir = this.dir(); // nie einen Ordner aus der Anfrage – nur den, den die App kennt
    await fs.mkdir(dir, { recursive: true });
    const ext = `.${format}`;
    let file = path.join(dir, `${name}${ext}`);
    for (let n = 2; await fs.access(file).then(() => true, () => false); n++) file = path.join(dir, `${name} (${n})${ext}`);
    const settings = await this.settings(msg.module);
    this.job = { running: true, progress: 0, phase: 'Bereitet vor …', file, error: null, note: '', cancel: false };
    const job = this.job;
    const opts = {
      design: String(msg.design || ''), from: Math.max(0, Number(msg.from) || 0), to: Number(msg.to) || 0,
      // Bildrate aus dem Export-Fenster, sonst die Einstellung des Moduls
      fps: Math.round(Math.min(240, Math.max(1, Number(msg.fps) || Number(settings.fps) || 30))), bitrate: (Number(settings.qualitaet) || 8) * 1e6,
    };
    ({
      wav: () => this.renderWav(job, opts), gif: () => this.renderGif(job, opts),
      mp4: () => this.renderVideo(job, opts, 'mp4'), webm: () => this.renderVideo(job, opts, 'webm'),
    })[format]()
      .catch((err) => { job.error = job.cancel ? 'Abgebrochen' : err.message; })
      .finally(() => { job.running = false; });
    return { file };
  }

  // Overlay-Seite unsichtbar öffnen und warten, bis sie das Design hat
  // transparent: durchsichtiger Hintergrund (WebM, GIF), sonst schwarz (MP4 kennt keine Transparenz)
  async openCapture(designId, { transparent = false } = {}) {
    const win = new this.BrowserWindow({
      show: false, width: 1920, height: 1080, useContentSize: true, frame: false, transparent, backgroundColor: transparent ? '#00000000' : '#000000',
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win.webContents.setAudioMuted(true);
    const url = new URL(`overlay/?d=${encodeURIComponent(designId)}&export=1`, this.siteUrl());
    if (this.port() !== 47800) url.searchParams.set('port', this.port());
    await win.loadURL(url.href);
    for (let i = 0; i < 150; i++) {
      const ready = await win.webContents.executeJavaScript('Boolean(window.vvExport && window.vvExport.ready)').catch(() => false);
      if (ready) {
        const size = await win.webContents.executeJavaScript('({ w: vvExport.width, h: vvExport.height, d: vvExport.duration })');
        win.setContentSize(size.w, size.h);
        win.webContents.setFrameRate(60);
        await sleep(300);
        return { win, ...size };
      }
      await sleep(200);
    }
    win.destroy();
    throw new Error('Die Vorlage lädt nicht – ist sie gespeichert und die Webseite erreichbar?');
  }

  async renderWav(job, opts) {
    const cap = await this.openCapture(opts.design);
    try {
      const to = opts.to > opts.from ? Math.min(opts.to, cap.d) : cap.d;
      job.phase = 'Mischt den Ton …';
      const res = await cap.win.webContents.executeJavaScript(`vvExport.audioWav(${opts.from}, ${to})`);
      if (job.cancel) throw new Error('Abgebrochen');
      await fs.writeFile(job.file, Buffer.from(res.wav, 'base64'));
      if (!res.sources) job.note = 'Keine Ton-Ebenen – die Datei ist still';
      job.progress = 1;
    } finally {
      cap.win.destroy();
    }
  }

  // GIF – immer mit durchsichtigem Hintergrund. Höchstens 960 px breit und 50 Bilder/s (mehr kann GIF nicht).
  // Jedes Bild bekommt eine eigene Palette (256 Farben), durchsichtige Pixel werden zur Transparenz-Farbe.
  async renderGif(job, opts) {
    const { GIFEncoder, quantize, applyPalette } = require('gifenc');
    const cap = await this.openCapture(opts.design, { transparent: true });
    try {
      const to = opts.to > opts.from ? Math.min(opts.to, cap.d) : cap.d;
      const fps = Math.min(50, opts.fps); // GIF kann höchstens 50 Bilder/s (20 ms)
      const scale = Math.min(1, 960 / cap.w);
      const width = Math.round(cap.w * scale);
      const height = Math.round(cap.h * scale);
      const delay = Math.round(1000 / fps);
      const gif = GIFEncoder();
      const total = Math.max(1, Math.round((to - opts.from) * fps));
      for (let i = 0; i < total; i++) {
        if (job.cancel) throw new Error('Abgebrochen');
        await cap.win.webContents.executeJavaScript(`vvExport.seek(${opts.from + i / fps})`);
        let image = await this.frame(cap.win);
        const size = image.getSize();
        if (size.width !== width || size.height !== height) image = image.resize({ width, height, quality: 'good' });
        // BGRA (Windows) → RGBA
        const px = new Uint8Array(image.toBitmap());
        for (let p = 0; p < px.length; p += 4) { const b = px[p]; px[p] = px[p + 2]; px[p + 2] = b; }
        const palette = quantize(px, 256, { format: 'rgba4444', oneBitAlpha: true });
        const index = applyPalette(px, palette, 'rgba4444');
        const clear = palette.findIndex((c) => c[3] === 0);
        gif.writeFrame(index, width, height, { palette, delay, transparent: clear >= 0, transparentIndex: Math.max(0, clear), dispose: 2 });
        job.progress = ((i + 1) / total) * 0.98;
        job.phase = `Bild ${i + 1} von ${total}`;
      }
      gif.finish();
      await fs.writeFile(job.file, Buffer.from(gif.bytes()));
      job.note = `${width} × ${height}, ${fps} Bilder/s, durchsichtiger Hintergrund – GIF hat keinen Ton`;
      job.progress = 1;
    } finally {
      cap.win.destroy();
    }
  }

  // MP4 (H.264 + AAC, schwarzer Hintergrund) oder WebM (VP9 + Opus, mit Alpha-Kanal = durchsichtiger Hintergrund)
  async renderVideo(job, opts, container) {
    const alpha = container === 'webm';
    const cap = await this.openCapture(opts.design, { transparent: alpha });
    const enc = new this.BrowserWindow({
      show: false, webPreferences: { preload: path.join(__dirname, '..', 'ui', 'export-preload.js'), contextIsolation: true, backgroundThrottling: false },
    });
    const waitFor = (channel) => new Promise((resolve) => {
      const fn = (event, data) => {
        if (event.sender !== enc.webContents) return;
        this.ipcMain.removeListener(channel, fn);
        resolve(data);
      };
      this.ipcMain.on(channel, fn);
    });
    try {
      await enc.loadFile(path.join(__dirname, '..', 'ui', 'export.html'));
      const to = opts.to > opts.from ? Math.min(opts.to, cap.d) : cap.d;
      // H.264 braucht gerade Maße
      const width = cap.w - (cap.w % 2);
      const height = cap.h - (cap.h % 2);
      job.phase = 'Mischt den Ton …';
      const audio = await cap.win.webContents.executeJavaScript(`vvExport.audioWav(${opts.from}, ${to})`).catch(() => null);
      const withAudio = Boolean(audio?.sources);

      let ready = waitFor('vv-init-done');
      enc.webContents.send('vv-init', { container, alpha, width, height, fps: opts.fps, bitrate: opts.bitrate, withAudio });
      const init = await ready;
      if (!init.ok) throw new Error(init.error || 'Video-Kodierung nicht verfügbar');
      if (withAudio && init.audio) {
        ready = waitFor('vv-audio-done');
        enc.webContents.send('vv-audio', { wav: Buffer.from(audio.wav, 'base64') });
        await ready;
      } else if (withAudio) {
        job.note = 'Ton konnte nicht kodiert werden – Video ohne Ton';
      }

      const total = Math.max(1, Math.round((to - opts.from) * opts.fps));
      for (let i = 0; i < total; i++) {
        if (job.cancel) throw new Error('Abgebrochen');
        await cap.win.webContents.executeJavaScript(`vvExport.seek(${opts.from + i / opts.fps})`);
        let image = await this.frame(cap.win);
        const size = image.getSize();
        if (size.width !== cap.w || size.height !== cap.h) image = image.resize({ width: cap.w, height: cap.h });
        if (width !== cap.w || height !== cap.h) image = image.crop({ x: 0, y: 0, width, height });
        ready = waitFor('vv-frame-done');
        enc.webContents.send('vv-frame', { index: i, data: image.toBitmap(), width, height });
        const done = await ready;
        if (done?.error) throw new Error(done.error);
        job.progress = ((i + 1) / total) * 0.97;
        job.phase = `Bild ${i + 1} von ${total}`;
      }
      job.phase = 'Speichert …';
      ready = waitFor('vv-finished');
      enc.webContents.send('vv-finish');
      const out = await ready;
      if (out?.error) throw new Error(out.error);
      await fs.writeFile(job.file, Buffer.from(out.data));
      job.progress = 1;
    } finally {
      cap.win.destroy();
      enc.destroy();
    }
  }

  // Ein frisch gezeichnetes Bild des Offscreen-Fensters (sonst Bildschirmfoto der Seite)
  frame(win) {
    return Promise.race([
      new Promise((resolve) => {
        win.webContents.once('paint', (_event, _dirty, image) => resolve(image));
        win.webContents.invalidate();
      }),
      sleep(1000).then(() => win.webContents.capturePage()),
    ]);
  }
}

module.exports = { Exporter };
