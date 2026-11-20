const EFFECT_STATES = ["idle", "talking", "blink", "talking_blink"];
const EFFECT_KEYS = ["filter", "stroke", "shadow", "bloom", "distort", "eagle", "shake"];
const EFFECT_DEFAULTS = {
  filter: { enabled: false, intensity: 55, color: "#ffd7b8", thickness: 8, invert: false, filter: { hue: 0, saturation: 100, brightness: 100, contrast: 100, invert: 0, grayscale: 0, sepia: 0 }, states: [...EFFECT_STATES], targets: ["avatar", "accessories"] },
  stroke: { enabled: false, intensity: 55, color: "#ffffff", thickness: 8, invert: false, states: [...EFFECT_STATES], targets: ["avatar", "accessories"] },
  shadow: { enabled: false, intensity: 55, color: "#101010", thickness: 8, invert: false, states: [...EFFECT_STATES], targets: ["avatar", "accessories"] },
  bloom: { enabled: false, intensity: 55, color: "#ffd7b8", thickness: 8, invert: false, states: [...EFFECT_STATES], targets: ["avatar", "accessories"] },
  distort: { enabled: false, intensity: 20, color: "#ffd7b8", thickness: 8, invert: false, states: [...EFFECT_STATES], targets: ["avatar", "accessories"] },
  eagle: { enabled: false, intensity: 55, color: "#ffd7b8", thickness: 8, invert: false, states: [...EFFECT_STATES], targets: ["avatar", "accessories"] },
  shake: { enabled: false, intensity: 55, color: "#ffd7b8", thickness: 8, invert: false, states: [...EFFECT_STATES], targets: ["avatar", "accessories"] }
};
const DEFAULTS = {
  scale: 1, mirror: true, bounce: 0.035, sway: 0, breathing: 0, blinkRate: 4,
  fps: 30, outputWidth: 1080, outputHeight: 1920, offsetX: 0, offsetY: 0,
  background: { mode: "transparent", color: "#11151b", color1: "#254c4a", color2: "#e2b48c", angle: 135 },
  effects: { enabled: false, stickerEffectsEnabled: true, ...structuredClone(EFFECT_DEFAULTS) }
};

function normalizeEffects(input = {}) {
  const source = { ...(input || {}) };
  if (source.glow && !source.bloom) source.bloom = source.glow;
  const hasLegacyEffect = EFFECT_KEYS.some(key => source[key] && typeof source[key] === "object");
  const effects = {
    enabled: source.enabled ?? hasLegacyEffect,
    stickerEffectsEnabled: source.stickerEffectsEnabled ?? true
  };
  for (const key of EFFECT_KEYS) {
    const incoming = source[key] || {};
    effects[key] = {
      ...structuredClone(EFFECT_DEFAULTS[key]),
      ...incoming,
      filter: key === "filter" ? { ...EFFECT_DEFAULTS.filter.filter, ...(incoming.filter || {}) } : incoming.filter,
      states: Array.isArray(incoming.states) ? incoming.states.map(state => state === "talkingBlink" ? "talking_blink" : state) : [...EFFECT_STATES],
      targets: Array.isArray(incoming.targets) ? [...incoming.targets] : ["avatar", "accessories"]
    };
  }
  return effects;
}

