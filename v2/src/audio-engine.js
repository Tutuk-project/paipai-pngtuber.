/**
 * Vio Studio microphone engine.
 * Processes audio locally. Only state transitions are intended for Broadcast.
 */
export class AudioEngine extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = {
      deviceId: "",
      boostDb: 6,
      sensitivity: 1,
      minThreshold: 0.010,
      noiseMultiplier: 3.2,
      hangoverMs: 190,
      calibrationMs: 1100,
      preferredAutoGainControl: true,
      preferredNoiseSuppression: true,
      preferredEchoCancellation: true,
      ...options,
    };
    this.stream = null;
    this.context = null;
    this.source = null;
    this.gain = null;
    this.analyser = null;
    this.samples = null;
    this.raf = 0;
    this.state = "idle";
    this.noiseFloor = 0.003;
    this.level = 0;
    this.speaking = false;
    this.releaseAt = 0;
    this.calibrationUntil = 0;
    this.lastEmit = 0;
    this.startPromise = null;
    this.generation = 0;
    this.resumeHandler = () => { this.resume().catch(error => this.#setStatus("resume-error", error)); };
    globalThis.addEventListener?.("focus", this.resumeHandler);
    globalThis.addEventListener?.("pageshow", this.resumeHandler);
    globalThis.document?.addEventListener?.("visibilitychange", () => {
      if (globalThis.document.visibilityState === "visible") this.resumeHandler();
    });
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.stream?.getAudioTracks().some(track => track.readyState === "live")) {
      await this.resume();
      if (!this.raf) this.#loop();
      return true;
    }
    const generation = ++this.generation;
    this.startPromise = this.#startInternal(generation).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #startInternal(generation) {
    if (!globalThis.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
      throw this.#fail("Mikrofon membutuhkan HTTPS atau secure context.", "SecurityError");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw this.#fail("Browser/WebView ini tidak menyediakan getUserMedia.", "NotSupportedError");
    }
    this.#setStatus("requesting");
    const preferredAudio = {
      echoCancellation: { ideal: this.options.preferredEchoCancellation },
      noiseSuppression: { ideal: this.options.preferredNoiseSuppression },
      autoGainControl: { ideal: this.options.preferredAutoGainControl },
    };
    let stream;
    try {
      if (this.options.deviceId) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { ...preferredAudio, deviceId: { exact: this.options.deviceId } },
            video: false,
          });
        } catch (selectedError) {
          // Do not retry a denied permission as though it were a missing device.
          if (["NotAllowedError", "SecurityError"].includes(selectedError?.name)) throw selectedError;
          this.#setStatus("device-fallback", selectedError);
          stream = await navigator.mediaDevices.getUserMedia({ audio: preferredAudio, video: false });
        }
      } else {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: preferredAudio, video: false });
        } catch (constraintError) {
          // A few Android/iOS WebViews reject constraint dictionaries. Retry with browser defaults.
          if (["NotAllowedError", "SecurityError"].includes(constraintError?.name)) throw constraintError;
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        }
      }
    } catch (captureError) {
      this.#setStatus("error", captureError);
      throw captureError;
    }
    if (generation !== this.generation) {
      stream.getTracks().forEach(track => track.stop());
      return false;
    }
    this.stream = stream;
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) {
      stream.getTracks().forEach(track => track.stop());
      this.stream = null;
      throw this.#fail("Web Audio API tidak tersedia.", "NotSupportedError");
    }
    try {
      try {
        this.context = new AudioContextClass({ latencyHint: "interactive" });
      } catch {
        this.context = new AudioContextClass();
      }
      this.source = this.context.createMediaStreamSource(stream);
      this.gain = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      this.samples = new Float32Array(this.analyser.fftSize);
      this.gain.gain.setValueAtTime(this.#gainValue(), this.context.currentTime);
      this.source.connect(this.gain);
      this.gain.connect(this.analyser);
      await this.resume();
    } catch (audioError) {
      stream.getTracks().forEach(track => { try { track.stop(); } catch {} });
      this.stream = null;
      for (const node of [this.source, this.gain, this.analyser]) { try { node?.disconnect(); } catch {} }
      this.source = this.gain = this.analyser = null;
      if (this.context && this.context.state !== "closed") { try { await this.context.close(); } catch {} }
      this.context = null;
      this.samples = null;
      throw this.#fail(audioError?.message || "AudioContext gagal diinisialisasi.", audioError?.name || "NotReadableError");
    }
    this.calibrationUntil = performance.now() + this.options.calibrationMs;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => this.#setStatus("track-ended"));
      track.addEventListener("mute", () => this.#setStatus("muted"));
      track.addEventListener("unmute", () => { if (this.context?.state === "running") this.#setStatus("active"); });
    }
    this.#setStatus("active");
    this.#loop();
    return true;
  }

  async resume() {
    if (this.context && this.context.state !== "running") await this.context.resume();
    if (this.context?.state === "running") this.#setStatus("active");
    return this.context?.state === "running";
  }

  setOptions(next = {}) {
    Object.assign(this.options, next);
    if (this.gain && this.context) {
      this.gain.gain.setTargetAtTime(this.#gainValue(), this.context.currentTime, 0.035);
    }
  }

  #gainValue() {
    const db = Math.max(0, Math.min(24, Number(this.options.boostDb) || 0));
    return Math.pow(10, db / 20);
  }

  #loop = () => {
    if (!this.analyser || !this.samples) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    const rms = Math.sqrt(sum / this.samples.length);
    this.level = this.level * 0.62 + rms * 0.38;
    const now = performance.now();
    const calibrating = now < this.calibrationUntil;
    const adaptationCeiling = Math.max(this.options.minThreshold * 1.7, this.noiseFloor * 3.2);
    const lowActivity = this.level < adaptationCeiling;
    if (lowActivity && !this.speaking) {
      // Track room noise slowly after initial calibration without learning ordinary speech.
      const rate = calibrating ? 0.045 : 0.004;
      this.noiseFloor = Math.min(0.08, this.noiseFloor * (1 - rate) + this.level * rate);
    }
    const base = Math.max(this.options.minThreshold, this.noiseFloor * this.options.noiseMultiplier);
    const threshold = Math.max(0.003, Math.min(0.12, base / Math.max(0.45, Math.min(2.5, Number(this.options.sensitivity) || 1))));
    const attack = threshold;
    const release = threshold * 0.68;
    if (this.level >= attack) {
      this.speaking = true;
      this.releaseAt = 0;
    } else if (this.speaking && this.level < release) {
      if (!this.releaseAt) this.releaseAt = now;
      if (now - this.releaseAt >= this.options.hangoverMs) this.speaking = false;
    }
    this.dispatchEvent(new CustomEvent("meter", { detail: { level: this.level, threshold, noiseFloor: this.noiseFloor, calibrating } }));
    const state = this.speaking ? "talking" : "idle";
    if (state !== this.state && (now - this.lastEmit) > 45) {
      this.state = state;
      this.lastEmit = now;
      this.dispatchEvent(new CustomEvent("state", { detail: { state, at: Date.now(), level: this.level, threshold } }));
    }
    this.raf = requestAnimationFrame(this.#loop);
  };

  #setStatus(status, error = null) {
    this.dispatchEvent(new CustomEvent("status", { detail: { status, error: error ? { name: error.name, message: error.message } : null } }));
  }

  #fail(message, name) {
    const error = new Error(message);
    error.name = name;
    this.#setStatus("error", error);
    return error;
  }

  async stop() {
    ++this.generation;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach(track => { try { track.stop(); } catch {} });
    this.stream = null;
    for (const node of [this.source, this.gain, this.analyser]) { try { node?.disconnect(); } catch {} }
    this.source = this.gain = this.analyser = null;
    this.samples = null;
    if (this.context && this.context.state !== "closed") {
      try { await this.context.close(); } catch {}
    }
    this.context = null;
    const wasTalking = this.state !== "idle";
    this.speaking = false;
    this.state = "idle";
    this.releaseAt = 0;
    this.level = 0;
    if (wasTalking) this.dispatchEvent(new CustomEvent("state", { detail: { state: "idle", at: Date.now(), level: 0, threshold: this.options.minThreshold } }));
    this.#setStatus("stopped");
  }
}
