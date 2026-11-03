const { spawn } = require('node:child_process');

/**
 * Vorlesen (Text-to-Speech) mit den Stimmen von Windows (System.Speech) – läuft offline auf diesem PC, der Text
 * verlässt ihn nicht. Ergebnis ist eine WAV-Datei, die Overlays als Ton-Ebene abspielen (so hört sie auch die
 * Streaming-Software). Immer nur eine Ausgabe gleichzeitig.
 */
const SPEAK = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:VV_TTS_VOICE) { try { $s.SelectVoice($env:VV_TTS_VOICE) } catch {} }
$s.Rate = [int]$env:VV_TTS_RATE
$s.Volume = [int]$env:VV_TTS_VOLUME
$s.SetOutputToWaveFile($env:VV_TTS_FILE)
$s.Speak($env:VV_TTS_TEXT)
$s.Dispose()
`;
const VOICES = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
foreach ($v in $s.GetInstalledVoices()) { if ($v.Enabled) { $i = $v.VoiceInfo; Write-Output ($i.Name + '|' + $i.Culture.Name + '|' + $i.Gender) } }
$s.Dispose()
`;
const TIMEOUT_MS = 20000;

// Links und lange Wiederholungen nicht vorlesen („aaaaaaa“ → „aaa“), Länge begrenzen
function speakable(text, max = 300) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/gi, 'Link')
    .replace(/(.)\1{3,}/g, '$1$1$1')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

class Speech {
  constructor() {
    this.queue = Promise.resolve();
    this.voiceList = null;
  }

  run(script, env = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
        windowsHide: true, env: { ...process.env, ...env },
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(err.trim().split(/\r?\n/)[0] || `Vorlesen fehlgeschlagen (${code})`));
      });
      child.stdin.end(script);
    });
  }

  // Installierte Stimmen: [{ name, culture, gender }] – einmal abgefragt
  async voices() {
    if (process.platform !== 'win32') return [];
    this.voiceList ||= this.run(VOICES).then((out) => out.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, culture, gender] = line.split('|');
      return { name, culture, gender };
    })).catch(() => {
      this.voiceList = null;
      return [];
    });
    return this.voiceList;
  }

  // Text → WAV-Datei. rate: -10 … 10, volume: 0 … 100
  speak(text, file, { voice = '', rate = 0, volume = 100 } = {}) {
    const say = speakable(text);
    if (!say) return Promise.reject(new Error('Nichts zum Vorlesen.'));
    if (process.platform !== 'win32') return Promise.reject(new Error('Vorlesen gibt es nur unter Windows.'));
    const job = this.queue.then(() => this.run(SPEAK, {
      VV_TTS_TEXT: say, VV_TTS_VOICE: String(voice || ''), VV_TTS_FILE: file,
      VV_TTS_RATE: String(Math.max(-10, Math.min(10, Math.round(Number(rate) || 0)))),
      VV_TTS_VOLUME: String(Math.max(0, Math.min(100, Math.round(Number(volume ?? 100))))),
    }));
    this.queue = job.catch(() => {});
    return job;
  }
}

module.exports = { Speech, speakable };
