// Verstecktes Fenster für Live-Video: nimmt Kameras (auch Capture-Karten und virtuelle Kameras), Bildschirme und
// Fenster auf und schickt sie per WebRTC an die Overlays – auf diesem PC, ohne Umweg über das Internet.
// Jede Quelle wird nur einmal aufgenommen, egal wie viele Overlays sie zeigen. Ohne Zuschauer geht sie kurz danach
// aus (die Kamera-Lampe auch). Dazu misst es grob die Bewegung im Bild ({videomotion}) und macht Fotos.
'use strict';

const api = window.vvVideo;
const IDLE_MS = 3000;
const MOTION_MS = 200;
const STATS_MS = 500;
const captures = new Map(); // key → { key, stream, peers: Set, video, idle, motion, ready }
const peers = new Map();    // peerId → { pc, key }

const send = (msg) => api.send(msg);
const asks = new Map(); // reqId → resolve (Rückfragen an die App)
let askSeq = 0;
function ask(msg) {
  const reqId = `a${++askSeq}`;
  return new Promise((resolve) => {
    asks.set(reqId, resolve);
    send({ ...msg, reqId });
    setTimeout(() => { if (asks.delete(reqId)) resolve(); }, 3000);
  });
}

// Bildschirm/Fenster: erst der alte Weg über getUserMedia (ohne Rückfrage), sonst getDisplayMedia – welche Quelle,
// sagt die App vorher dem Auswahl-Handler (setDisplayMediaRequestHandler)
async function open(source, quality) {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(source, quality));
  } catch (err) {
    if (source.kind === 'camera') throw err;
    await ask({ type: 'display-want', id: source.desktopId });
    return navigator.mediaDevices.getDisplayMedia({
      audio: false, video: { width: { ideal: quality.width }, height: { ideal: quality.height }, frameRate: { ideal: quality.fps } },
    });
  }
}

async function listCameras() {
  // Ohne erlaubten Zugriff gibt es keine Namen – einmal kurz öffnen und gleich wieder schließen
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === 'videoinput' && !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch { /* keine Kamera oder kein Zugriff */ }
  }
  return devices.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

function constraints(source, { width, height, fps }) {
  if (source.kind === 'camera') {
    return {
      audio: false,
      video: {
        ...(source.deviceId && source.deviceId !== 'default' ? { deviceId: { exact: source.deviceId } } : {}),
        width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps },
      },
    };
  }
  // Bildschirm oder Fenster (ID von desktopCapturer aus der App)
  return {
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.desktopId, maxWidth: width, maxHeight: height, maxFrameRate: fps } },
  };
}

async function capture(cmd) {
  let cap = captures.get(cmd.key);
  if (cap) {
    clearTimeout(cap.idle);
    await cap.ready;
    return cap;
  }
  cap = { key: cmd.key, src: cmd.src, stream: null, peers: new Set(), video: null, idle: null, motion: 0 };
  captures.set(cmd.key, cap);
  cap.ready = (async () => {
    const stream = await open(cmd.source, cmd.quality);
    const track = stream.getVideoTracks()[0];
    if (track) track.contentHint = cmd.source.kind === 'camera' ? 'motion' : 'detail';
    track?.addEventListener('ended', () => {
      // Kamera abgezogen, Fenster geschlossen: Overlays verbinden sich neu und versuchen es wieder
      for (const peerId of [...cap.peers]) closePeer(peerId, true);
      stop(cap);
    });
    cap.stream = stream;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    cap.video = video;
    watchMotion(cap);
  })();
  try {
    await cap.ready;
  } catch (err) {
    captures.delete(cmd.key);
    throw err;
  }
  return cap;
}

function stop(cap) {
  clearTimeout(cap.idle);
  clearInterval(cap.motionTimer);
  clearInterval(cap.statsTimer);
  cap.stream?.getTracks().forEach((t) => t.stop());
  if (cap.video) cap.video.srcObject = null;
  captures.delete(cap.key);
  send({ type: 'stats', key: cap.key, src: cap.src, running: false });
}

