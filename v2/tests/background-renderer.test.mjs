import test from "node:test";
import assert from "node:assert/strict";
import { AvatarRenderer } from "../src/avatar-renderer.js";

test("video background source is reused, replaced and released safely", () => {
  const previousDocument = globalThis.document;
  const videos = [];
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "video");
      const video = {
        paused: true,
        pauseCount: 0,
        playCount: 0,
        pause() { this.paused = true; this.pauseCount++; },
        play() { this.paused = false; this.playCount++; return Promise.resolve(); },
        addEventListener() {},
        set src(value) { this._src = value; },
        get src() { return this._src; },
      };
      videos.push(video);
      return video;
    },
  };

  try {
    const renderer = Object.create(AvatarRenderer.prototype);
    renderer.backgroundVideo = null;
    renderer.backgroundVideoSrc = null;
    let draws = 0;
    renderer.drawOnce = () => { draws++; };

    renderer.setBackgroundVideo("signed-video-a");
    assert.equal(videos.length, 1);
    assert.equal(videos[0].loop, true);
    assert.equal(videos[0].muted, true);
    assert.equal(videos[0].playsInline, true);
    assert.equal(videos[0].playCount, 1);

    renderer.setBackgroundVideo("signed-video-a");
    assert.equal(videos.length, 1);

    renderer.setBackgroundVideo("signed-video-b");
    assert.equal(videos.length, 2);
    assert.equal(videos[0].pauseCount, 1);
    assert.equal(videos[1].playCount, 1);

    renderer.setBackgroundVideo(null);
    assert.equal(renderer.backgroundVideo, null);
    assert.equal(videos[1].pauseCount, 1);
    assert.ok(draws >= 3);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("video backgrounds are drawn only when media has decoded a frame", () => {
  const renderer = Object.create(AvatarRenderer.prototype);
  renderer.preferences = { background: { mode: "video" } };
  renderer.backgroundVideo = { readyState: 1, videoWidth: 320, videoHeight: 180 };
  renderer.backgroundImage = null;
  const draws = [];
  const ctx = { drawImage: (...args) => draws.push(args) };

  renderer.drawBackground(ctx, 640, 360);
  assert.equal(draws.length, 0);

  renderer.backgroundVideo.readyState = 2;
  renderer.drawBackground(ctx, 640, 360);
  assert.equal(draws.length, 1);
  assert.equal(draws[0][1], 0);
  assert.equal(draws[0][2], 0);
  assert.equal(draws[0][3], 640);
  assert.equal(draws[0][4], 360);
});
