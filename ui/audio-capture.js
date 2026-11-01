// Live-Audio-Eingänge (Mikrofon, Line-In, virtuelle Kabel …): nimmt per Chromium auf und schickt 10-ms-Pakete
// (48 kHz, Stereo, 16 Bit) an die App. Ohne Bearbeitung – keine Rauschunterdrückung, kein automatischer Pegel.
'use strict';

const running = new Map(); // Quelle → { stream, ctx }

function stop(id) {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  r.stream.getTracks().forEach((t) => t.stop());
  r.ctx.close().catch(() => {});
}

async function start(id, deviceId) {
  stop(id);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
  });
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.audioWorklet.addModule('audio-tap.js');
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'vv-tap');
  tap.port.onmessage = (event) => window.vvAudio.push(id, event.data);
  // Stumm an den Ausgang hängen, damit der Graph läuft – zu hören ist hier nichts
  const silent = ctx.createGain();
  silent.gain.value = 0;
  source.connect(tap).connect(silent).connect(ctx.destination);
  // Gerät abgezogen: der App melden, sie versucht es neu
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (running.get(id)?.stream !== stream) return;
    stop(id);
    window.vvAudio.ended(id);
  });
  running.set(id, { stream, ctx });
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
