import test from "node:test";
import assert from "node:assert/strict";
import { AvatarRenderer, averageVisibleColor, fisheyeWarpPixels, normalizeEffects } from "../src/avatar-renderer.js";

function makeContext() {
  const calls = [];
  return {
    calls,
    filter: "none",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetY: 0,
    save() { calls.push(["save"]); },
    restore() { calls.push(["restore"]); },
    translate(...args) { calls.push(["translate", ...args]); },
    rotate(...args) { calls.push(["rotate", ...args]); },
    scale(...args) { calls.push(["scale", ...args]); },
    drawImage(...args) { calls.push(["drawImage", ...args]); }
  };
}

function makeRenderer(items, effects = {}) {
  const renderer = Object.create(AvatarRenderer.prototype);
  renderer.accessories = items;
  renderer.state = "idle";
  renderer.preferences = { mirror: true, effects: { enabled: true, stickerEffectsEnabled: true, ...effects } };
  renderer.avatarMotion = { centerX: 100, centerY: 80, rotation: 0.25, scaleX: 2, scaleY: 2, mirror: true };
  return renderer;
}

const image = { complete: true, naturalWidth: 100, width: 100, height: 100 };

test("bloom dominant-color sampling ignores transparent pixels and has a fallback", () => {
  const pixels = new Uint8ClampedArray(64);
  pixels.set([255, 0, 0, 255], 0);
  pixels.set([0, 100, 200, 255], 16);
  assert.equal(averageVisibleColor(pixels), "rgb(128,50,100)");
  assert.equal(averageVisibleColor(new Uint8ClampedArray(8), "#123456"), "#123456");
});

test("renderer prunes stale signed-URL images while retaining current avatar, accessory and background assets", () => {
  const renderer = Object.create(AvatarRenderer.prototype);
  const stale = { onload: () => {}, onerror: () => {} };
  renderer.images = new Map([
    ["avatar-current", {}], ["accessory-current", {}], ["background-current", {}], ["expired-signed-url", stale]
  ]);
  renderer.assets = { idle: "avatar-current" };
  renderer.accessories = [{ src: "accessory-current" }];
  renderer.backgroundImageSrc = "background-current";
  renderer.pruneImageCache();
  assert.deepEqual([...renderer.images.keys()].sort(), ["accessory-current", "avatar-current", "background-current"]);
  assert.equal(stale.onload, null);
  assert.equal(stale.onerror, null);
});

test("Eagle Eye fisheye mapping preserves the center and is intensity controlled", () => {
  const width = 5, height = 5;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < source.length; i += 4) {
    source[i] = i / 4;
    source[i + 1] = 120;
    source[i + 2] = 220;
    source[i + 3] = 255;
  }
  const unchanged = fisheyeWarpPixels(source, width, height, 0);
  assert.deepEqual(unchanged, source);
  const warped = fisheyeWarpPixels(source, width, height, 100);
  const center = ((Math.floor(height / 2) * width) + Math.floor(width / 2)) * 4;
  assert.deepEqual([...warped.slice(center, center + 4)], [...source.slice(center, center + 4)]);
  assert.notDeepEqual(warped, source);
  assert.equal(warped.length, source.length);
});

test("effect preferences are normalized, clamped and backward compatible", () => {
  const effects = normalizeEffects({
    enabled: false,
    stickerEffectsEnabled: false,
    glow: { enabled: true, intensity: 140 },
    filter: {
      enabled: true, intensity: 999,
      states: ["invalid", "talkingBlink"],
      targets: ["avatar", "admin"],
      filter: { hue: 999, saturation: -10, brightness: 125 }
    }
  });
  assert.equal(effects.enabled, false);
  assert.equal(effects.stickerEffectsEnabled, false);
  assert.equal(effects.bloom.enabled, true);
  assert.equal(effects.bloom.intensity, 100);
  assert.equal(effects.filter.intensity, 100);
  assert.deepEqual(effects.filter.states, ["talking_blink"]);
  assert.deepEqual(effects.filter.targets, ["avatar"]);
  assert.equal(effects.filter.filter.hue, 180);
  assert.equal(effects.filter.filter.saturation, 0);
  assert.equal(effects.filter.filter.brightness, 125);
  const all = normalizeEffects({ filter: { enabled: true, states: ["all"], targets: ["all"] } });
  assert.deepEqual(all.filter.states, ["idle", "talking", "blink", "talking_blink"]);
  assert.deepEqual(all.filter.targets, ["avatar", "accessories"]);
});

