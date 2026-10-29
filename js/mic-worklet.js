/* SwarLekh — sing-along microphone capture. Runs on the audio thread and hands
 * ~2048-sample blocks to the page for on-device pitch tracking. Nothing is
 * recorded, stored or sent anywhere. */
'use strict';
class SwarLekhMicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.block[this.filled++] = channel[i];
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('swarlekh-mic', SwarLekhMicCapture);
