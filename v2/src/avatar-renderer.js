const DEFAULTS = {
  scale: 1, mirror: true, bounce: 0.035, sway: 0, breathing: 0, blinkRate: 4,
  fps: 30, offsetX: 0, offsetY: 0, background: { mode: "transparent", color: "#11151b", color1: "#254c4a", color2: "#e2b48c", angle: 135 },
  effects: { glow: { enabled: false, intensity: 45, color: "#ffd7b8" }, shadow: { enabled: false, intensity: 45, color: "#101010" }, stroke: { enabled: false, intensity: 45, color: "#ffffff", thickness: 5 }, filter: { enabled: false, hue: 0, saturation: 100, brightness: 100, contrast: 100, grayscale: 0, sepia: 0 }, distort: { enabled: false, intensity: 20 } }
};

export class AvatarRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.assets = {};
    this.images = new Map();
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
      effects: {
        ...structuredClone(DEFAULTS.effects),
        ...(preferences.effects || {}),
        glow: { ...DEFAULTS.effects.glow, ...(preferences.effects?.glow || {}) },
        shadow: { ...DEFAULTS.effects.shadow, ...(preferences.effects?.shadow || {}) },
        stroke: { ...DEFAULTS.effects.stroke, ...(preferences.effects?.stroke || {}) },
        filter: { ...DEFAULTS.effects.filter, ...(preferences.effects?.filter || {}) },
        distort: { ...DEFAULTS.effects.distort, ...(preferences.effects?.distort || {}) }
      }
    };
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
    if (image?.complete && image.naturalWidth) this.drawAvatar(ctx, image, W, H, now);
    this.drawAccessories(ctx, W, H, now);
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

  drawAvatar(ctx, image, W, H, now) {
    const p = this.preferences;
    const effects = p.effects || {};
    const fit = Math.min(W / image.width, H / image.height);
    const breath = Math.sin(now / 1750 * Math.PI * 2) * (Number(p.breathing) || 0) / 100;
    const scale = fit * Math.max(0.1, Math.min(4, Number(p.scale) || 1)) * (1 + breath);
    const width = image.width * scale, height = image.height * scale;
    const talking = this.state === "talking";
    const phase = (now % 240) / 240;
    const bounce = talking ? Math.abs(Math.sin(phase * Math.PI)) * (Number(p.bounce) || 0) * height : Math.sin(now / 520) * 0.006 * height;
    const sway = Number(p.sway) || 0;
    const rotation = sway ? Math.sin(now / (talking ? 570 : 1400)) * sway * Math.PI / 180 : 0;
    const filter = effects.filter?.enabled
      ? `hue-rotate(${Number(effects.filter.hue) || 0}deg) saturate(${Number(effects.filter.saturation) || 100}%) brightness(${Number(effects.filter.brightness) || 100}%) contrast(${Number(effects.filter.contrast) || 100}%) grayscale(${Number(effects.filter.grayscale) || 0}%) sepia(${Number(effects.filter.sepia) || 0}%)`
      : "none";
    const centerX = W / 2 + (Number(p.offsetX) || 0);
    const centerY = H / 2 + (Number(p.offsetY) || 0) - bounce;
    this.avatarMotion = { centerX, centerY, rotation, scaleX: scale * (p.mirror === false ? 1 : -1), scaleY: scale };
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(rotation);
    ctx.scale(p.mirror === false ? 1 : -1, 1);
    ctx.filter = filter;
    if (effects.shadow?.enabled) {
      ctx.shadowColor = effects.shadow.color || "#101010";
      ctx.shadowBlur = Math.max(0, Number(effects.shadow.intensity) || 0);
      ctx.shadowOffsetY = Math.max(0, Number(effects.shadow.intensity) || 0) * 0.2;
    }
    if (effects.glow?.enabled) {
      ctx.shadowColor = effects.glow.color || "#ffd7b8";
      ctx.shadowBlur = Math.max(0, Number(effects.glow.intensity) || 0) * 0.7;
    }
    if (effects.stroke?.enabled) {
      const pad = Math.max(1, Math.min(20, Number(effects.stroke.thickness) || 5));
      const off = document.createElement("canvas");
      off.width = image.width + pad * 2;
      off.height = image.height + pad * 2;
      const octx = off.getContext("2d");
      for (let a = 0; a < 8; a++) {
        const angle = a * Math.PI / 4;
        octx.drawImage(image, pad + Math.cos(angle) * pad, pad + Math.sin(angle) * pad);
      }
      octx.globalCompositeOperation = "source-in";
      octx.fillStyle = effects.stroke.color || "#ffffff";
      octx.fillRect(0, 0, off.width, off.height);
      octx.globalCompositeOperation = "destination-over";
      octx.drawImage(image, pad, pad);
      ctx.drawImage(off, -width / 2 - pad * scale, -height / 2 - pad * scale, width + pad * 2 * scale, height + pad * 2 * scale);
    } else if (effects.distort?.enabled) {
      const rows = 36;
      const strength = Math.max(0, Math.min(1, Number(effects.distort.intensity) / 100 || 0.2));
      const sliceHeight = image.height / rows;
      for (let row = 0; row < rows; row++) {
        const sourceY = row * sliceHeight;
        const offset = Math.sin(now / 95 + row * 0.42) * strength * 18 * scale;
        ctx.drawImage(image, 0, sourceY, image.width, sliceHeight + 1, -width / 2 + offset, -height / 2 + sourceY * scale, width, sliceHeight * scale + 1);
      }
    } else {
      ctx.drawImage(image, -width / 2, -height / 2, width, height);
    }
    ctx.restore();
  }

  drawAccessories(ctx, W, H, now) {
    const motion = this.avatarMotion || { centerX: W / 2, centerY: H / 2, rotation: 0, scaleX: 1, scaleY: 1 };
    const effects = this.preferences.effects || {};
    for (const item of this.accessories) {
      const image = item.image;
      if (!image?.complete || !image.naturalWidth) continue;
      const x = (Number(item.x ?? 0.5) - 0.5) * W;
      const y = (Number(item.y ?? 0.5) - 0.5) * H;
      const width = Math.max(0.01, Math.min(1, Number(item.w) || 0.18)) * W;
      const height = Math.max(0.01, Math.min(1, Number(item.h) || 0.18)) * H;
      const followsAvatar = item.follow !== false;
      ctx.save();
      if (followsAvatar) {
        ctx.translate(motion.centerX, motion.centerY);
        ctx.rotate(motion.rotation);
        ctx.scale(motion.scaleX, motion.scaleY);
        ctx.translate(x, y);
      } else {
        ctx.translate(x + W / 2, y + H / 2);
      }
      if (item.effectsEnabled !== false && effects.filter?.enabled) {
        ctx.filter = `hue-rotate(${Number(effects.filter.hue) || 0}deg) saturate(${Number(effects.filter.saturation) || 100}%) brightness(${Number(effects.filter.brightness) || 100}%) contrast(${Number(effects.filter.contrast) || 100}%) grayscale(${Number(effects.filter.grayscale) || 0}%) sepia(${Number(effects.filter.sepia) || 0}%)`;
      }
      if (item.effectsEnabled !== false && effects.shadow?.enabled) {
        ctx.shadowColor = effects.shadow.color || "#101010";
        ctx.shadowBlur = Math.max(0, Number(effects.shadow.intensity) || 0);
        ctx.shadowOffsetY = Math.max(0, Number(effects.shadow.intensity) || 0) * 0.2;
      }
      if (item.effectsEnabled !== false && effects.glow?.enabled) {
        ctx.shadowColor = effects.glow.color || "#ffd7b8";
        ctx.shadowBlur = Math.max(0, Number(effects.glow.intensity) || 0) * 0.7;
      }
      if (item.mirror) ctx.scale(-1, 1);
      ctx.drawImage(image, -width / 2, -height / 2, width, height);
      ctx.restore();
    }
  }
}
