import { AvatarRenderer } from "./avatar-renderer.js";
import { AudioEngine } from "./audio-engine.js";

let config;
let supabase;
let channel;
let roomId;
let overlayToken;
let roomPurpose = "collaboration";
let localMicEngine = null;
let localMicUserId = null;
let localMicActive = false;
let members = [];
let refreshTimer = 0;
const states = new Map();
const stateSequences = new Map();
const layoutSequences = new Map();
const playerRenderers = new Map();
const canvas = document.getElementById("stage");
const ctx = canvas?.getContext("2d");
const statusEl = document.getElementById("status");
const debugMode = new URLSearchParams(location.search).get("debug") === "1";

function setStatus(message, error = false, forceVisible = true) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", error);
  statusEl.classList.toggle("is-visible", forceVisible || debugMode);
}

function clearStatus() {
  if (!statusEl) return;
  statusEl.classList.remove("is-error", "is-visible");
  statusEl.textContent = "";
}

async function api(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke(config.edgeFunctionName || "vio-api", { body: { action, ...payload } });
  if (error) throw new Error(error.message || `Supabase request failed: ${action}`);
  if (!data?.ok) throw new Error(data?.error || `Overlay API failed: ${action}`);
  return data;
}

function ensurePlayerRenderer(member, slotWidth) {
  let entry = playerRenderers.get(member.user_id);
  if (!entry) {
    const playerCanvas = document.createElement("canvas");
    playerCanvas.width = Math.max(1, Math.round(slotWidth));
    playerCanvas.height = canvas.height;
    const renderer = new AvatarRenderer(playerCanvas);
    renderer.start();
    entry = { canvas: playerCanvas, renderer };
    playerRenderers.set(member.user_id, entry);
  }
  const { renderer, canvas: playerCanvas } = entry;
  const width = Math.max(1, Math.round(slotWidth));
  if (playerCanvas.width !== width || playerCanvas.height !== canvas.height) {
    playerCanvas.width = width;
    playerCanvas.height = canvas.height;
  }
  renderer.setAssets(member.assets || {});
  renderer.setAccessories(member.accessories || []);
  const overrides = member.overrides || {};
  const preferences = {
    ...(member.preferences || {}),
    scale: overrides.scale ?? member.preferences?.scale ?? 1,
    avatarScalePercent: overrides.scale != null ? undefined : member.preferences?.avatarScalePercent
  };
  preferences.offsetX = Math.max(-100, Math.min(100, Number(overrides.x) || 0)) * width * 0.004;
  preferences.offsetY = Math.max(-100, Math.min(100, Number(overrides.y) || 0)) * canvas.height * 0.0035;
  renderer.setPreferences(preferences);
  const background = preferences.background || {};
  renderer.setBackgroundImage(background.mode === "image" ? background.src : null);
  renderer.setBackgroundVideo(background.mode === "video" ? background.src : null);
  renderer.setState(states.get(member.user_id) || member.state || "idle");
  return entry;
}

function updateLocalMicState(state) {
  if (!localMicUserId || !["idle", "talking"].includes(state)) return;
  states.set(localMicUserId, state);
  const member = members.find(item => item.user_id === localMicUserId);
  if (member) member.state = state;
  render();
}

async function startInvisibleSoloMicrophone() {
  if (roomPurpose !== "personal_overlay" || !localMicUserId || localMicEngine) return;
  const host = members.find(member => member.user_id === localMicUserId);
  // Capture from the OBS/browser host itself. No controls are added to overlay.html;
  // the browser may request microphone permission once, then capture remains invisible.
  localMicEngine = new AudioEngine({
    deviceId: host?.preferences?.deviceId || "",
    sensitivity: Number(host?.preferences?.sensitivity ?? 1),
    boostDb: Number(host?.preferences?.boostDb ?? 6)
  });
  localMicEngine.addEventListener("state", event => updateLocalMicState(event.detail.state));
  localMicEngine.addEventListener("status", event => {
    const { status, error } = event.detail;
    if (debugMode) setStatus(
      status === "active" ? "Solo mic active · clean overlay" : `Solo mic ${status}${error?.message ? `: ${error.message}` : ""}`,
      status === "error",
      true
    );
  });
  try {
    await localMicEngine.start();
    localMicActive = true;
    updateLocalMicState(localMicEngine.state || "idle");
    if (debugMode) setStatus("Solo mic active · no overlay controls", false, true);
  } catch (error) {
    localMicActive = false;
    console.warn("Solo OBS microphone capture unavailable:", error);
    if (debugMode) setStatus(`Solo mic unavailable: ${error.message}`, true, true);
  }
}

