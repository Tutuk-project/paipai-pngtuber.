import { AvatarRenderer } from "./avatar-renderer.js";

let config;
let supabase;
let channel;
let roomId;
let overlayToken;
let members = [];
const states = new Map();
const stateSequences = new Map();
const layoutSequences = new Map();
const playerRenderers = new Map();
const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

async function api(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke(config.edgeFunctionName || "vio-api", { body: { action, ...payload } });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || "Overlay API failed");
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
  const preferences = { ...(member.preferences || {}), scale: overrides.scale ?? member.preferences?.scale ?? 1 };
  preferences.offsetX = Math.max(-100, Math.min(100, Number(overrides.x) || 0)) * width * 0.004;
  preferences.offsetY = Math.max(-100, Math.min(100, Number(overrides.y) || 0)) * canvas.height * 0.0035;
  renderer.setPreferences(preferences);
  const background = preferences.background || {};
  renderer.setBackgroundImage(background.mode === "image" ? background.src : null);
  renderer.setBackgroundVideo(background.mode === "video" ? background.src : null);
  renderer.setState(states.get(member.user_id) || member.state || "idle");
  return entry;
}

async function refreshMembers() {
  const result = await api("overlay_connect", { room_id: roomId, overlay_token: overlayToken });
  members = result.members || [];
  const activeIds = new Set(members.map(member => member.user_id));
  for (const [userId, entry] of playerRenderers) {
    if (!activeIds.has(userId)) { entry.renderer.stop(); playerRenderers.delete(userId); states.delete(userId); }
  }
  members.forEach(member => {
    states.set(member.user_id, member.state || "idle");
    ensurePlayerRenderer(member, canvas.width / Math.max(1, Math.min(4, members.length)));
  });
  render();
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const visible = members.slice(0, 4);
  const slotWidth = canvas.width / Math.max(1, visible.length);
  visible.forEach((member, index) => {
    const entry = playerRenderers.get(member.user_id) || ensurePlayerRenderer(member, slotWidth);
    entry.renderer.setState(states.get(member.user_id) || member.state || "idle");
    ctx.drawImage(entry.canvas, slotWidth * index, 0, slotWidth, canvas.height);
  });
  statusEl.textContent = `${visible.length} player slot(s) · Vio Studio v2.0`;
}

async function boot() {
  try {
    const configModule = await import("./config.js");
    config = configModule.VIO_CONFIG;
    if (!config?.supabaseUrl || !config?.supabasePublishableKey || config.supabasePublishableKey.includes("REPLACE_ME")) throw new Error("Supabase config missing");
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const pageUrl = new URL(location.href);
    const linkParams = new URLSearchParams(pageUrl.hash.slice(1));
    // Query parameters remain supported for already-generated v2 test links.
    roomId = linkParams.get("room") || pageUrl.searchParams.get("room");
    overlayToken = linkParams.get("token") || pageUrl.searchParams.get("token");
    if (!roomId || !overlayToken) throw new Error("Overlay URL is incomplete");
    let { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    }
    await refreshMembers();
    channel = supabase.channel(`room:${roomId}`, { config: { private: true } })
      .on("broadcast", { event: "player-state" }, ({ payload }) => {
        if (!payload?.user_id || !["idle", "talking"].includes(payload.state)) return;
        const seq = Number(payload.seq) || 0;
        if (seq && seq <= (stateSequences.get(payload.user_id) || 0)) return;
        if (seq) stateSequences.set(payload.user_id, seq);
        const old = states.get(payload.user_id);
        if (old === payload.state) return;
        states.set(payload.user_id, payload.state);
        render();
      })
      .on("broadcast", { event: "player-layout" }, ({ payload }) => {
        if (!payload?.user_id || !payload.overrides) return;
        const seq = Number(payload.seq) || 0;
        if (seq && seq <= (layoutSequences.get(payload.user_id) || 0)) return;
        if (seq) layoutSequences.set(payload.user_id, seq);
        const member = members.find(item => item.user_id === payload.user_id);
        if (member) member.overrides = { ...(member.overrides || {}), ...payload.overrides };
        render();
      })
      .on("presence", { event: "sync" }, () => {
        statusEl.textContent = `${Object.keys(channel.presenceState()).length} connected · Vio Studio v2.0`;
        refreshMembers().catch(error => { statusEl.textContent = error.message; });
      });
    await supabase.realtime.setAuth();
    await new Promise((resolve, reject) => channel.subscribe(status => {
      if (status === "SUBSCRIBED") resolve();
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error(`Realtime: ${status}`));
    }));
    statusEl.textContent = `${members.length} participant(s) connected`;
    // Refresh membership/assets occasionally; animation states remain event-driven.
    setInterval(() => refreshMembers().catch(error => { statusEl.textContent = error.message; }), 15000);
  } catch (error) {
    statusEl.textContent = `Overlay error: ${error.message}`;
    console.error(error);
  }
}

boot();

window.addEventListener("pagehide", () => { for (const entry of playerRenderers.values()) entry.renderer.stop(); });
