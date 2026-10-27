const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const PING_MS = 30_000;
const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

/**
 * Lokaler Dienst – die Schnittstelle zwischen App und Webseite.
 * Lauscht nur auf 127.0.0.1 und nimmt Verbindungen nur von der eigenen Webseite an.
 *
 * HTTP
 *   GET  /assets/<datei>   eigenes Bild/Video für Overlays (zufälliger, nicht erratbarer Name)
 *   POST /assets           Bild/Video hochladen (nur von der eigenen Webseite)
 *   GET  /files/<modul>/<datei>  Bild, das ein Modul bereitstellt (z. B. Album-Cover)
 *
 * WebSocket /ws
 *   { type: 'subscribe', module }   Daten eines Moduls abonnieren ('core' = Keywords der Grund-App)
 *   { type: 'watch', design }       Änderungen an einem Design abonnieren
 *   { type: <name>, reqId, ... }    Anfrage an einen mit handle() registrierten Handler
 */
class Bridge {
  constructor({ version, allowedOrigins, moduleState, assetPath, moduleFile, uploadAsset }) {
    this.version = version;
    this.allowedOrigins = allowedOrigins; // () => string[]
    this.moduleState = moduleState;       // (id) => { installed, status }
    this.assetPath = assetPath;           // (file) => absoluter Pfad oder null
    this.moduleFile = moduleFile;         // (moduleId, name) => absoluter Pfad oder null
    this.uploadAsset = uploadAsset;       // ({ name, mime, length, stream }) => Promise<asset>
    this.handlers = new Map();
    this.latest = new Map();              // Modul-ID → zuletzt gesendete Daten
    this.server = null;
    this.port = null;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  handle(type, fn) {
    this.handlers.set(type, fn);
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.onRequest(req, res));
      server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        this.port = port;
        this.pingTimer = setInterval(() => this.ping(), PING_MS);
        resolve();
      });
    });
  }

  async close() {
    clearInterval(this.pingTimer);
    for (const ws of this.wss.clients) ws.terminate();
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise((resolve) => this.server.close(resolve));
    }
    this.server = null;
    this.port = null;
  }

  isLocalHost(req) {
    // Schützt vor DNS-Rebinding: fremde Domains, die auf 127.0.0.1 zeigen, werden abgewiesen
    return LOCAL_HOSTS.has((req.headers.host || '').replace(/:\d+$/, ''));
  }

  isAllowedOrigin(req) {
    const origin = req.headers.origin;
    return Boolean(origin) && this.allowedOrigins().includes(origin);
  }

  onRequest(req, res) {
    if (!this.isLocalHost(req)) {
      res.writeHead(403).end();
      return;
    }
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname === '/assets' && (req.method === 'POST' || req.method === 'OPTIONS')) {
      this.onUpload(req, res);
      return;
    }
    const match = /^\/assets\/([^/]+)$/.exec(pathname);
    if (match && (req.method === 'GET' || req.method === 'HEAD')) {
      this.serveFile(this.assetPath(match[1]), req, res);
      return;
    }
    const moduleMatch = /^\/files\/([\w-]+)\/([^/]+)$/.exec(pathname);
    if (moduleMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      let name = '';
      try {
        name = decodeURIComponent(moduleMatch[2]);
      } catch {
        // ungültiger Name → 404
      }
      this.serveFile(this.moduleFile?.(moduleMatch[1], name), req, res);
      return;
    }
    res.writeHead(pathname === '/' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'VentoView', version: this.version }));
  }

  async onUpload(req, res) {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403).end();
      return;
    }
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
      'Access-Control-Allow-Private-Network': 'true',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    const reply = (status, body) => {
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(body));
    };
    try {
      let name = '';
      try {
        name = decodeURIComponent(req.headers['x-file-name'] || '');
      } catch {
        // Unlesbarer Name – dann eben ohne
      }
      const asset = await this.uploadAsset({
        name,
        mime: (req.headers['content-type'] || '').split(';')[0].trim(),
        length: Number(req.headers['content-length']) || 0,
        stream: req,
      });
      reply(200, asset);
    } catch (err) {
      reply(400, { error: err.message });
    }
  }

  serveFile(file, req, res) {
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      const headers = {
        'Content-Type': MEDIA_TYPES[path.extname(file)] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
      };
      // Videos werden in Teilen geladen (Range-Requests)
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
          return;
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      fs.createReadStream(file).pipe(res);
    });
  }

  onUpgrade(req, socket, head) {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname !== '/ws' || !this.isLocalHost(req) || !this.isAllowedOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  onConnection(ws) {
    ws.alive = true;
    ws.modules = new Set();
    ws.designs = new Set();
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      this.onMessage(ws, msg);
    });
    this.send(ws, { type: 'hello', version: this.version });
  }

  async onMessage(ws, msg) {
    if (msg.type === 'subscribe' && typeof msg.module === 'string' && ws.modules.size < 50) {
      ws.modules.add(msg.module);
      this.send(ws, this.stateMessage(msg.module));
      return;
    }
    if (msg.type === 'watch' && typeof msg.design === 'string' && ws.designs.size < 50) {
      ws.designs.add(msg.design);
      const design = await this.handlers.get('design.get')?.({ id: msg.design });
      this.send(ws, { type: 'design', id: msg.design, design: design ?? null });
      return;
    }
    const handler = this.handlers.get(msg.type);
    if (!handler || msg.reqId == null) return;
    try {
      this.send(ws, { type: 'reply', reqId: msg.reqId, ok: true, result: await handler(msg) });
    } catch (err) {
      this.send(ws, { type: 'reply', reqId: msg.reqId, ok: false, error: err.message });
    }
  }

  stateMessage(id) {
    const { installed, status } = this.moduleState(id);
    return { type: 'state', module: id, installed, status, data: this.latest.get(id) ?? null };
  }

  ping() {
    for (const ws of this.wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }

  send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(filter, msg) {
    for (const ws of this.wss.clients) {
      if (filter(ws)) this.send(ws, msg);
    }
  }

  publish(id, data) {
    this.latest.set(id, data);
    this.broadcast((ws) => ws.modules.has(id), { type: 'data', module: id, data });
  }

  status(id, status) {
    this.broadcast((ws) => ws.modules.has(id), { type: 'status', module: id, status });
  }

  // Nach Installieren/Entfernen eines Moduls: allen Abonnenten den neuen Stand schicken
  moduleChanged(id) {
    if (!this.moduleState(id).installed) this.latest.delete(id);
    this.broadcast((ws) => ws.modules.has(id), this.stateMessage(id));
  }

  // Gespeichertes Design sofort an alle offenen Overlays schicken (kein Neuladen in OBS nötig)
  designChanged(id, design) {
    this.broadcast((ws) => ws.designs.has(id), { type: 'design', id, design });
  }
}

module.exports = { Bridge };