function render() {
  if (!canvas || !ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const visible = members.slice(0, 4);
  if (!visible.length) return;
  const slotWidth = canvas.width / visible.length;
  visible.forEach((member, index) => {
    const entry = playerRenderers.get(member.user_id) || ensurePlayerRenderer(member, slotWidth);
    entry.renderer.setState(states.get(member.user_id) || member.state || "idle");
    ctx.drawImage(entry.canvas, slotWidth * index, 0, slotWidth, canvas.height);
  });
}

async function refreshMembers() {
  const result = await api("overlay_connect", { room_id: roomId, overlay_token: overlayToken });
  roomPurpose = result.room?.purpose || roomPurpose;
  members = result.members || [];
  const hostMember = members.find(member => member.is_host) || members[0];
  if (hostMember) localMicUserId = hostMember.user_id;
  const output = hostMember?.preferences || {};
  const isCollaborationRoom = roomPurpose === "collaboration";
  const width = isCollaborationRoom
    ? 1920
    : Math.max(320, Math.min(3840, Math.round(Number(output.outputWidth) || 1080)));
  const height = isCollaborationRoom
    ? 1080
    : Math.max(320, Math.min(3840, Math.round(Number(output.outputHeight) || 1920)));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  canvas.style.aspectRatio = `${width} / ${height}`;

  const activeIds = new Set(members.map(member => member.user_id));
  for (const [userId, entry] of playerRenderers) {
    if (!activeIds.has(userId)) {
      entry.renderer.stop();
      playerRenderers.delete(userId);
      states.delete(userId);
    }
  }
  members.forEach(member => {
    const state = localMicActive && member.user_id === localMicUserId
      ? (states.get(member.user_id) || "idle")
      : (member.state || "idle");
    states.set(member.user_id, state);
    ensurePlayerRenderer(member, canvas.width / Math.max(1, Math.min(4, members.length)));
  });
  render();

  if (!members.length) {
    setStatus("Overlay terhubung ke server, tetapi daftar peserta room kosong. Pastikan room masih aktif dan akun pembuat link masih menjadi anggota.", true);
    return;
  }
  const hasAvatarAssets = members.some(member => Object.values(member.assets || {}).some(Boolean));
  if (!hasAvatarAssets) {
    setStatus("Overlay terhubung, tetapi PNG avatar belum ditemukan. Unggah setidaknya ekspresi Idle di Vio Studio > Character.", true);
    return;
  }
  clearStatus();
  if (debugMode) setStatus(`Connected · ${members.length} participant(s) · Vio Studio v2.0`, false);
}

async function boot() {
  try {
    if (!canvas || !ctx) throw new Error("Canvas OBS tidak ditemukan di halaman overlay.");
    setStatus("Membaca kredensial overlay…");
    const configModule = await import("./config.js");
    config = configModule.VIO_CONFIG;
    if (!config?.supabaseUrl || !config?.supabasePublishableKey || config.supabasePublishableKey.includes("REPLACE_ME")) {
      throw new Error("Konfigurasi Supabase belum tersedia di build ini.");
    }
    const pageUrl = new URL(location.href);
    const linkParams = new URLSearchParams(pageUrl.hash.replace(/^#/, ""));
    roomId = linkParams.get("room") || pageUrl.searchParams.get("room");
    overlayToken = linkParams.get("token") || pageUrl.searchParams.get("token");
    if (!roomId || !overlayToken) throw new Error("URL overlay tidak lengkap. Buat ulang link dari tombol Generate OBS Link.");

    setStatus("Menghubungkan ke layanan overlay…");
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    let { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw new Error(`Login perangkat overlay gagal: ${error.message}`);
      session = data.session;
    }
    if (!session) throw new Error("Sesi perangkat overlay tidak berhasil dibuat.");

    setStatus("Memuat peserta dan aset avatar…");
    await refreshMembers();
    channel = supabase.channel(`room:${roomId}`, { config: { private: true } })
      .on("broadcast", { event: "player-state" }, ({ payload }) => {
        if (!payload?.user_id || !["idle", "talking"].includes(payload.state)) return;
        const seq = Number(payload.seq) || 0;
        if (seq && seq <= (stateSequences.get(payload.user_id) || 0)) return;
        if (seq) stateSequences.set(payload.user_id, seq);
        if (localMicActive && payload.user_id === localMicUserId) return;
        states.set(payload.user_id, payload.state);
        render();
      })
      .on("broadcast", { event: "player-layout" }, ({ payload }) => {
        if (!payload?.user_id || !payload.overrides) return;
        const seq = Number(payload.seq) || 0;
        if (seq && seq <= (layoutSequences.get(payload.user_id) || 0)) return;
        if (seq) layoutSequences.set(payload.user_id, seq);
        const member = members.find(item => item.user_id === payload.user_id);
        if (member) {
          member.overrides = { ...(member.overrides || {}), ...payload.overrides };
          ensurePlayerRenderer(member, canvas.width / Math.max(1, Math.min(4, members.length)));
        }
        render();
      })
      .on("broadcast", { event: "member-assets-updated" }, () => {
        refreshMembers().catch(error => setStatus(`Gagal memperbarui aset: ${error.message}`, true));
      })
      .on("presence", { event: "sync" }, () => {
        refreshMembers().catch(error => setStatus(`Sinkronisasi peserta gagal: ${error.message}`, true));
      });
    await supabase.realtime.setAuth();
    await new Promise((resolve, reject) => channel.subscribe(status => {
      if (status === "SUBSCRIBED") resolve();
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error(`Realtime channel error: ${status}`));
    }));
    if (members.length && members.some(member => Object.values(member.assets || {}).some(Boolean))) {
      if (debugMode) setStatus(`Connected · ${members.length} participant(s) · Vio Studio v2.0`, false);
      else clearStatus();
    }
    // Personal Solo overlays capture their own mic. Collaboration overlays keep
    // using each participant's Creator-side state broadcasts.
    await startInvisibleSoloMicrophone();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      refreshMembers().catch(error => setStatus(`Refresh overlay gagal: ${error.message}`, true));
    }, 15000);
  } catch (error) {
    console.error("Vio Studio OBS overlay error:", error);
    let message = error instanceof Error ? error.message : String(error);
    const context = error && typeof error === "object" ? error.context : null;
    if (context instanceof Response) {
      try {
        const body = await context.clone().json();
        if (body?.error) message = String(body.error);
        if (body?.code) message = `[${body.code}] ${message}`;
        if (body?.details) message += ` · ${body.details}`;
      } catch { /* Keep the SDK message if the response is not JSON. */ }
    }
    setStatus(`OBS OVERLAY ERROR: ${message}`, true);
  }
}

boot();

window.addEventListener("pagehide", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  for (const entry of playerRenderers.values()) entry.renderer.stop();
  void localMicEngine?.stop().catch(() => {});
  localMicEngine = null;
  localMicActive = false;
});
