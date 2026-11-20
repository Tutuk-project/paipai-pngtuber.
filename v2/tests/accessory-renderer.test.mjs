import test from "node:test";
import assert from "node:assert/strict";
import { AvatarRenderer } from "../src/avatar-renderer.js";

function createRenderer(accessories, motion = {}) {
  const calls = [];
  const ctx = {
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    drawImage: (...args) => calls.push(["drawImage", ...args]),
  };
  const renderer = Object.create(AvatarRenderer.prototype);
  renderer.accessories = accessories.map(item => ({
    ...item,
    image: { complete: true, naturalWidth: 100, naturalHeight: 100 },
  }));
  renderer.preferences = { mirror: true, effects: {} };
  renderer.avatarMotion = {
    centerX: 200, centerY: 200, rotation: 0,
    scaleX: 1, scaleY: 1, ...motion,
  };
  return { renderer, ctx, calls };
}

test("following accessories inherit avatar position, rotation and scale without mutating const coordinates", () => {
  const { renderer, ctx, calls } = createRenderer([
    { x: 0.75, y: 0.25, w: 0.2, h: 0.1, follow: true, mirror: true },
  ], { centerX: 300, centerY: 180, rotation: 0.35, scaleX: 0.5, scaleY: 0.5 });

  assert.doesNotThrow(() => renderer.drawAccessories(ctx, 400, 400, 1000));
  assert.ok(calls.some(call => call[0] === "translate" && call[1] === 300 && call[2] === 180));
  assert.ok(calls.some(call => call[0] === "rotate" && call[1] === 0.35));
  assert.ok(calls.some(call => call[0] === "scale" && call[1] === 0.5 && call[2] === 0.5));
  assert.ok(calls.some(call => call[0] === "translate" && call[1] === 100 && call[2] === -100));
  assert.ok(calls.some(call => call[0] === "drawImage" && call[2] === -40 && call[3] === -20 && call[4] === 80 && call[5] === 40));
});

test("non-following accessories stay at canvas-relative positions", () => {
  const { renderer, ctx, calls } = createRenderer([
    { x: 0.25, y: 0.75, w: 0.1, h: 0.2, follow: false },
  ]);

  renderer.drawAccessories(ctx, 400, 400, 1000);
  assert.ok(calls.some(call => call[0] === "translate" && call[1] === 100 && call[2] === 300));
  assert.equal(calls.some(call => call[0] === "rotate"), false);
});

test("accessory effects can be disabled independently", () => {
  const { renderer, ctx, calls } = createRenderer([
    { x: 0.5, y: 0.5, w: 0.2, h: 0.2, effectsEnabled: false },
  ]);
  renderer.preferences.effects = {
    filter: { enabled: true, hue: 90 },
    shadow: { enabled: true, intensity: 20 },
    glow: { enabled: true, intensity: 30 },
  };

  renderer.drawAccessories(ctx, 400, 400, 1000);
  assert.equal("filter" in ctx, false);
  assert.equal("shadowBlur" in ctx, false);
  assert.equal(calls.filter(call => call[0] === "drawImage").length, 1);
});
