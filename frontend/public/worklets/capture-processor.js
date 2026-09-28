/**
 * GourMate — AudioWorklet capture processor.
 *
 * Receives 128-frame Float32 blocks from the input node, batches them into
 * ~2048-sample chunks and forwards them to the main thread. Downsampling to
 * 16 kHz mono Int16 happens on the main thread (src/lib/audio.ts).
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batchSize = 2048;
    this.buffer = new Float32Array(this.batchSize);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) {
      return true;
    }

    let read = 0;
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this.batchSize - this.offset);
      this.buffer.set(channel.subarray(read, read + take), this.offset);
      this.offset += take;
      read += take;

      if (this.offset >= this.batchSize) {
        // Copy out so the main thread owns its own memory.
        this.port.postMessage(this.buffer.slice(0));
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
