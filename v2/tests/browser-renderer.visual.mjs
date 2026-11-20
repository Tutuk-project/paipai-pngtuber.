import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(new URL("..", import.meta.url).pathname);
const rendererPath = resolve(root, "src/avatar-renderer.js");
const html = `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<canvas id="stage" width="360" height="640"></canvas>
<script type="module">
  import { AvatarRenderer } from "/src/avatar-renderer.js";
  const makeAsset = (color, accent) => {
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 160, 180);
    gradient.addColorStop(0, color); gradient.addColorStop(1, accent);
    ctx.fillStyle = gradient; ctx.beginPath(); ctx.ellipse(80, 90, 58, 78, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(60, 75, 8, 0, Math.PI * 2); ctx.arc(100, 75, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(80, 108, 22, 0.15, Math.PI - 0.15); ctx.stroke();
    return canvas.toDataURL("image/png");
  };
  const avatarSrc = makeAsset("#b58cff", "#f58ebc");
  const accessorySrc = makeAsset("#ffd166", "#ef476f");
  const canvas = document.getElementById("stage");
  const renderer = new AvatarRenderer(canvas);
  renderer.setAssets({ idle: avatarSrc, talking: avatarSrc });
  renderer.setAccessories([{ src: accessorySrc, x: 0.76, y: 0.26, w: 0.22, h: 0.24, follow: true, mirror: true, effectsEnabled: true }]);
  renderer.setPreferences({
    outputWidth: 360, outputHeight: 640, scale: 0.9, mirror: true, breathing: 2, bounce: 0.02, squash: 0.07, sway: 2,
    background: { mode: "gradient", color1: "#182848", color2: "#4b6cb7", angle: 135 },
    effects: {
      enabled: true, stickerEffectsEnabled: true,
      filter: { enabled: true, intensity: 70, states: ["all"], targets: ["all"], filter: { hue: 18, saturation: 125, brightness: 108, contrast: 110, invert: 0, grayscale: 0, sepia: 4 } },
      stroke: { enabled: true, intensity: 60, thickness: 5, color: "#ffffff", states: ["all"], targets: ["all"] },
      shadow: { enabled: true, intensity: 24, color: "#111111", states: ["all"], targets: ["all"] },
      bloom: { enabled: true, intensity: 42, color: "#ffcf9d", states: ["all"], targets: ["all"] },
      distort: { enabled: true, intensity: 18, states: ["all"], targets: ["all"] },
      eagle: { enabled: true, intensity: 35, states: ["all"], targets: ["all"] },
      shake: { enabled: true, intensity: 8, states: ["all"], targets: ["all"] }
    }
  });
  await Promise.all([...renderer.images.values()].filter(Boolean).map(image => image.decode()));
  renderer.setState("talking");
  const common = {
    outputWidth: 360, outputHeight: 640, scale: 0.9, mirror: true, breathing: 2, bounce: 0.02, sway: 2,
    background: { mode: "gradient", color1: "#182848", color2: "#4b6cb7", angle: 135 }
  };
  const hashPixels = () => {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 7) { hash ^= data[i]; hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
  };
  renderer.setPreferences({ ...common, effects: { enabled: false, stickerEffectsEnabled: true } });
  renderer.setState("talking"); renderer.render(1700);
  const baselineHash = hashPixels();
  const effectConfigs = {
    filter: { enabled: true, intensity: 80, states: ["all"], targets: ["all"], filter: { hue: 115, saturation: 165, brightness: 115, contrast: 125, invert: 0, grayscale: 0, sepia: 0 } },
    stroke: { enabled: true, intensity: 80, thickness: 12, color: "#ff00cc", states: ["all"], targets: ["all"] },
    shadow: { enabled: true, intensity: 80, color: "#ff0000", states: ["all"], targets: ["all"] },
    bloom: { enabled: true, intensity: 80, color: "#00ff99", states: ["all"], targets: ["all"] },
    distort: { enabled: true, intensity: 80, states: ["all"], targets: ["all"] },
    eagle: { enabled: true, intensity: 80, states: ["all"], targets: ["all"] },
    shake: { enabled: true, intensity: 80, states: ["all"], targets: ["all"] }
  };
  const effectHashes = {};
  for (const [key, config] of Object.entries(effectConfigs)) {
    renderer.setPreferences({ ...common, effects: { enabled: true, stickerEffectsEnabled: true, [key]: config } });
    renderer.setState("talking"); renderer.render(1700);
    effectHashes[key] = hashPixels();
  }
  const ctx = canvas.getContext("2d");
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let visible = 0; const colors = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] > 0) visible++;
    if (pixels[i + 3] > 200 && colors.size < 5000) colors.add(pixels[i] + "," + pixels[i + 1] + "," + pixels[i + 2]);
  }
  window.__vioVisual = { width: canvas.width, height: canvas.height, visiblePixels: visible, uniqueColors: colors.size, imageCacheSize: renderer.images.size, effectCacheReady: !!renderer.effectCache, baselineHash, effectHashes };
</script></body></html>`;

const server = createServer(async (request, response) => {
  if (request.url === "/test.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.url === "/src/avatar-renderer.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(await readFile(rendererPath));
    return;
  }
  response.writeHead(404); response.end("Not found");
});
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${address.port}/test.html`);
  await page.waitForFunction(() => Boolean(window.__vioVisual), { timeout: 15000 });
  const result = await page.evaluate(() => window.__vioVisual);
  assert.deepEqual(errors, [], `Browser renderer errors: ${errors.join("; ")}`);
  assert.equal(result.width, 360);
  assert.equal(result.height, 640);
  assert.ok(result.visiblePixels > 10000, "Renderer should produce a visible non-empty canvas.");
  assert.ok(result.uniqueColors > 20, "Effects and gradients should produce varied pixel output.");
  assert.equal(Object.keys(result.effectHashes).length, 7);
  for (const [effect, hash] of Object.entries(result.effectHashes)) {
    assert.notEqual(hash, result.baselineHash, `${effect} should visibly change rendered pixels.`);
  }
  assert.equal(result.imageCacheSize, 2, "Avatar and accessory images should be the only retained image sources.");
  console.log("PASS browser renderer visual smoke:", JSON.stringify(result));
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