export class AvatarRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.assets = {};
    this.images = new Map();
    this.effectCache = new WeakMap();
    this.accessories = [];
    this.state = "idle";
    this.preferences = structuredClone(DEFAULTS);
    this.running = false;
    this.raf = 0;
    this.lastFrame = 0;
    this.nextBlinkAt = 0;
    this.blinkUntil = 0;
    this.backgroundImage = null;
    this.backgroundVideo = null;
    this.avatarMotion = { centerX: canvas.width / 2, centerY: canvas.height / 2, rotation: 0, scaleX: 1, scaleY: 1 };
    this.boundFrame = time => this.frame(time);
  }

  image(src) {
    if (!src) return null;
    if (this.images.has(src)) return this.images.get(src);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => this.drawOnce();
    image.onerror = () => this.images.set(src, null);
    image.src = src;
    this.images.set(src, image);
    return image;
  }

  setAssets(assets = {}) {
    this.assets = { ...assets };
    Object.values(this.assets).forEach(src => this.image(src));
    this.drawOnce();
  }

  setState(state) {
    this.state = state === "talking" ? "talking" : "idle";
  }

  setPreferences(preferences = {}) {
    this.preferences = {
      ...structuredClone(DEFAULTS),
      ...preferences,
      background: { ...DEFAULTS.background, ...(preferences.background || {}) },
      effects: normalizeEffects(preferences.effects || {})
    };
    const background = this.preferences.background;
    if (background.mode === "video") {
      this.setBackgroundImage(null);
      this.setBackgroundVideo(background.src || null);
    } else {
      this.setBackgroundVideo(null);
      this.setBackgroundImage(background.mode === "image" ? background.src || null : null);
    }
    this.drawOnce();
  }

  setAccessories(items = []) {
    this.accessories = items.map(item => ({ ...item, image: this.image(item.src) }));
    this.drawOnce();
  }

  setBackgroundImage(src) {
    this.backgroundImage = src ? this.image(src) : null;
    this.drawOnce();
  }

  setBackgroundVideo(src) {
    if (src === this.backgroundVideoSrc) return;
    this.backgroundVideo?.pause?.();
    this.backgroundVideo = null;
    this.backgroundVideoSrc = src || null;
    if (src) {
      const video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      video.addEventListener("loadeddata", () => this.drawOnce(), { once: true });
      video.src = src;
      this.backgroundVideo = video;
      video.play().catch(() => {});
    }
    this.drawOnce();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.raf = requestAnimationFrame(this.boundFrame);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  drawOnce() {
    if (!this.running) this.render(performance.now());
  }

  frame(now) {
    if (!this.running) return;
    const fps = Math.max(10, Math.min(60, Number(this.preferences.fps) || 30));
    const interval = 1000 / fps;
    if (now - this.lastFrame >= interval) {
      this.lastFrame = now;
      this.render(now);
    }
    this.raf = requestAnimationFrame(this.boundFrame);
  }

  render(now) {
    const { canvas, ctx } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    this.drawBackground(ctx, W, H);
    if (!this.nextBlinkAt) this.nextBlinkAt = now + this.blinkDelay();
    if (now >= this.nextBlinkAt) {
      this.blinkUntil = now + 130;
      this.nextBlinkAt = now + this.blinkDelay();
    }
    const blinking = now < this.blinkUntil;
    const expression = this.state === "talking"
      ? (blinking ? "talking_blink" : "talking")
      : (blinking ? "blink" : "idle");
    const image = this.image(this.assets[expression] || this.assets[this.state] || this.assets.idle || this.assets.talking);
    if (image?.complete && image.naturalWidth) this.drawAvatar(ctx, image, W, H, now, expression);
    this.drawAccessories(ctx, W, H, now, expression);
  }

  blinkDelay() {
    const rate = Math.max(0.5, Math.min(12, Number(this.preferences.blinkRate) || 4));
    return 60000 / rate * (0.7 + Math.random() * 0.6);
  }

  drawBackground(ctx, W, H) {
    const bg = this.preferences.background || {};
    if (bg.mode === "solid") {
      ctx.fillStyle = bg.color || "#11151b";
      ctx.fillRect(0, 0, W, H);
    } else if (bg.mode === "gradient") {
      const angle = (Number(bg.angle) || 135) * Math.PI / 180;
      const cx = W / 2, cy = H / 2, len = Math.max(W, H) / 2;
      const grad = ctx.createLinearGradient(cx - Math.cos(angle) * len, cy - Math.sin(angle) * len, cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
      grad.addColorStop(0, bg.color1 || "#254c4a");
      grad.addColorStop(1, bg.color2 || "#e2b48c");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    } else if (bg.mode === "image" && this.backgroundImage?.complete && this.backgroundImage.naturalWidth) {
      this.drawCover(ctx, this.backgroundImage, W, H);
    } else if (bg.mode === "video" && this.backgroundVideo?.readyState >= 2) {
      this.drawCover(ctx, this.backgroundVideo, W, H);
    }
  }

  drawCover(ctx, image, W, H) {
    const scale = Math.max(W / image.videoWidth || W / image.width, H / image.videoHeight || H / image.height);
    const width = (image.videoWidth || image.width) * scale;
    const height = (image.videoHeight || image.height) * scale;
    ctx.drawImage(image, (W - width) / 2, (H - height) / 2, width, height);
  }

  activeEffects(state, target, item = null) {
    const effects = this.preferences.effects || {};
    const globalEnabled = effects.enabled ?? EFFECT_KEYS.some(key => effects[key]?.enabled || (key === "bloom" && effects.glow?.enabled));
    if (!globalEnabled || (target === "accessories" && (effects.stickerEffectsEnabled === false || item?.effectsEnabled === false))) return [];
    return EFFECT_KEYS.filter(key => {
      const effect = key === "bloom" && !effects.bloom ? effects.glow : effects[key];
      if (!effect?.enabled) return false;
      const states = effect.states || EFFECT_STATES;
      const targets = effect.targets || ["avatar", "accessories"];
      return (states.includes("all") || states.includes(state) || (state === "talking_blink" && states.includes("talkingBlink")))
        && (targets.includes("all") || targets.includes(target));
    });
  }

  effectFilter(ids) {
    if (!ids.includes("filter")) return "none";
    const filter = this.preferences.effects.filter.filter || {};
    return `hue-rotate(${Number(filter.hue) || 0}deg) saturate(${Number(filter.saturation ?? 100)}%) brightness(${Number(filter.brightness ?? 100)}%) contrast(${Number(filter.contrast ?? 100)}%) invert(${Number(filter.invert) || 0}%) grayscale(${Number(filter.grayscale) || 0}%) sepia(${Number(filter.sepia) || 0}%)`;
  }

  effectSprite(image, ids) {
    if (!ids.length || typeof document === "undefined") return { canvas: image, pad: 0, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
    if (!this.effectCache) this.effectCache = new WeakMap();
    const effects = this.preferences.effects;
    const signature = ids.map(key => `${key}:${JSON.stringify(effects[key])}`).join("|");
    let cache = this.effectCache.get(image);
    if (!cache) { cache = new Map(); this.effectCache.set(image, cache); }
    if (cache.has(signature)) return cache.get(signature);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const stroke = ids.includes("stroke") ? effects.stroke : null;
    const pad = stroke ? Math.max(2, Math.min(32, Number(stroke.thickness) || 8)) : 0;
    const canvas = document.createElement("canvas");
    canvas.width = width + pad * 2;
    canvas.height = height + pad * 2;
    const ctx = canvas.getContext("2d");
    const shadow = ids.includes("shadow") ? effects.shadow : null;
    const bloom = ids.includes("bloom") ? (effects.bloom || effects.glow) : null;
    if (shadow) {
      ctx.save();
      ctx.shadowColor = shadow.color || "#101010";
      ctx.shadowBlur = Math.max(0, Number(shadow.intensity) || 0) * 0.28;
      ctx.shadowOffsetY = Math.max(0, Number(shadow.intensity) || 0) * 0.1;
      ctx.drawImage(image, pad, pad, width, height);
      ctx.restore();
    }
    if (bloom) {
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.shadowColor = bloom.color || "#ffd7b8";
      ctx.shadowBlur = 12 + Math.max(0, Number(bloom.intensity) || 0) * 0.5;
      ctx.globalAlpha = 0.8;
      ctx.drawImage(image, pad, pad, width, height);
      ctx.filter = `blur(${Math.max(2, Number(bloom.intensity) * 0.12)}px) brightness(2.1) saturate(1.6)`;
      ctx.drawImage(image, pad, pad, width, height);
      ctx.restore();
    }
    if (stroke) {
      const mask = document.createElement("canvas");
      mask.width = canvas.width; mask.height = canvas.height;
      const maskCtx = mask.getContext("2d");
      maskCtx.drawImage(image, pad, pad, width, height);
      maskCtx.globalCompositeOperation = "source-in";
      maskCtx.fillStyle = stroke.color || "#ffffff";
      maskCtx.fillRect(0, 0, mask.width, mask.height);
      ctx.save();
      if (!stroke.invert) {
        const thickness = pad;
        for (let angle = 0; angle < 8; angle++) {
          const rad = angle * Math.PI / 4;
          ctx.drawImage(mask, Math.cos(rad) * thickness, Math.sin(rad) * thickness);
        }
      } else {
        ctx.drawImage(image, pad, pad, width, height);
        ctx.globalCompositeOperation = "source-atop";
        ctx.strokeStyle = stroke.color || "#ffffff";
        ctx.lineWidth = pad;
        ctx.strokeRect(pad, pad, width, height);
      }
      ctx.restore();
    }
    ctx.save();
    ctx.filter = this.effectFilter(ids);
    ctx.drawImage(image, pad, pad, width, height);
    ctx.restore();
    const result = { canvas, pad, width, height };
    cache.set(signature, result);
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return result;
  }

  drawEffectSprite(ctx, sprite, x, y, width, height, ids, now) {
    const { canvas, pad } = sprite;
    const sourceWidth = sprite.width + pad * 2;
    const sourceHeight = sprite.height + pad * 2;
    if (ids.includes("distort")) {
      const strength = Math.max(0, Math.min(1, Number(this.preferences.effects.distort.intensity) / 100 || 0.2));
      const rows = 36;
      for (let row = 0; row < rows; row++) {
        const sourceY = row * sourceHeight / rows;
        const sliceHeight = sourceHeight / rows + 1;
        const offset = Math.sin(now / 95 + row * 0.42) * strength * 18 * (width / sourceWidth);
        ctx.drawImage(canvas, 0, sourceY, sourceWidth, sliceHeight, x + offset, y + sourceY * (height / sourceHeight), width, sliceHeight * (height / sourceHeight) + 1);
      }
    } else {
      ctx.drawImage(canvas, x, y, width, height);
    }
    if (ids.includes("eagle")) {
      const intensity = Math.max(0, Math.min(1, Number(this.preferences.effects.eagle.intensity) / 100 || 0.55));
      const radius = Math.min(width, height) * (0.22 + intensity * 0.12);
      ctx.save();
      ctx.beginPath(); ctx.arc(x + width / 2, y + height / 2, radius, 0, Math.PI * 2); ctx.clip();
      const zoom = 1 + intensity * 0.55;
      const zoomW = width * zoom, zoomH = height * zoom;
      ctx.drawImage(canvas, x + (width - zoomW) / 2, y + (height - zoomH) / 2, zoomW, zoomH);
      ctx.restore();
    }
  }

  drawAvatar(ctx, image, W, H, now, expression = this.state) {
    const p = this.preferences;
    const effects = p.effects || {};
    const ids = this.activeEffects(expression, "avatar");
    const fit = Math.min(W / image.width, H / image.height);
    const breath = Math.sin(now / 1750 * Math.PI * 2) * (Number(p.breathing) || 0) / 100;
    const scale = fit * Math.max(0.1, Math.min(4, Number(p.scale) || 1)) * (1 + breath);
    const width = image.width * scale, height = image.height * scale;
    const talking = expression === "talking" || expression === "talking_blink";
    const phase = (now % 240) / 240;
    const bounce = talking ? Math.abs(Math.sin(phase * Math.PI)) * (Number(p.bounce) || 0) * height : Math.sin(now / 520) * 0.006 * height;
    const sway = Number(p.sway) || 0;
    const rotation = sway ? Math.sin(now / (talking ? 570 : 1400)) * sway * Math.PI / 180 : 0;
    const shake = ids.includes("shake") ? Math.max(0, Math.min(1, Number(effects.shake.intensity) / 100 || 0.55)) : 0;
    const shakeX = shake ? Math.sin(now / 19) * Math.cos(now / 31) * shake * 24 : 0;
    const shakeY = shake ? Math.cos(now / 17) * Math.sin(now / 27) * shake * 24 : 0;
    const centerX = W / 2 + (Number(p.offsetX) || 0) + shakeX;
    const centerY = H / 2 + (Number(p.offsetY) || 0) - bounce + shakeY;
    this.avatarMotion = { centerX, centerY, rotation, scaleX: scale * (p.mirror === false ? 1 : -1), scaleY: scale, shakeX, shakeY };
    const sprite = this.effectSprite(image, ids);
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(rotation);
    ctx.scale(p.mirror === false ? 1 : -1, 1);
    const shadow = ids.includes("shadow") ? effects.shadow : null;
    if (shadow) {
      ctx.shadowColor = shadow.color || "#101010";
      ctx.shadowBlur = Math.max(0, Number(shadow.intensity) || 0) * 0.28;
      ctx.shadowOffsetY = Math.max(0, Number(shadow.intensity) || 0) * 0.1;
    }
    if (ids.includes("bloom")) {
      const bloom = effects.bloom || effects.glow;
      ctx.shadowColor = bloom.color || "#ffd7b8";
      ctx.shadowBlur = 12 + Math.max(0, Number(bloom.intensity) || 0) * 0.5;
    }
    const px = sprite.pad * scale;
    this.drawEffectSprite(ctx, sprite, -width / 2 - px, -height / 2 - px, width + px * 2, height + px * 2, ids, now);
    ctx.restore();
  }

  drawAccessories(ctx, W, H, now, expression = this.state) {
    const motion = this.avatarMotion || { centerX: W / 2, centerY: H / 2, rotation: 0, scaleX: 1, scaleY: 1, shakeX: 0, shakeY: 0 };
    const effects = this.preferences.effects || {};
    for (const item of this.accessories) {
      const image = item.image;
      if (!image?.complete || !image.naturalWidth) continue;
      const ids = this.activeEffects(expression, "accessories", item);
      const x = (Number(item.x ?? 0.5) - 0.5) * W;
      const y = (Number(item.y ?? 0.5) - 0.5) * H;
      const width = Math.max(0.01, Math.min(1, Number(item.w) || 0.18)) * W;
      const height = Math.max(0.01, Math.min(1, Number(item.h) || 0.18)) * H;
      const followsAvatar = item.follow !== false;
      const sprite = this.effectSprite(image, ids);
      ctx.save();
      ctx.filter = this.effectFilter(ids);
      if (followsAvatar) {
        ctx.translate(motion.centerX, motion.centerY);
        ctx.rotate(motion.rotation);
        ctx.scale(motion.scaleX, motion.scaleY);
        ctx.translate(x, y);
      } else {
        const shake = ids.includes("shake") ? Math.max(0, Math.min(1, Number(effects.shake.intensity) / 100 || 0.55)) : 0;
        const shakeX = shake ? Math.sin(now / 19) * Math.cos(now / 31) * shake * 24 : 0;
        const shakeY = shake ? Math.cos(now / 17) * Math.sin(now / 27) * shake * 24 : 0;
        ctx.translate(x + W / 2 + shakeX, y + H / 2 + shakeY);
      }
      if (item.mirror) ctx.scale(-1, 1);
      if (ids.includes("shadow")) {
        ctx.shadowColor = effects.shadow.color || "#101010";
        ctx.shadowBlur = Math.max(0, Number(effects.shadow.intensity) || 0) * 0.28;
        ctx.shadowOffsetY = Math.max(0, Number(effects.shadow.intensity) || 0) * 0.1;
      }
      if (ids.includes("bloom")) {
        const bloom = effects.bloom || effects.glow;
        ctx.shadowColor = bloom.color || "#ffd7b8";
        ctx.shadowBlur = 12 + Math.max(0, Number(bloom.intensity) || 0) * 0.5;
      }
      const px = sprite.pad * (width / Math.max(1, sprite.width));
      const py = sprite.pad * (height / Math.max(1, sprite.height));
      this.drawEffectSprite(ctx, sprite, -width / 2 - px, -height / 2 - py, width + px * 2, height + py * 2, ids, now);
      ctx.restore();
    }
  }
}