test("legacy effects are filtered by state, target and global switches", () => {
  const renderer = Object.create(AvatarRenderer.prototype);
  renderer.preferences = {
    effects: {
      enabled: true,
      stickerEffectsEnabled: true,
      filter: { enabled: true, states: ["idle", "blink"], targets: ["avatar"], filter: { hue: 20 } },
      stroke: { enabled: true, states: ["talking_blink"], targets: ["accessories"] },
      shake: { enabled: true, states: ["all"], targets: ["all"] }
    }
  };
  assert.deepEqual(renderer.activeEffects("idle", "avatar"), ["filter", "shake"]);
  assert.deepEqual(renderer.activeEffects("talking_blink", "avatar"), ["shake"]);
  assert.deepEqual(renderer.activeEffects("talking_blink", "accessories", { effectsEnabled: true }), ["stroke", "shake"]);
  renderer.preferences.effects.stickerEffectsEnabled = false;
  assert.deepEqual(renderer.activeEffects("talking_blink", "accessories", { effectsEnabled: true }), []);
  renderer.preferences.effects.enabled = false;
  assert.deepEqual(renderer.activeEffects("idle", "avatar"), []);
});

test("legacy filter parameters include hue, saturation, brightness, contrast and color channels", () => {
  const renderer = Object.create(AvatarRenderer.prototype);
  renderer.preferences = { effects: { filter: { filter: { hue: 20, saturation: 125, brightness: 110, contrast: 90, invert: 15, grayscale: 5, sepia: 8 } } } };
  const filter = renderer.effectFilter(["filter"]);
  assert.match(filter, /hue-rotate\(20deg\)/);
  assert.match(filter, /saturate\(125%\)/);
  assert.match(filter, /brightness\(110%\)/);
  assert.match(filter, /contrast\(90%\)/);
  assert.match(filter, /invert\(15%\)/);
  assert.match(filter, /grayscale\(5%\)/);
  assert.match(filter, /sepia\(8%\)/);
});

test("following accessory inherits avatar position, rotation and scale", () => {
  const ctx = makeContext();
  const renderer = makeRenderer([{ image, x: 0.75, y: 0.25, w: 0.2, h: 0.25, follow: true }]);
  renderer.drawAccessories(ctx, 200, 160, 0);
  assert.ok(ctx.calls.some(call => call[0] === "translate" && call[1] === 100 && call[2] === 80));
  assert.ok(ctx.calls.some(call => call[0] === "rotate" && call[1] === 0.25));
  assert.ok(ctx.calls.some(call => call[0] === "scale" && call[1] === 2 && call[2] === 2));
  const draw = ctx.calls.find(call => call[0] === "drawImage");
  assert.equal(draw[4], 40);
  assert.equal(draw[5], 40);
});

test("independent accessory does not inherit avatar transforms", () => {
  const ctx = makeContext();
  const renderer = makeRenderer([{ image, x: 0.75, y: 0.25, w: 0.2, h: 0.25, follow: false }]);
  renderer.drawAccessories(ctx, 200, 160, 0);
  assert.ok(ctx.calls.some(call => call[0] === "translate" && call[1] === 150 && call[2] === 40));
  assert.equal(ctx.calls.filter(call => call[0] === "rotate").length, 0);
  assert.equal(ctx.calls.filter(call => call[0] === "scale").length, 0);
});

test("accessory mirror follows the avatar mirror switch instead of double-flipping", () => {
  const ctx = makeContext();
  const renderer = makeRenderer([{ image, x: 0.5, y: 0.5, w: 0.2, h: 0.2, follow: true, mirror: true }]);
  renderer.preferences.mirror = false;
  renderer.drawAccessories(ctx, 200, 160, 0);
  assert.equal(ctx.calls.some(call => call[0] === "scale" && call[1] === -1 && call[2] === 1), false);
});

test("accessory mirror and visual effects are applied only when enabled", () => {
  const ctx = makeContext();
  const renderer = makeRenderer(
    [{ image, x: 0.5, y: 0.5, w: 0.2, h: 0.2, follow: false, mirror: true, effectsEnabled: true }],
    { filter: { enabled: true, filter: { hue: 25 } }, bloom: { enabled: true, color: "#fff", intensity: 12 } }
  );
  renderer.drawAccessories(ctx, 200, 160, 0);
  assert.ok(ctx.calls.some(call => call[0] === "scale" && call[1] === -1 && call[2] === 1));
  assert.match(ctx.filter, /hue-rotate\(25deg\)/);
  assert.equal(ctx.shadowColor, "#fff");
  assert.equal(ctx.shadowBlur, 18);

  const clean = makeContext();
  makeRenderer([{ image, follow: false, effectsEnabled: false, mirror: false }], { filter: { enabled: true } }).drawAccessories(clean, 200, 160, 0);
  assert.equal(clean.filter, "none");
  assert.equal(clean.shadowBlur, 0);
});
