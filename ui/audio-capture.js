// Live-Audio-Eingänge (Mikrofon, Line-In, virtuelle Kabel …): nimmt per Chromium auf und schickt Pakete
// (48 kHz, Stereo, 16 Bit) an die App. Ohne Bearbeitung – keine Rauschunterdrückung, kein automatischer Pegel.
//
// Gelesen wird direkt vom Gerät (MediaStreamTrackProcessor), im Takt des Mikrofons. Über ein AudioContext liefe der
// Ton zusätzlich im Takt der Lautsprecher – Chromium gleicht die Abweichung dort nicht aus, nach einer Weile wird
// der Ton körnig und bleibt es. Den Takt-Unterschied zum Abspielen regelt das Overlay selbst aus.
'use strict';

const running = new Map(); // Quelle → { stream, reader?, ctx?, stopped }

function stop(id) {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  r.stopped = true;
  r.reader?.cancel().catch(() => {});
  r.stream.getTracks().forEach((t) => t.stop());
  r.ctx?.close().catch(() => {});
}

// Geräte mit 44,1 kHz o. ä. auf 48 kHz umrechnen (linear, über Paketgrenzen hinweg)
function toPcm(L, R, rate, st) {
  if (rate === 48000) {
    const out = new Int16Array(L.length * 2);
    for (let i = 0; i < L.length; i++) {
      out[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767;
      out[2 * i + 1] = Math.max(-1, Math.min(1, R[i])) * 32767;
    }
    return out;
  }
  const step = rate / 48000;
  const samples = [];
  let pos = st.pos; // kann −1 … 0 sein: zwischen letztem Sample des vorigen Pakets und dem ersten hier
  while (pos < L.length - 1) {
    const i = Math.floor(pos);
    const f = pos - i;
    const l0 = i < 0 ? st.l : L[i];
    const r0 = i < 0 ? st.r : R[i];
    samples.push(l0 + (L[i + 1] - l0) * f, r0 + (R[i + 1] - r0) * f);
    pos += step;
  }
  st.pos = pos - L.length;
  st.l = L[L.length - 1];
  st.r = R[R.length - 1];
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
  return out;
}

async function pump(id, run) {
  const st = { pos: 0, l: 0, r: 0 };
  while (!run.stopped) {
    let frame;
    try {
      const res = await run.reader.read();
      if (res.done) break;
      frame = res.value;
    } catch {
      break;
    }
    const n = frame.numberOfFrames;
    const L = new Float32Array(n);
    let R = L;
    try {
      frame.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
      if (frame.numberOfChannels > 1) {
        R = new Float32Array(n);
        frame.copyTo(R, { planeIndex: 1, format: 'f32-planar' });
      }
      const pcm = toPcm(L, R, frame.sampleRate, st);
      if (pcm.length) window.vvAudio.push(id, pcm.buffer);
    } finally {
      frame.close();
    }
  }
}

// Ältere Chromium-Versionen ohne MediaStreamTrackProcessor: über ein AudioContext (kann mit der Zeit körnig werden)
async function startWithContext(id, stream) {
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.audioWorklet.addModule('audio-tap.js');
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'vv-tap');
  tap.port.onmessage = (event) => window.vvAudio.push(id, event.data);
  // Stumm an den Ausgang hängen, damit der Graph läuft – zu hören ist hier nichts
  const silent = ctx.createGain();
  silent.gain.value = 0;
  source.connect(tap).connect(silent).connect(ctx.destination);
  running.set(id, { stream, ctx, stopped: false });
}

async function start(id, deviceId) {
  stop(id);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
  });
  const track = stream.getAudioTracks()[0];
  if (typeof MediaStreamTrackProcessor === 'function') {
    const run = { stream, reader: new MediaStreamTrackProcessor({ track, maxBufferSize: 100 }).readable.getReader() /* 1 s Reserve, falls die Seite kurz hängt */, stopped: false };
    running.set(id, run);
    pump(id, run);
  } else {
    await startWithContext(id, stream);
  }
  // Gerät abgezogen: der App melden, sie versucht es neu
  track?.addEventListener('ended', () => {
    if (running.get(id)?.stream !== stream) return;
    stop(id);
    window.vvAudio.ended(id);
  });
}

window.vvAudio.onCommand(async (cmd) => {
  try {
    if (cmd.type === 'list') {
      // Ohne einmal erteilten Zugriff gibt es keine Namen – kurz öffnen und gleich wieder schließen
      let devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some((d) => d.kind === 'audioinput' && d.label)) {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        probe?.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      }
      window.vvAudio.reply(cmd.reqId, true, devices.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label })));
    } else if (cmd.type === 'start') {
      await start(cmd.id, cmd.deviceId);
      window.vvAudio.reply(cmd.reqId, true, null);
    } else if (cmd.type === 'stop') {
      stop(cmd.id);
    }
  } catch (err) {
    if (cmd.reqId) window.vvAudio.reply(cmd.reqId, false, err.message || String(err));
  }
});
