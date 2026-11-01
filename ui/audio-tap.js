// Audio-Worklet: sammelt den Eingang zu 10-ms-Paketen (480 Stereo-Samples, 16 Bit) und schickt sie an die Seite
class VvTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(960);
    this.n = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const left = channels[0];
    const right = channels[1] || channels[0]; // Mono-Mikrofon: auf beide Seiten
    for (let i = 0; i < left.length; i++) {
      this.buf[this.n * 2] = Math.max(-1, Math.min(1, left[i])) * 32767;
      this.buf[this.n * 2 + 1] = Math.max(-1, Math.min(1, right[i])) * 32767;
      if (++this.n === 480) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(960);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('vv-tap', VvTap);
