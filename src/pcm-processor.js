/**
 * PCM AudioWorklet Processor
 * 
 * Runs on audio thread — captures raw samples, converts to 16kHz mono PCM s16le,
 * and buffers 200ms before sending (proven optimal from desktop app).
 * 
 * Input: Float32 samples from AudioContext (already at 16kHz via sampleRate option)
 * Output: Int16 PCM buffers posted to main thread via MessagePort
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._bufferSize = 3200; // 200ms at 16kHz = 3200 samples
    this._totalSamples = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0]; // first input, first channel (mono)
    if (!input || input.length === 0) return true;

    // Accumulate samples
    for (let i = 0; i < input.length; i++) {
      this._buffer.push(input[i]);
    }

    // Flush when buffer is full (200ms chunks)
    while (this._buffer.length >= this._bufferSize) {
      const chunk = this._buffer.splice(0, this._bufferSize);

      // Convert Float32 [-1, 1] → Int16 [-32768, 32767] (s16le)
      const pcm16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      this._totalSamples += pcm16.length;
      this.port.postMessage({
        type: 'pcm-data',
        buffer: pcm16.buffer,
        samples: pcm16.length,
      }, [pcm16.buffer]);
    }

    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
