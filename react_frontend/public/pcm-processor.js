class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    // Target: 100ms chunks at 16kHz, 16-bit mono = 3200 bytes
    this._targetRate = 16000;
    this._bytesPerChunk = 3200;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const float32 = input[0];
    const ratio = this._targetRate / sampleRate;

    // Simple linear downsampling from AudioContext sampleRate to 16kHz
    if (ratio < 1) {
      let srcIndex = 0;
      while (srcIndex < float32.length) {
        const idx = Math.floor(srcIndex);
        if (idx < float32.length) {
          const s = Math.max(-1, Math.min(1, float32[idx]));
          const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
          this._buffer.push(val & 0xFF);
          this._buffer.push((val >> 8) & 0xFF);
        }
        srcIndex += 1 / ratio;
      }
    } else {
      // sampleRate matches or is lower — pass through
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
        this._buffer.push(val & 0xFF);
        this._buffer.push((val >> 8) & 0xFF);
      }
    }

    while (this._buffer.length >= this._bytesPerChunk) {
      const chunk = new Uint8Array(this._buffer.splice(0, this._bytesPerChunk));
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
