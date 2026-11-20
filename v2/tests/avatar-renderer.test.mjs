import test from "node:test";
import assert from "node:assert/strict";
import { AvatarRenderer } from "../src/avatar-renderer.js";

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
  renderer.preferences = { mirror: true, effects };
  renderer.avatarMotion = { centerX: 100, centerY: 80, rotation: 0.25, scaleX: -2, scaleY: 2 };
  return renderer;
}

const image = { complete: true, naturalWidth: 100, width: 100, height: 100 };

test("following accessory inherits avatar position, rotation and scale", () => {
  const ctx = makeContext();
  const renderer = makeRenderer([{ image, x: 0.75, y: 0.25, w: 0.2, h: 0.25, follow: true }]);
  renderer.drawAccessories(ctx, 200, 160, 0);
  assert.ok(ctx.calls.some(call => call[0] === "translate" && call[1] === 100 && call[2] === 80));
  assert.ok(ctx.calls.some(call => call[0] === "rotate" && call[1] === 0.25));
  assert.ok(ctx.calls.some(call => call[0] === "scale" && call[1] === -2 && call[2] === 2));
  const draw = ctx.calls.find(call => call[0] === "drawImage");
  assert.equal(draw[4], 40);
  assert.equal(draw[5], 40);
});

test("independent accessory does not inherit avatar transforms", () => {
  const ctx = makeContext();
  const renderer = makeRenderer([{ image, x: 0.75, y: 0.25, w: 0.2, h: 0.25, follow: false }]);
  renderer.drawAccessories(ctx, 200, 160, 0);
  assert.ok(ctx.calls.some(call => call[0] === "translate" && call[1] === 50 && call[2] === -40));
  assert.equal(ctx.calls.filter(call => call[0] === "rotate").length, 0);
  assert.equal(ctx.calls.filter(call => call[0] === "scale").length, 0);
});

test("accessory mirror and visual effects are applied only when enabled", () => {
  const ctx = makeContext();
  const renderer = makeRenderer(
    [{ image, x: 0.5, y: 0.5, w: 0.2, h: 0.2, follow: false, mirror: true, effectsEnabled: true }],
    { filter: { enabled: true, hue: 25 }, glow: { enabled: true, color: "#fff", intensity: 12 } }
  );
  renderer.drawAccessories(ctx, 200, 160, 0);
  assert.ok(ctx.calls.some(call => call[0] === "scale" && call[1] === -1 && call[2] === 1));
  assert.match(ctx.filter, /hue-rotate\(25deg\)/);
  assert.equal(ctx.shadowColor, "#fff");
  assert.equal(ctx.shadowBlur, 8);

  const clean = makeContext();
  makeRenderer([{ image, follow: false, effectsEnabled: false, mirror: false }], { filter: { enabled: true } }).drawAccessories(clean, 200, 160, 0);
  assert.equal(clean.filter, "none");
  assert.equal(clean.shadowBlur, 0);
});