// Bewegung: kleines Graubild alle 200 ms, mittlere Änderung zum vorigen → 0 … 100
function watchMotion(cap) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  let last = null;
  cap.motionTimer = setInterval(() => {
    if (!cap.video?.videoWidth) return;
    g.drawImage(cap.video, 0, 0, 32, 18);
    const data = g.getImageData(0, 0, 32, 18).data;
    const gray = new Float32Array(32 * 18);
    for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11;
    if (last) {
      let sum = 0;
      for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - last[i]);
      const level = Math.min(100, (sum / gray.length / 255) * 100 * 6);
      cap.motion = cap.motion * 0.6 + level * 0.4; // etwas glätten, sonst zappelt der Wert
    }
    last = gray;
  }, MOTION_MS);
  cap.statsTimer = setInterval(() => {
    const settings = cap.stream?.getVideoTracks()[0]?.getSettings() || {};
    send({ type: 'stats', key: cap.key, src: cap.src, running: true, motion: Math.round(cap.motion), width: settings.width || 0, height: settings.height || 0, fps: Math.round(settings.frameRate || 0) });
  }, STATS_MS);
}

function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 2000); // auf diesem PC reicht, was bis dahin da ist
  });
}

async function startPeer(cmd) {
  const cap = await capture(cmd);
  const pc = new RTCPeerConnection({ iceServers: [] });
  peers.set(cmd.peerId, { pc, key: cmd.key });
  cap.peers.add(cmd.peerId);
  for (const track of cap.stream.getVideoTracks()) {
    const sender = pc.addTrack(track, cap.stream);
    // Lokal ist Bandbreite kein Thema: hohe Bitrate, damit Schrift und Gesichter scharf bleiben
    const params = sender.getParameters();
    params.encodings = [{ ...(params.encodings?.[0] || {}), maxBitrate: cmd.quality.height >= 1440 ? 40e6 : 20e6, maxFramerate: cmd.quality.fps }];
    params.degradationPreference = cmd.source.kind === 'camera' ? 'maintain-framerate' : 'maintain-resolution';
    await sender.setParameters(params).catch(() => {});
  }
  // H.264 zuerst: Windows kodiert es meist mit der Grafikkarte – weniger Last für den Prozessor
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs || [];
  const h264 = codecs.filter((c) => /h264/i.test(c.mimeType));
  if (h264.length) {
    for (const t of pc.getTransceivers()) t.setCodecPreferences?.([...h264, ...codecs.filter((c) => !/h264/i.test(c.mimeType))]);
  }
  pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'closed'].includes(pc.connectionState)) closePeer(cmd.peerId, true);
  });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  send({ type: 'offer', peerId: cmd.peerId, sdp: pc.localDescription.sdp });
}

function closePeer(peerId, notify = false) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peers.delete(peerId);
  peer.pc.close();
  const cap = captures.get(peer.key);
  if (notify) send({ type: 'gone', peerId });
  if (!cap) return;
  cap.peers.delete(peerId);
  if (!cap.peers.size) {
    clearTimeout(cap.idle);
    cap.idle = setTimeout(() => { if (!cap.peers.size) stop(cap); }, IDLE_MS);
  }
}

// Foto der laufenden Quelle in voller Größe (JPEG als data:-Adresse)
function snapshot(key) {
  const cap = captures.get(key);
  const video = cap?.video;
  if (!video?.videoWidth) throw new Error('Die Quelle läuft gerade nicht.');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}

api.onCommand(async (cmd) => {
  if (cmd.type === 'ack') {
    asks.get(cmd.reqId)?.();
    asks.delete(cmd.reqId);
    return;
  }
  try {
    if (cmd.type === 'list') send({ type: 'reply', reqId: cmd.reqId, ok: true, result: await listCameras() });
    else if (cmd.type === 'peer') await startPeer(cmd);
    else if (cmd.type === 'answer') await peers.get(cmd.peerId)?.pc.setRemoteDescription({ type: 'answer', sdp: cmd.sdp });
    else if (cmd.type === 'close') closePeer(cmd.peerId);
    else if (cmd.type === 'snapshot') send({ type: 'reply', reqId: cmd.reqId, ok: true, result: snapshot(cmd.key) });
  } catch (err) {
    if (cmd.reqId) send({ type: 'reply', reqId: cmd.reqId, ok: false, result: err.message });
    if (cmd.peerId && cmd.type === 'peer') {
      send({ type: 'error', peerId: cmd.peerId, message: err.name === 'NotReadableError' ? 'Die Kamera wird gerade von einem anderen Programm benutzt.' : err.name === 'NotFoundError' || err.name === 'OverconstrainedError' ? 'Quelle nicht gefunden.' : err.message });
      closePeer(cmd.peerId);
    }
  }
});
