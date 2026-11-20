import test from "node:test";
import assert from "node:assert/strict";
import { AudioEngine } from "../src/audio-engine.js";

class FakeTrack extends EventTarget {
  readyState = "live";
  stop() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}

class FakeNode {
  connect() {}
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = { setValueAtTime() {}, setTargetAtTime() {} };
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  getFloatTimeDomainData(array) { array.fill(0); }
}

class FakeAudioContext {
  state = "running";
  currentTime = 1;
  createMediaStreamSource() { return new FakeNode(); }
  createGain() { return new FakeGain(); }
  createAnalyser() { return new FakeAnalyser(); }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
}

function makeStream() {
  const track = new FakeTrack();
  return { track, getAudioTracks: () => [track], getTracks: () => [track] };
}

async function withBrowserMocks(run, getUserMedia) {
  const saved = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
    isSecureContext: Object.getOwnPropertyDescriptor(globalThis, "isSecureContext"),
    AudioContext: Object.getOwnPropertyDescriptor(globalThis, "AudioContext"),
    requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame"),
    cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame"),
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia } } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "example.test" } });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
  try { await run(); }
  finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("starts once, reuses a live stream, and stops tracks", async () => {
  let calls = 0;
  const stream = makeStream();
  await withBrowserMocks(async () => {
    const engine = new AudioEngine();
    assert.equal(await engine.start(), true);
    assert.equal(await engine.start(), true);
    assert.equal(calls, 1);
    await engine.stop();
    assert.equal(stream.track.readyState, "ended");
  }, async () => { calls++; return stream; });
});

test("falls back to default mic when the selected device disappears", async () => {
  let calls = 0;
  const stream = makeStream();
  await withBrowserMocks(async () => {
    const engine = new AudioEngine({ deviceId: "missing-device" });
    assert.equal(await engine.start(), true);
    assert.equal(calls, 2);
    await engine.stop();
  }, async constraints => {
    calls++;
    if (constraints.audio.deviceId) {
      const error = new Error("Selected input not found"); error.name = "OverconstrainedError"; throw error;
    }
    return stream;
  });
});

test("does not retry a denied microphone permission", async () => {
  let calls = 0;
  await withBrowserMocks(async () => {
    const engine = new AudioEngine();
    await assert.rejects(engine.start(), { name: "NotAllowedError" });
    assert.equal(calls, 1);
    await engine.stop();
  }, async () => { calls++; const error = new Error("Permission denied"); error.name = "NotAllowedError"; throw error; });
});
