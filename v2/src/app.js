import { AudioEngine } from "./audio-engine.js";
import { AvatarRenderer } from "./avatar-renderer.js";

const $ = (id) => document.getElementById(id);
const viewIds = ["loginGate", "editorView", "collaborationView", "adminView", "overlayView"];
const menus = [
  { id: "profile", icon: "◉", label: "Profile", title: "Profile" },
  { id: "character", icon: "▧", label: "Character", title: "Character & Assets" },
  { id: "audio", icon: "♫", label: "Microphone", title: "Microphone" },
  { id: "effects", icon: "✧", label: "Effects", title: "Avatar Effects" },
  { id: "collaboration", icon: "◎", label: "GO Collaboration", title: "GO Collaboration" },
  { id: "obs", icon: "▣", label: "OBS Integration", title: "OBS Integration" },
  { id: "tester", icon: "⚗", label: "Test Lab", title: "Test Lab", roles: ["admin", "tester"] },
  { id: "admin", icon: "⬡", label: "Admin Center", title: "Admin Control Center", roles: ["admin"] },
];

let config = null;
let supabase = null;
let currentUser = null;
let activeMenu = "profile";
let audio = null;
let avatarRenderer = null;
let currentRoom = null;
let roomChannel = null;
let roomMembers = [];
let currentMicState = "idle";
let assetUrls = { idle: null, talking: null, blink: null, talking_blink: null };
let characterAccessories = [];
let selectedAccessoryId = null;
let profilePreferences = { scale: 1, outputWidth: 1080, outputHeight: 1920, sensitivity: 1, boostDb: 6, deviceId: "" };
let roomOverrides = { scale: 1, x: 0, y: 0, sensitivity: 1, boostDb: 6, deviceId: "" };
let renderFrame = 0;
let playerSequence = 0;
let layoutSequence = 0;
let activeSupportSession = null;
const remotePlayerStates = new Map();
const remotePlayerSequences = new Map();
const remoteLayoutSequences = new Map();
const roomPreviewImages = new Map();
const roomPreviewRenderers = new Map();

function showMessage(target, message, type = "info") {
  const el = $(target);
  if (!el) return;
  el.textContent = message;
  el.dataset.type = type;
}

function setBadge(text, live = false) {
  const badge = $("connectionBadge");
  badge.textContent = text;
  badge.className = `status-pill ${live ? "status-live" : "status-neutral"}`;
}

function showView(id) {
  for (const viewId of viewIds) $(viewId).hidden = viewId !== id;
  $("topRoomButton").hidden = !(currentUser && id === "editorView");
}

function allowedMenus(role) {
  return menus.filter(item => !item.roles || item.roles.includes(role));
}

function renderNavigation() {
  const nav = $("navigation");
  nav.replaceChildren();
  for (const item of allowedMenus(currentUser?.role || "guest")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `nav-item ${activeMenu === item.id ? "active" : ""}`;
    button.dataset.menu = item.id;
    button.innerHTML = `<span class="nav-icon" aria-hidden="true">${item.icon}</span><span class="nav-label">${item.label}</span>`;
    button.title = item.label;
    button.addEventListener("click", () => selectMenu(item.id));
    nav.append(button);
  }
  $("logoutButton").hidden = !currentUser;
  $("accountName").textContent = currentUser?.username || "Not signed in";
  $("accountRole").textContent = currentUser?.role || "Guest";
  $("accountInitial").textContent = (currentUser?.username || "?").slice(0, 1).toUpperCase();
}

function selectMenu(menuId) {
  if (menuId === "collaboration") {
    openRoomChooser();
    return;
  }
  if (menuId === "admin" && currentUser?.role !== "admin") return;
  if (menuId === "tester" && !["admin", "tester"].includes(currentUser?.role)) return;
  activeMenu = menuId;
  renderNavigation();
  if (menuId === "admin") {
    showView("adminView");
    loadAdminOverview();
    $("pageTitle").textContent = "Admin Control Center";
    return;
  }
  showView("editorView");
  const meta = menus.find(item => item.id === menuId);
  $("pageTitle").textContent = menuId === "profile" ? "Avatar Preview" : meta?.title || "Workspace";
  renderSettings(menuId);
}

function settingField(label, id, value, hint = "", type = "text") {
  const wrap = document.createElement("div");
  wrap.className = "setting-field";
  const labelEl = document.createElement("label");
  labelEl.htmlFor = id;
  labelEl.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.className = type === "range" ? "range-input" : "text-input";
  input.type = type;
  input.value = value;
  wrap.append(labelEl, input);
  if (hint) {
    const small = document.createElement("small");
    small.className = "hint";
    small.textContent = hint;
    wrap.append(small);
  }
  return wrap;
}

function actionButton(text, onClick, primary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${primary ? "button-primary" : "button-quiet"}`;
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function renderSettings(menuId) {
  const content = $("settingsContent");
  content.replaceChildren();
  const meta = menus.find(item => item.id === menuId);
  $("settingsTitle").textContent = meta?.title || "Settings";

  if (menuId === "profile") {
    const grid = document.createElement("div");
    grid.className = "setting-grid";
    const usernameField = settingField("Username", "profileUsername", currentUser?.username || "", "Username akun dikelola Admin.", "text");
    usernameField.querySelector("input").readOnly = true;
    grid.append(usernameField);
    grid.append(settingField("Display name", "profileDisplayName", currentUser?.display_name || currentUser?.username || ""));
    const profileDeviceField = document.createElement("div"); profileDeviceField.className = "setting-field";
    const profileDeviceLabel = document.createElement("label"); profileDeviceLabel.htmlFor = "profileDevice"; profileDeviceLabel.textContent = "Default microphone input";
    const profileDevice = document.createElement("select"); profileDevice.id = "profileDevice"; profileDevice.className = "select-input"; profileDevice.innerHTML = '<option value="">System default</option>'; profileDevice.value = profilePreferences.deviceId || "";
    profileDeviceField.append(profileDeviceLabel, profileDevice); grid.append(profileDeviceField);
    const scale = settingField("Default avatar scale", "profileScale", String(profilePreferences.scale ?? 1), "Default scale used when joining a room.", "range");
    const scaleInput = scale.querySelector("input"); scaleInput.min = "0.2"; scaleInput.max = "2.2"; scaleInput.step = "0.05";
    const sensitivity = settingField("Default mic sensitivity", "profileSensitivity", String(profilePreferences.sensitivity ?? 1), "Adaptive threshold multiplier.", "range");
    const sensitivityInput = sensitivity.querySelector("input"); sensitivityInput.min = "0.5"; sensitivityInput.max = "2"; sensitivityInput.step = "0.05";
    const boost = settingField("Default mic booster (dB)", "profileBoost", String(profilePreferences.boostDb ?? 6), "Digital gain, limited to +24 dB.", "range");
    const boostInput = boost.querySelector("input"); boostInput.min = "0"; boostInput.max = "24"; boostInput.step = "1";
    grid.append(scale, sensitivity, boost);
    content.append(grid, actionButton("Refresh microphone devices", refreshAudioDevices), actionButton("Save profile preferences", saveProfilePreferences, true), Object.assign(document.createElement("p"), { className: "muted", textContent: "Pengaturan Collaboration adalah override sementara. Perubahan di room tidak menimpa preferensi profil." }));
    refreshAudioDevices();
    return;
  }

  if (menuId === "character") {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Upload empat ekspresi PNG transparan. Versi ini menyiapkan struktur aset v2.0; integrasi seluruh renderer/effects v1.0 dilakukan setelah source repo tersambung.";
    const grid = document.createElement("div");
    grid.className = "setting-grid";
    for (const state of ["idle", "talking", "blink", "talking_blink"]) {
      const field = document.createElement("div");
      field.className = "setting-field";
      const label = document.createElement("label");
      label.textContent = state.replace("_", " ").toUpperCase() + " PNG";
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/webp";
      input.className = "text-input";
      input.addEventListener("change", () => uploadCharacterAsset(state, input.files?.[0]));
      field.append(label, input);
      grid.append(field);
    }
    const accessorySection = document.createElement("section");
    accessorySection.className = "panel-card";
    accessorySection.style.cssText = "margin-top:14px;padding:14px";
    const accessoryTitle = document.createElement("h3");
    accessoryTitle.textContent = "Accessories";
    const accessoryHint = document.createElement("p");
    accessoryHint.className = "muted";
    accessoryHint.textContent = "Tambahkan PNG/WebP transparan, lalu atur posisi, ukuran, mirror, dan gerakan mengikuti avatar.";
    const accessoryInput = document.createElement("input");
    accessoryInput.type = "file";
    accessoryInput.accept = "image/png,image/webp";
    accessoryInput.multiple = true;
    accessoryInput.className = "text-input";
    accessoryInput.addEventListener("change", async () => {
      await uploadCharacterAccessories(accessoryInput.files);
      accessoryInput.value = "";
    });
    const accessoryList = document.createElement("div");
    accessoryList.id = "accessorySettingsList";
    accessoryList.className = "setting-grid";
    accessorySection.append(accessoryTitle, accessoryHint, accessoryInput, accessoryList);
    content.append(note, grid, accessorySection);
    renderAccessorySettingsList();
    return;
  }

  if (menuId === "audio") {
    const deviceWrap = document.createElement("div");
    deviceWrap.className = "setting-field";
    const label = document.createElement("label");
    label.htmlFor = "audioDevice";
    label.textContent = "Microphone input";
    const select = document.createElement("select");
    select.id = "audioDevice";
    select.className = "select-input";
    select.innerHTML = '<option value="">System default</option>';
    select.addEventListener("change", async () => {
      roomOverrides.deviceId = select.value;
      if (audio) { await audio.stop(); audio.setOptions({ deviceId: select.value }); await audio.start(); }
    });
    deviceWrap.append(label, select);
    const grid = document.createElement("div");
    grid.className = "setting-grid";
    const sensitivityField = settingField("Sensitivity multiplier", "audioSensitivity", "1", "Lower threshold = more sensitive.", "range");
    const sensitivityInput = sensitivityField.querySelector("input");
    sensitivityInput.min = "0.5"; sensitivityInput.max = "2"; sensitivityInput.step = "0.05";
    sensitivityInput.addEventListener("input", e => { roomOverrides.sensitivity = Number(e.target.value); audio?.setOptions({ sensitivity: roomOverrides.sensitivity }); });
    grid.append(sensitivityField);
    const boostField = settingField("Mic booster (dB)", "audioBoost", "6", "Digital gain is limited to +24 dB to reduce clipping.", "range");
    const boostInput = boostField.querySelector("input");
    boostInput.min = "0"; boostInput.max = "24"; boostInput.step = "1";
    boostInput.addEventListener("input", e => { roomOverrides.boostDb = Number(e.target.value); audio?.setOptions({ boostDb: roomOverrides.boostDb }); });
    grid.append(boostField);
    const buttons = document.createElement("div");
    buttons.className = "settings-actions";
    buttons.append(actionButton("Refresh devices", refreshAudioDevices), actionButton("Start microphone", startMicrophone, true), actionButton("Stop microphone", stopMicrophone));
    content.append(deviceWrap, grid, buttons, Object.assign(document.createElement("p"), { className: "muted", textContent: "Audio diproses lokal. Hanya perubahan status idle/talking yang dikirim ke room, bukan suara mentah." }));
    refreshAudioDevices();
    return;
  }

  if (menuId === "effects") {
    const prefs = profilePreferences;
    const grid = document.createElement("div"); grid.className = "setting-grid";
    const fields = [
      ["bounce", "Talking bounce", 0, 0.12, 0.005],
      ["sway", "Sway (degrees)", 0, 18, 0.5],
      ["breathing", "Breathing (%)", 0, 8, 0.25],
      ["blinkRate", "Blink rate", 1, 12, 0.5],
      ["fps", "Preview FPS", 10, 60, 5]
    ];
    for (const [key, label, min, max, step] of fields) {
      const field = settingField(label, `effect_${key}`, String(prefs[key] ?? ({bounce:0.035,sway:0,breathing:0,blinkRate:4,fps:30}[key])), "", "range");
      const input = field.querySelector("input"); input.min = String(min); input.max = String(max); input.step = String(step);
      input.addEventListener("input", () => { prefs[key] = Number(input.value); drawPreview(); });
      grid.append(field);
    }
    const mirrorField = document.createElement("label"); mirrorField.className = "check-field";
    const mirror = document.createElement("input"); mirror.type = "checkbox"; mirror.checked = prefs.mirror !== false;
    mirror.addEventListener("change", () => { prefs.mirror = mirror.checked; drawPreview(); });
    mirrorField.append(mirror, document.createTextNode("Mirror avatar")); grid.append(mirrorField);

    const resolutionTitle = document.createElement("h3"); resolutionTitle.textContent = "Output resolution";
    const resolutionWrap = document.createElement("div"); resolutionWrap.className = "setting-grid";
    const resolutionPresetField = document.createElement("div"); resolutionPresetField.className = "setting-field";
    const resolutionPresetLabel = document.createElement("label"); resolutionPresetLabel.textContent = "Preset";
    const resolutionPreset = document.createElement("select"); resolutionPreset.className = "select-input";
    resolutionPreset.innerHTML = '<option value="1080x1920">TikTok Portrait · 1080 × 1920</option><option value="720x1280">Portrait HD · 720 × 1280</option><option value="1920x1080">Landscape Full HD · 1920 × 1080</option><option value="1280x720">Landscape HD · 1280 × 720</option><option value="1080x1080">Square · 1080 × 1080</option><option value="custom">Custom dimensions</option>';
    const resolutionKey = `${Number(prefs.outputWidth) || 1080}x${Number(prefs.outputHeight) || 1920}`;
    resolutionPreset.value = ["1080x1920","720x1280","1920x1080","1280x720","1080x1080"].includes(resolutionKey) ? resolutionKey : "custom";
    resolutionPreset.addEventListener("change", () => {
      if (resolutionPreset.value !== "custom") {
        const [width, height] = resolutionPreset.value.split("x").map(Number);
        prefs.outputWidth = width; prefs.outputHeight = height;
        widthInput.value = String(width); heightInput.value = String(height);
        drawPreview();
      }
    });
    resolutionPresetField.append(resolutionPresetLabel, resolutionPreset);
    const widthField = settingField("Width (px)", "outputWidth", String(prefs.outputWidth || 1080), "320–3840 px");
    const widthInput = widthField.querySelector("input"); widthInput.type = "number"; widthInput.min = "320"; widthInput.max = "3840"; widthInput.step = "1";
    const heightField = settingField("Height (px)", "outputHeight", String(prefs.outputHeight || 1920), "320–3840 px");
    const heightInput = heightField.querySelector("input"); heightInput.type = "number"; heightInput.min = "320"; heightInput.max = "3840"; heightInput.step = "1";
    const applyCustomResolution = () => {
      const width = Math.max(320, Math.min(3840, Math.round(Number(widthInput.value) || 1080)));
      const height = Math.max(320, Math.min(3840, Math.round(Number(heightInput.value) || 1920)));
      if (width * height > 8294400) return alert("Output dibatasi maksimal 8,3 megapiksel agar perangkat tidak kehabisan memori.");
      widthInput.value = String(width); heightInput.value = String(height);
      prefs.outputWidth = width; prefs.outputHeight = height;
      const key = `${width}x${height}`;
      resolutionPreset.value = ["1080x1920","720x1280","1920x1080","1280x720","1080x1080"].includes(key) ? key : "custom";
      drawPreview();
    };
    widthInput.addEventListener("change", applyCustomResolution);
    heightInput.addEventListener("change", applyCustomResolution);
    resolutionWrap.append(resolutionPresetField, widthField, heightField);

    const backgroundTitle = document.createElement("h3"); backgroundTitle.textContent = "Background";
    const background = { mode: "transparent", ...(prefs.background || {}) };
    const bgWrap = document.createElement("div"); bgWrap.className = "setting-grid";
    const modeField = document.createElement("div"); modeField.className = "setting-field";
    const modeLabel = document.createElement("label"); modeLabel.textContent = "Background mode";
    const mode = document.createElement("select"); mode.className = "select-input";
    mode.innerHTML = '<option value="transparent">Transparent</option><option value="solid">Solid color</option><option value="gradient">Gradient</option><option value="image">Image / GIF</option><option value="video">Video</option>';
    mode.value = background.mode;
    mode.addEventListener("change", () => { background.mode = mode.value; prefs.background = { ...background }; drawPreview(); });
    modeField.append(modeLabel, mode); bgWrap.append(modeField);
    for (const [key,label,initial] of [["color","Solid color",background.color || "#11151b"],["color1","Gradient start",background.color1 || "#254c4a"],["color2","Gradient end",background.color2 || "#e2b48c"]]) {
      const field = document.createElement("div"); field.className = "setting-field";
      const caption = document.createElement("label"); caption.textContent = label;
      const input = document.createElement("input"); input.type = "color"; input.className = "text-input"; input.value = initial;
      input.addEventListener("input", () => { background[key] = input.value; prefs.background = { ...background }; drawPreview(); });
      field.append(caption,input); bgWrap.append(field);
    }
    const mediaField = document.createElement("div"); mediaField.className = "setting-field";
    const mediaLabel = document.createElement("label"); mediaLabel.textContent = "Background image, GIF, or video";
    const mediaInput = document.createElement("input"); mediaInput.type = "file"; mediaInput.className = "text-input";
    mediaInput.accept = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm";
    const mediaHint = document.createElement("p"); mediaHint.className = "muted";
    mediaHint.textContent = "Image/GIF maks. 20 MB. Video MP4/WebM maks. 50 MB. Video diputar muted dan loop.";
    mediaInput.addEventListener("change", async () => {
      const file = mediaInput.files?.[0];
      mediaInput.value = "";
      if (!file) return;
      if (!supabase || !currentUser) return alert("Backend belum siap.");
      const isVideo = file.type.startsWith("video/");
      const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"];
      const limit = isVideo ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
      if (!allowed.includes(file.type) || file.size < 1 || file.size > limit) return alert("Format atau ukuran background tidak didukung.");
      const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" };
      const storagePath = `${currentUser.id}/background/${crypto.randomUUID()}.${extensions[file.type]}`;
      try {
        const { error } = await supabase.storage.from("vio-backgrounds").upload(storagePath, file, { upsert: false, contentType: file.type, cacheControl: "3600" });
        if (error) throw error;
        const result = await api("record_background_asset", { storage_path: storagePath, mime_type: file.type, size_bytes: file.size });
        Object.assign(background, result.background);
        prefs.background = { ...background };
        mode.value = background.mode;
        drawPreview();
        showMessage("loginMessage", "Background berhasil diunggah.", "success");
      } catch (error) { alert(`Upload background gagal: ${error.message}`); }
    });
    mediaField.append(mediaLabel, mediaInput, mediaHint);
    bgWrap.append(mediaField);
    const effectsTitle = document.createElement("h3"); effectsTitle.textContent = "Visual effects";
    const effectsWrap = document.createElement("div"); effectsWrap.className = "setting-grid";
    const effects = { glow:{enabled:false,intensity:24,color:"#ffd7b8"}, shadow:{enabled:false,intensity:16,color:"#101010"}, stroke:{enabled:false,intensity:45,color:"#ffffff",thickness:5}, filter:{enabled:false,hue:0,saturation:100,brightness:100,contrast:100,grayscale:0,sepia:0}, distort:{enabled:false,intensity:20}, ...(prefs.effects || {}) };
    for (const [key,label] of [["glow","Glow / bloom"],["shadow","Shadow"],["stroke","Stroke"],["filter","Color filter"],["distort","Distortion"]]) {
      const field = document.createElement("label"); field.className = "check-field";
      const input = document.createElement("input"); input.type = "checkbox"; input.checked = !!effects[key]?.enabled;
      input.addEventListener("change", () => { effects[key] = { ...effects[key], enabled: input.checked }; prefs.effects = { ...effects }; drawPreview(); });
      field.append(input,document.createTextNode(label)); effectsWrap.append(field);
    }
    const save = actionButton("Save visual settings", async () => {
      prefs.background = background; prefs.effects = effects;
      try { await api("profile_save", { display_name: currentUser.display_name || currentUser.username, preferences: prefs }); showMessage("loginMessage","Visual settings saved.","success"); }
      catch (error) { alert(`Gagal menyimpan efek: ${error.message}`); }
    }, true);
    content.append(grid, resolutionTitle, resolutionWrap, backgroundTitle, bgWrap, effectsTitle, effectsWrap, save);
    return;
  }

  if (menuId === "obs") {
    content.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "OBS memakai output renderer terpisah. Browser Source tidak meminta mikrofon; editor perangkat mengolah mic lalu mengirim state ke room/overlay." }));
    content.append(actionButton("Generate OBS Link", generateOverlayLink, true));
    return;
  }

  if (menuId === "tester") {
    content.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "Test Lab hanya tampil untuk role Tester dan Admin. Build eksperimen diberi feature flag dan tidak otomatis tersedia bagi User release." }));
    return;
  }
}

async function loadConfig() {
  try {
    const module = await import("./config.js");
    config = module.VIO_CONFIG;
    if (!config?.supabaseUrl || !config?.supabasePublishableKey || config.supabasePublishableKey.includes("REPLACE_ME")) throw new Error("Supabase config belum diisi.");
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    setBadge("Supabase configured", true);
    return true;
  } catch (error) {
    setBadge("Backend belum dikonfigurasi");
    console.info("Vio Studio setup required:", error.message);
    showMessage("loginMessage", "Frontend v2.0 sudah disiapkan. Hubungkan config Supabase dan deploy Edge Function untuk mengaktifkan login.");
    return false;
  }
}

async function ensureAnonymousSession() {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (session) return session;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

async function api(action, payload = {}) {
  if (!supabase) throw new Error("Supabase belum dikonfigurasi.");
  const { data, error } = await supabase.functions.invoke(config.edgeFunctionName || "vio-api", { body: { action, ...payload } });
  if (error) {
    let message = error.message || "Backend request failed.";
    // Supabase wraps non-2xx Edge Function responses. Preserve the backend's
    // machine-readable error code (notably DEVICE_NOT_PAIRED) for login UX.
    try {
      if (error.context instanceof Response) {
        const body = await error.context.clone().json();
        if (body?.error) message = body.error;
      }
    } catch { /* Keep the SDK error message when no JSON response is available. */ }
    throw new Error(message);
  }
  if (!data?.ok) throw new Error(data?.error || "Backend request failed.");
  return data;
}

async function login(username, pairingCode) {
  await ensureAnonymousSession();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Session Supabase tidak terbentuk.");

  // A returning paired device needs only the username. A new device needs a one-time
  // pairing code issued manually by Admin. The code is not a reusable password.
  let identity;
  let alreadyPairedToAnotherUser = false;
  try {
    identity = await api("me");
    if (identity.user?.username !== username) alreadyPairedToAnotherUser = true;
  } catch (error) {
    if (!String(error?.message || error).includes("DEVICE_NOT_PAIRED")) throw error;
    // Expected path for a fresh, not-yet-paired device.
  }
  if (alreadyPairedToAnotherUser) {
    throw new Error(`Perangkat ini masih terikat ke @${identity.user.username}. Minta Admin mereset perangkat akun lama sebelum memakai username lain.`);
  }
  if (!identity) {
    if (!pairingCode) {
      $("pairingWrap").hidden = false;
      throw new Error("Perangkat ini belum dipasangkan. Minta kode sekali pakai dari Admin.");
    }
    if (username.toLowerCase() === "paipai77") {
      identity = await api("bootstrap_admin", { username, bootstrap_token: pairingCode });
    } else {
      identity = await api("activate_device", { username, pairing_code: pairingCode });
    }
  }
  currentUser = identity.user;
  $("pairingInput").value = "";
  $("pairingWrap").hidden = true;
  await loadCurrentProfile();
  try {
    const assets = await api("my_assets");
    assetUrls = { ...assetUrls, ...(assets.assets || {}) };
    characterAccessories = assets.accessories || [];
    if (assets.background) profilePreferences.background = assets.background;
    drawPreview();
  } catch (assetError) { console.info("No saved character assets yet:", assetError.message); }
  $("footerSession").textContent = `Session: ${currentUser.username} · ${currentUser.role}`;
  $("loginGate").hidden = true;
  renderNavigation();
  selectMenu("profile");
  await restoreSavedRoom();
}

async function loadCurrentProfile() {
  try {
    const result = await api("profile_get");
    currentUser = { ...currentUser, ...result.account };
    profilePreferences = { scale: 1, outputWidth: 1080, outputHeight: 1920, sensitivity: 1, boostDb: 6, deviceId: "", ...(result.profile?.preferences || {}) };
    roomOverrides = { scale: profilePreferences.scale, x: 0, y: 0, sensitivity: profilePreferences.sensitivity, boostDb: profilePreferences.boostDb, deviceId: profilePreferences.deviceId || "" };
    if (audio) audio.setOptions({ sensitivity: roomOverrides.sensitivity, boostDb: roomOverrides.boostDb, deviceId: roomOverrides.deviceId });
  } catch (error) {
    console.warn("Profile could not be loaded yet:", error.message);
  }
}

async function saveProfilePreferences() {
  const displayName = $("profileDisplayName").value.trim();
  const preferences = {
    ...profilePreferences,
    scale: Number($("profileScale").value),
    sensitivity: Number($("profileSensitivity").value),
    boostDb: Number($("profileBoost").value),
    deviceId: $("profileDevice").value,
  };
  try {
    await api("profile_save", { display_name: displayName, preferences });
    currentUser.display_name = displayName;
    profilePreferences = preferences;
    drawPreview();
    const deviceChanged = roomOverrides.deviceId !== preferences.deviceId;
    roomOverrides = { ...roomOverrides, scale: preferences.scale, sensitivity: preferences.sensitivity, boostDb: preferences.boostDb, deviceId: preferences.deviceId };
    if (audio) {
      if (deviceChanged) { await audio.stop(); audio.setOptions({ deviceId: preferences.deviceId, sensitivity: preferences.sensitivity, boostDb: preferences.boostDb }); await audio.start(); }
      else audio.setOptions({ sensitivity: preferences.sensitivity, boostDb: preferences.boostDb });
    }
    showMessage("loginMessage", "Preferensi profil berhasil disimpan.", "success");
    renderNavigation();
  } catch (error) { alert(`Gagal menyimpan profil: ${error.message}`); }
}

async function restoreSavedRoom() {
  const roomId = profilePreferences.lastRoomId;
  if (!roomId) return;
  try {
    const result = await api("reconnect_room", { room_id: roomId });
    if (result.room.purpose === "personal_overlay") {
      currentRoom = result.room;
      await subscribeRoom(result.room.id);
      await loadRoomMembers();
      await broadcastPlayerState(currentMicState);
    } else {
      await enterRoom(result.room);
    }
  } catch (error) {
    console.info("Saved room is no longer available:", error.message);
    delete profilePreferences.lastRoomId;
    try { await api("profile_save", { display_name: currentUser.display_name || currentUser.username, preferences: profilePreferences }); } catch {}
  }
}

async function logout() {
  if (roomChannel || currentRoom) await leaveRoom(false);
  await stopMicrophone();
  avatarRenderer?.stop();
  // Keep the device-bound anonymous Supabase session so this trusted device can
  // return with username only. Admin can revoke/reset it if the device is lost.
  currentUser = null;
  showView("loginGate");
  $("loginGate").hidden = false;
  $("footerSession").textContent = "Device session retained · enter username to continue";
  showMessage("loginMessage", "Kamu sudah keluar dari Vio Studio. Sesi perangkat tetap tersimpan untuk login username berikutnya.", "info");
  renderNavigation();
}

async function refreshAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput");
    for (const id of ["audioDevice", "profileDevice", "roomDevice"]) {
      const select = $(id);
      if (!select) continue;
      const selected = select.value || (id === "profileDevice" ? profilePreferences.deviceId : id === "roomDevice" ? roomOverrides.deviceId : "");
      select.replaceChildren(new Option("System default", ""));
      devices.forEach((device, index) => select.add(new Option(device.label || `Microphone ${index + 1}`, device.deviceId)));
      select.value = selected || "";
    }
  } catch (error) {
    showMessage("loginMessage", `Tidak dapat membaca daftar mikrofon: ${error.message}`, "error");
  }
}

async function startMicrophone() {
  try {
    if (!audio) {
      audio = new AudioEngine({ deviceId: roomOverrides.deviceId, sensitivity: roomOverrides.sensitivity, boostDb: roomOverrides.boostDb });
      audio.addEventListener("meter", event => {
        const { level } = event.detail;
        $("meterBar").style.width = `${Math.min(100, level * 400)}%`;
        $("meterValue").textContent = `${Math.round(level * 100)}%`;
      });
      audio.addEventListener("status", event => {
        const { status, error } = event.detail;
        $("micStateBadge").textContent = status === "active" ? "Mic active" : `Mic ${status}`;
        const roomBadge = $("roomMicStateBadge");
        if (roomBadge) {
          roomBadge.textContent = status === "active" ? "Mic active" : `Mic ${status}`;
          roomBadge.className = `status-pill ${status === "active" ? "status-live" : "status-neutral"}`;
        }
        if (error) console.warn("Mic status:", error);
      });
      audio.addEventListener("state", event => {
        currentMicState = event.detail.state;
        $("expressionState").textContent = currentMicState.toUpperCase();
        drawPreview();
        if (currentRoom) {
          const ownMember = roomMembers.find(member => member.user_id === currentUser.id);
          if (ownMember) ownMember.state = currentMicState;
          renderRoomParticipants();
        }
        if (roomChannel) broadcastPlayerState(currentMicState);
      });
    }
    await audio.start();
    await refreshAudioDevices();
  } catch (error) {
    $("micStateBadge").textContent = "Mic error";
    alert(`Gagal mengaktifkan mikrofon: ${error.message}`);
  }
}

async function stopMicrophone() {
  await audio?.stop();
  $("micStateBadge").textContent = "Mic stopped";
  currentMicState = "idle";
  $("expressionState").textContent = "IDLE";
  drawPreview();
  if (roomChannel) await broadcastPlayerState("idle");
}

async function uploadCharacterAccessories(files) {
  if (!files?.length || !supabase || !currentUser) return;
  for (const file of [...files]) {
    if (!/^image\/(png|webp)$/.test(file.type) || file.size < 1 || file.size > 8 * 1024 * 1024) {
      alert(`Aksesori ${file.name} dilewati. Gunakan PNG/WebP maksimal 8 MB.`);
      continue;
    }
    try {
      const extension = file.type === "image/webp" ? "webp" : "png";
      const storagePath = `${currentUser.id}/characters/default/accessories/${crypto.randomUUID()}.${extension}`;
      const { error } = await supabase.storage.from("vio-studio-assets").upload(storagePath, file, { upsert: false, contentType: file.type, cacheControl: "3600" });
      if (error) throw error;
      await api("record_accessory", { storage_path: storagePath, name: file.name, mime_type: file.type, size_bytes: file.size });
    } catch (error) {
      alert(`Upload aksesori ${file.name} gagal: ${error.message}`);
    }
  }
  const result = await api("my_assets");
  characterAccessories = result.accessories || [];
  drawPreview();
  renderAccessorySettingsList();
  if (currentRoom) await loadRoomMembers();
}

function renderAccessorySettingsList() {
  const host = $("accessorySettingsList");
  if (!host) return;
  host.replaceChildren();
  if (!characterAccessories.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Belum ada aksesori.";
    host.append(empty);
    return;
  }
  for (const item of characterAccessories) {
    const card = document.createElement("div");
    card.className = "setting-field";
    card.style.cssText = "padding:10px;border:1px solid var(--line);border-radius:12px";
    const heading = document.createElement("strong");
    heading.textContent = item.name || "Accessory";
    const preview = document.createElement("img");
    preview.src = item.src;
    preview.alt = item.name || "Accessory";
    preview.style.cssText = "width:100%;height:96px;object-fit:contain;background:rgba(0,0,0,.12);border-radius:8px";
    card.append(heading, preview);
    const addRange = (labelText, key, min, max, step) => {
      const wrap = document.createElement("label");
      wrap.className = "setting-field";
      const label = document.createElement("span");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.type = "range"; input.min = String(min); input.max = String(max); input.step = String(step);
      input.value = String(item[key] ?? (key === "x" || key === "y" ? 0.5 : 0.18));
      input.addEventListener("input", () => {
        const value = Number(input.value);
        if (key === "w") {
          const ratio = Number(item.h || 0.18) / Math.max(0.01, Number(item.w || 0.18));
          item.w = value; item.h = Math.min(2, Math.max(0.01, value * ratio));
        } else item[key] = value;
        drawPreview();
      });
      input.addEventListener("change", () => saveAccessorySettings(item));
      wrap.append(label, input); card.append(wrap);
    };
    addRange("Posisi horizontal", "x", 0, 1, 0.01);
    addRange("Posisi vertikal", "y", 0, 1, 0.01);
    addRange("Ukuran", "w", 0.04, 0.8, 0.01);
    const addCheck = (labelText, key, defaultValue) => {
      const label = document.createElement("label");
      label.className = "check-row";
      const input = document.createElement("input");
      input.type = "checkbox"; input.checked = item[key] ?? defaultValue;
      input.addEventListener("change", () => { item[key] = input.checked; drawPreview(); saveAccessorySettings(item); });
      label.append(input, document.createTextNode(labelText)); card.append(label);
    };
    addCheck("Ikuti gerakan avatar", "follow", true);
    addCheck("Mirror bersama avatar", "mirror", false);
    addCheck("Aktifkan efek visual", "effectsEnabled", true);
    const remove = actionButton("Hapus aksesori", async () => {
      if (!confirm(`Hapus aksesori "${item.name}"?`)) return;
      try {
        await api("delete_accessory", { accessory_id: item.id });
        characterAccessories = characterAccessories.filter(x => x.id !== item.id);
        drawPreview(); renderAccessorySettingsList();
      } catch (error) { alert(`Gagal menghapus aksesori: ${error.message}`); }
    });
    card.append(remove);
    host.append(card);
  }
}

async function saveAccessorySettings(item) {
  try {
    await api("update_accessory", {
      accessory_id: item.id, x: item.x, y: item.y, w: item.w, h: item.h,
      mirror: !!item.mirror, follow_avatar: item.follow !== false, effects_enabled: item.effectsEnabled !== false
    });
    if (currentRoom) await loadRoomMembers();
  } catch (error) { alert(`Pengaturan aksesori gagal disimpan: ${error.message}`); }
}

async function uploadCharacterAsset(state, file) {
  if (!file) return;
  if (!supabase || !currentUser) return alert("Backend belum siap.");
  if (!/^image\/(png|webp)$/.test(file.type)) return alert("Gunakan PNG atau WebP.");
  if (file.size > 8 * 1024 * 1024) return alert("Ukuran maksimal file 8 MB.");
  try {
    const { data: userData } = await supabase.auth.getUser();
    const authId = userData.user?.id;
    const storagePath = `${currentUser.id}/characters/default/${state}.${file.type === "image/webp" ? "webp" : "png"}`;
    const { error: uploadError } = await supabase.storage.from("vio-studio-assets").upload(storagePath, file, { upsert: true, contentType: file.type, cacheControl: "3600" });
    if (uploadError) throw uploadError;
    const { data: signed, error: signedError } = await supabase.storage.from("vio-studio-assets").createSignedUrl(storagePath, 3600);
    if (signedError) throw signedError;
    assetUrls[state] = signed.signedUrl;
    showMessage("loginMessage", `${state} asset berhasil diunggah.`, "success");
    drawPreview();
    await api("record_asset", { storage_path: storagePath, expression: state, mime_type: file.type, size_bytes: file.size });
  } catch (error) {
    alert(`Upload gagal: ${error.message}`);
  }
}

const previewImageCache = new Map();
let previewBlinkUntil = 0;
let nextPreviewBlinkAt = 0;
let previewBlinkTimer = 0;

function drawPreview() {
  const canvas = $("avatarCanvas");
  const width = Math.max(320, Math.min(3840, Math.round(Number(profilePreferences.outputWidth) || 1080)));
  const height = Math.max(320, Math.min(3840, Math.round(Number(profilePreferences.outputHeight) || 1920)));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const stageFrame = canvas.closest(".stage-frame");
  if (stageFrame) stageFrame.style.aspectRatio = `${width} / ${height}`;
  const roomStage = $("roomStage");
  if (roomStage && (roomStage.width !== width || roomStage.height !== height)) {
    roomStage.width = width; roomStage.height = height; roomStage.style.aspectRatio = `${width} / ${height}`;
  }
  if (!avatarRenderer) avatarRenderer = new AvatarRenderer(canvas);
  avatarRenderer.start();
  avatarRenderer.setAssets(assetUrls);
  avatarRenderer.setState(currentMicState);
  avatarRenderer.setPreferences(profilePreferences);
  const background = profilePreferences.background || {};
  avatarRenderer.setBackgroundImage(background.mode === "image" ? background.src : null);
  avatarRenderer.setBackgroundVideo(background.mode === "video" ? background.src : null);
  avatarRenderer.setAccessories(characterAccessories);
  bindAccessoryCanvasDrag(canvas);
  const hasAvatar = !!(assetUrls.idle || assetUrls.talking || assetUrls.blink || assetUrls.talking_blink);
  $("emptyAvatar").hidden = hasAvatar;
}

function accessoryCanvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvas.width / Math.max(1, rect.width),
    y: (event.clientY - rect.top) * canvas.height / Math.max(1, rect.height)
  };
}

function accessoryScreenBounds(item, canvas) {
  const W = canvas.width, H = canvas.height;
  const localX = (Number(item.x ?? 0.5) - 0.5) * W;
  const localY = (Number(item.y ?? 0.5) - 0.5) * H;
  const follows = item.follow !== false;
  const motion = avatarRenderer?.avatarMotion || { centerX: W / 2, centerY: H / 2, rotation: 0, scaleX: 1, scaleY: 1 };
  let x = localX + W / 2, y = localY + H / 2;
  let scaleX = 1, scaleY = 1;
  if (follows) {
    const dx = localX * motion.scaleX, dy = localY * motion.scaleY;
    const cos = Math.cos(motion.rotation), sin = Math.sin(motion.rotation);
    x = motion.centerX + cos * dx - sin * dy;
    y = motion.centerY + sin * dx + cos * dy;
    scaleX = Math.abs(motion.scaleX);
    scaleY = Math.abs(motion.scaleY);
  }
  return {
    x, y,
    width: Math.max(1, Number(item.w || 0.18) * W * scaleX),
    height: Math.max(1, Number(item.h || 0.18) * H * scaleY),
    motion: { ...motion },
    follows
  };
}

function bindAccessoryCanvasDrag(canvas) {
  if (canvas.dataset.accessoryDragBound === "1") return;
  canvas.dataset.accessoryDragBound = "1";
  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerdown", event => {
    if (!characterAccessories.length) return;
    const point = accessoryCanvasPoint(event, canvas);
    let selected = null;
    for (const item of [...characterAccessories].reverse()) {
      const bounds = accessoryScreenBounds(item, canvas);
      if (Math.abs(point.x - bounds.x) <= bounds.width / 2 + 10 && Math.abs(point.y - bounds.y) <= bounds.height / 2 + 10) {
        selected = { item, bounds };
        break;
      }
    }
    if (!selected && selectedAccessoryId) {
      const item = characterAccessories.find(entry => entry.id === selectedAccessoryId);
      if (item) selected = { item, bounds: accessoryScreenBounds(item, canvas) };
    }
    if (!selected) return;
    event.preventDefault();
    selectedAccessoryId = selected.item.id;
    accessoryDragState = {
      pointerId: event.pointerId,
      item: selected.item,
      startX: point.x,
      startY: point.y,
      itemX: Number(selected.item.x ?? 0.5),
      itemY: Number(selected.item.y ?? 0.5),
      motion: selected.bounds.motion,
      follows: selected.bounds.follows
    };
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
    renderAccessorySettingsList();
  });
  canvas.addEventListener("pointermove", event => {
    if (!accessoryDragState || accessoryDragState.pointerId !== event.pointerId) return;
    const point = accessoryCanvasPoint(event, canvas);
    const dx = point.x - accessoryDragState.startX;
    const dy = point.y - accessoryDragState.startY;
    let localDx = dx, localDy = dy;
    if (accessoryDragState.follows) {
      const motion = accessoryDragState.motion;
      const cos = Math.cos(motion.rotation), sin = Math.sin(motion.rotation);
      const rotatedX = cos * dx + sin * dy;
      const rotatedY = -sin * dx + cos * dy;
      localDx = rotatedX / (Math.abs(motion.scaleX) < 0.0001 ? 1 : motion.scaleX);
      localDy = rotatedY / (Math.abs(motion.scaleY) < 0.0001 ? 1 : motion.scaleY);
    }
    accessoryDragState.item.x = Math.max(0, Math.min(1, accessoryDragState.itemX + localDx / canvas.width));
    accessoryDragState.item.y = Math.max(0, Math.min(1, accessoryDragState.itemY + localDy / canvas.height));
    drawPreview();
  });
  const finishDrag = async event => {
    if (!accessoryDragState || accessoryDragState.pointerId !== event.pointerId) return;
    const item = accessoryDragState.item;
    accessoryDragState = null;
    canvas.style.cursor = "grab";
    try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch {}
    await saveAccessorySettings(item);
    renderAccessorySettingsList();
  };
  canvas.addEventListener("pointerup", finishDrag);
  canvas.addEventListener("pointercancel", finishDrag);
}

function openRoomChooser() {
  const dialog = $("roomDialog");
  $("roomDialogTitle").textContent = "GO Collaboration";
  const body = $("roomDialogBody");
  body.innerHTML = `<div class="setting-grid"><button id="hostRoomChoice" class="button button-primary" type="button">＋ HOST</button><button id="joinRoomChoice" class="button" type="button">↳ JOIN</button></div><p class="muted">Host menentukan kapasitas 1–4 orang, termasuk host. Setiap peserta membawa karakter dan preferensi profilnya sendiri.</p>`;
  $("roomDialogSubmit").hidden = true;
  body.querySelector("#hostRoomChoice").addEventListener("click", showHostForm);
  body.querySelector("#joinRoomChoice").addEventListener("click", showJoinForm);
  dialog.showModal();
}

function showHostForm() {
  const body = $("roomDialogBody");
  $("roomDialogTitle").textContent = "Create room";
  body.innerHTML = `<div class="setting-field"><label for="roomCapacity">Room capacity</label><select id="roomCapacity" class="select-input"><option value="1">1 player</option><option value="2" selected>2 players</option><option value="3">3 players</option><option value="4">4 players</option></select></div><p class="muted">Room code empat angka akan dibuat server setelah room berhasil dibuat.</p>`;
  $("roomDialogSubmit").hidden = false;
  $("roomDialogSubmit").onclick = async () => {
    try {
      if (currentRoom) await leaveRoom(false);
      const result = await api("create_room", { capacity: Number($("roomCapacity").value) });
      $("roomDialog").close();
      await enterRoom(result.room);
    } catch (error) { alert(`Room gagal dibuat: ${error.message}`); }
  };
}

function showJoinForm() {
  const body = $("roomDialogBody");
  $("roomDialogTitle").textContent = "Join room";
  body.innerHTML = `<div class="setting-field"><label for="joinCode">4-digit room code</label><input id="joinCode" class="text-input" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="0000"></div>`;
  $("roomDialogSubmit").hidden = false;
  $("roomDialogSubmit").onclick = async () => {
    try {
      if (currentRoom) await leaveRoom(false);
      const code = $("joinCode").value.trim();
      if (!/^\d{4}$/.test(code)) throw new Error("Kode room harus tepat empat angka.");
      const result = await api("join_room", { room_code: code });
      $("roomDialog").close();
      await enterRoom(result.room);
    } catch (error) { alert(`Tidak bisa bergabung: ${error.message}`); }
  };
}

async function enterRoom(room) {
  currentRoom = room;
  profilePreferences.lastRoomId = room.id;
  api("profile_save", { display_name: currentUser.display_name || currentUser.username, preferences: profilePreferences }).catch(error => console.warn("Room restore pointer could not be saved:", error.message));
  $("app").classList.add("in-room");
  showView("collaborationView");
  $("pageTitle").textContent = "GO Collaboration";
  $("roomCodeLabel").textContent = room.room_code;
  $("participantCount").textContent = `1 / ${room.capacity} connected`;
  renderRoomControls();
  await subscribeRoom(room.id);
  await loadRoomMembers();
  await broadcastPlayerState(currentMicState);
}

function renderRoomControls() {
  const panel = $("roomControls");
  panel.replaceChildren();
  const grid = document.createElement("div");
  grid.className = "setting-grid";
  const deviceField = document.createElement("div"); deviceField.className = "setting-field";
  const deviceLabel = document.createElement("label"); deviceLabel.htmlFor = "roomDevice"; deviceLabel.textContent = "Microphone input";
  const deviceSelect = document.createElement("select"); deviceSelect.id = "roomDevice"; deviceSelect.className = "select-input"; deviceSelect.innerHTML = '<option value="">System default</option>'; deviceSelect.value = roomOverrides.deviceId || "";
  deviceSelect.addEventListener("change", async () => {
    roomOverrides.deviceId = deviceSelect.value;
    if (audio) { await audio.stop(); audio.setOptions({ deviceId: roomOverrides.deviceId }); await audio.start(); }
    api("set_room_override", { room_id: currentRoom.id, overrides: { deviceId: roomOverrides.deviceId } }).catch(console.warn);
  });
  deviceField.append(deviceLabel, deviceSelect);
  for (const [key, label, min, max, step, value] of [
    ["scale", "Avatar scale", 0.2, 2.2, 0.05, roomOverrides.scale ?? 1],
    ["x", "Horizontal position", -100, 100, 1, 0],
    ["y", "Vertical position", -100, 100, 1, 0],
    ["sensitivity", "Mic sensitivity", 0.5, 2, 0.05, roomOverrides.sensitivity],
    ["boostDb", "Mic booster (dB)", 0, 24, 1, roomOverrides.boostDb],
  ]) {
    const wrap = document.createElement("div"); wrap.className = "setting-field";
    const lab = document.createElement("label"); lab.textContent = label;
    const range = document.createElement("input"); range.type = "range"; range.className = "range-input"; range.min = min; range.max = max; range.step = step; range.value = value;
    range.addEventListener("input", () => {
      roomOverrides[key] = Number(range.value);
      if (key === "sensitivity" || key === "boostDb") audio?.setOptions({ [key]: Number(range.value) });
      api("set_room_override", { room_id: currentRoom.id, overrides: { [key]: Number(range.value) } }).catch(console.warn);
      if (["scale", "x", "y"].includes(key)) {
        renderRoomParticipants();
        broadcastPlayerLayout().catch(console.warn);
      }
    });
    wrap.append(lab, range); grid.append(wrap);
  }
  panel.append(deviceField, grid, Object.assign(document.createElement("p"), { className: "muted", textContent: "Room overrides hanya berlaku di room ini dan tidak menimpa pengaturan profil." }));
  refreshAudioDevices();
}

async function subscribeRoom(roomId) {
  if (!supabase) return;
  roomChannel = supabase.channel(`room:${roomId}`, { config: { private: true, presence: { key: currentUser.id } } })
    .on("broadcast", { event: "player-state" }, ({ payload }) => {
      if (!payload?.user_id || !["idle", "talking"].includes(payload.state)) return;
      const seq = Number(payload.seq) || 0;
      if (seq && seq <= (remotePlayerSequences.get(payload.user_id) || 0)) return;
      if (seq) remotePlayerSequences.set(payload.user_id, seq);
      remotePlayerStates.set(payload.user_id, payload.state);
      const member = roomMembers.find(item => item.user_id === payload.user_id);
      if (member) member.state = payload.state;
      renderRoomParticipants();
    })
    .on("broadcast", { event: "player-layout" }, ({ payload }) => {
      if (!payload?.user_id || !payload.overrides) return;
      const seq = Number(payload.seq) || 0;
      if (seq && seq <= (remoteLayoutSequences.get(payload.user_id) || 0)) return;
      if (seq) remoteLayoutSequences.set(payload.user_id, seq);
      const member = roomMembers.find(item => item.user_id === payload.user_id);
      if (member) member.overrides = { ...(member.overrides || {}), ...payload.overrides };
      renderRoomParticipants();
    })
    .on("presence", { event: "sync" }, () => {
      const state = roomChannel.presenceState();
      $("participantCount").textContent = `${Object.keys(state).length} / ${currentRoom.capacity} connected`;
      // Existing participants must refresh profile assets when a new user joins/leaves.
      loadRoomMembers();
    });
  await supabase.realtime.setAuth();
  await new Promise((resolve, reject) => roomChannel.subscribe(status => {
    if (status === "SUBSCRIBED") {
      roomChannel.track({ user_id: currentUser.id, username: currentUser.username, state: currentMicState });
      resolve();
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error(`Realtime status: ${status}`));
  }));
}

async function broadcastPlayerState(state) {
  if (!roomChannel || !currentRoom) return;
  const payload = { user_id: currentUser.id, state, seq: ++playerSequence, at: Date.now() };
  const results = await Promise.allSettled([
    roomChannel.send({ type: "broadcast", event: "player-state", payload }),
    api("set_room_state", { room_id: currentRoom.id, state }),
  ]);
  const failed = results.find(result => result.status === "rejected");
  if (failed) console.warn("Room state sync partially failed:", failed.reason);
}

async function broadcastPlayerLayout() {
  if (!roomChannel || !currentRoom) return;
  const { scale, x, y } = roomOverrides;
  await roomChannel.send({ type: "broadcast", event: "player-layout", payload: { user_id: currentUser.id, seq: ++layoutSequence, overrides: { scale, x, y }, at: Date.now() } });
}

async function loadRoomMembers() {
  try {
    const result = await api("room_members", { room_id: currentRoom.id });
    roomMembers = result.members || [];
    const ownMember = roomMembers.find(member => member.user_id === currentUser.id);
    if (ownMember?.overrides) {
      roomOverrides = { ...roomOverrides, ...ownMember.overrides };
      audio?.setOptions({ deviceId: roomOverrides.deviceId, sensitivity: roomOverrides.sensitivity, boostDb: roomOverrides.boostDb });
    }
    for (const member of roomMembers) member.state = remotePlayerStates.get(member.user_id) || member.state || "idle";
    renderRoomParticipants();
  } catch (error) { console.warn("Room member load:", error); }
}

function renderRoomParticipants() {
  const canvas = $("roomStage");
  const visible = roomMembers.slice(0, 4);
  const hostMember = visible.find(member => member.is_host) || visible[0];
  const output = hostMember?.preferences || profilePreferences;
  const width = Math.max(320, Math.min(3840, Math.round(Number(output.outputWidth) || 1080)));
  const height = Math.max(320, Math.min(3840, Math.round(Number(output.outputHeight) || 1920)));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  canvas.style.aspectRatio = `${width} / ${height}`;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const slotWidth = canvas.width / Math.max(1, visible.length);
  const tags = $("participantNames");
  tags.replaceChildren();
  if (!visible.length) {
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    for (const entry of roomPreviewRenderers.values()) entry.renderer.stop();
    roomPreviewRenderers.clear();
    tags.textContent = "Waiting for participants…";
    return;
  }
  const visibleIds = new Set(visible.map(member => member.user_id));
  for (const [userId, entry] of roomPreviewRenderers) {
    if (!visibleIds.has(userId)) {
      entry.renderer.stop();
      roomPreviewRenderers.delete(userId);
    }
  }
  for (const [index, member] of visible.entries()) {
    let entry = roomPreviewRenderers.get(member.user_id);
    if (!entry) {
      const playerCanvas = document.createElement("canvas");
      entry = { canvas: playerCanvas, renderer: new AvatarRenderer(playerCanvas) };
      roomPreviewRenderers.set(member.user_id, entry);
    }
    const width = Math.max(1, Math.round(slotWidth));
    const height = Math.max(1, canvas.height);
    if (entry.canvas.width !== width || entry.canvas.height !== height) {
      entry.canvas.width = width;
      entry.canvas.height = height;
    }
    const overrides = member.overrides || {};
    const preferences = {
      ...(member.preferences || {}),
      scale: overrides.scale ?? member.preferences?.scale ?? 1,
      offsetX: Math.max(-100, Math.min(100, Number(overrides.x) || 0)) * width * 0.004,
      offsetY: Math.max(-100, Math.min(100, Number(overrides.y) || 0)) * height * 0.0035
    };
    entry.renderer.setAssets(member.assets || {});
    entry.renderer.setAccessories(member.accessories || []);
    entry.renderer.setPreferences(preferences);
    const background = preferences.background || {};
    entry.renderer.setBackgroundImage(background.mode === "image" ? background.src : null);
    entry.renderer.setBackgroundVideo(background.mode === "video" ? background.src : null);
    entry.renderer.setState(member.state === "talking" ? "talking" : "idle");
    entry.renderer.start();


    const state = member.state === "talking" ? "talking" : "idle";
    const tag = document.createElement("span");
    tag.className = `participant-tag ${state === "talking" ? "is-talking" : ""}`;
    const name = document.createElement("strong");
    name.textContent = member.username;
    tag.append(name, document.createTextNode(state.toUpperCase()));
    tags.append(tag);
  }
  if (!renderFrame) renderFrame = requestAnimationFrame(drawRoomStageFrame);
}

function drawRoomStageFrame() {
  renderFrame = 0;
  if (!currentRoom) return;
  const canvas = $("roomStage");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const visible = roomMembers.slice(0, 4);
  const slotWidth = canvas.width / Math.max(1, visible.length);
  visible.forEach((member, index) => {
    const entry = roomPreviewRenderers.get(member.user_id);
    if (entry?.canvas) ctx.drawImage(entry.canvas, slotWidth * index, 0, slotWidth, canvas.height);
  });
  renderFrame = requestAnimationFrame(drawRoomStageFrame);
}

async function leaveRoom(restoreView = true) {
  if (roomChannel) {
    try { await broadcastPlayerState("idle"); } catch {}
    try { await roomChannel.untrack(); await supabase.removeChannel(roomChannel); } catch {}
    roomChannel = null;
  }
  if (currentRoom) {
    try { await api("leave_room", { room_id: currentRoom.id }); } catch (error) { console.warn("Leave room:", error); }
    if (profilePreferences.lastRoomId === currentRoom.id) {
      delete profilePreferences.lastRoomId;
      try { await api("profile_save", { display_name: currentUser.display_name || currentUser.username, preferences: profilePreferences }); } catch (error) { console.warn("Room restore pointer could not be cleared:", error.message); }
    }
  }
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = 0;
  for (const entry of roomPreviewRenderers.values()) entry.renderer.stop();
  roomPreviewRenderers.clear();
  currentRoom = null; roomMembers = []; remotePlayerStates.clear(); remotePlayerSequences.clear(); remoteLayoutSequences.clear(); roomPreviewImages.clear();
  $("app").classList.remove("in-room");
  if (restoreView && currentUser) selectMenu("profile");
}

async function generateOverlayLink() {
  try {
    let room = currentRoom;
    if (!room) {
      const created = await api("create_room", { capacity: 1, purpose: "personal_overlay" });
      room = created.room;
      currentRoom = room;
      profilePreferences.lastRoomId = room.id;
      await api("profile_save", { display_name: currentUser.display_name || currentUser.username, preferences: profilePreferences });
      await subscribeRoom(room.id);
      await loadRoomMembers();
    }
    const result = await api("issue_room_overlay", { room_id: room.id });
    const url = new URL("./overlay.html", window.location.href);
    url.hash = new URLSearchParams({ room: result.room_id, token: result.overlay_token }).toString();
    await navigator.clipboard.writeText(url.toString());
    alert(`OBS Link berhasil disalin:\n${url.toString()}`);
  } catch (error) { alert(`OBS Link belum bisa dibuat: ${error.message}`); }
}

async function loadAdminOverview() {
  try {
    const result = await api("admin_overview");
    $("adminUserCount").textContent = result.users.length;
    $("adminRoomCount").textContent = result.active_rooms;
    $("adminAssetCount").textContent = result.asset_count;
    const table = document.createElement("table"); table.className = "data-table";
    table.innerHTML = "<thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>";
    const tbody = document.createElement("tbody");
    result.users.forEach(user => {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td"); tdName.textContent = user.username;
      const tdRole = document.createElement("td"); tdRole.textContent = user.role;
      const tdStatus = document.createElement("td"); tdStatus.textContent = user.is_active ? "Active" : "Disabled";
      const tdActions = document.createElement("td");
      const view = document.createElement("button"); view.className = "button button-quiet"; view.textContent = "Inspect"; view.addEventListener("click", () => startAdminSupportView(user.id));
      tdActions.append(view);
      if (user.username === "paipai77" && user.role === "admin") {
        const pairRoot = document.createElement("button"); pairRoot.className = "button button-quiet"; pairRoot.textContent = "Pair another Admin device"; pairRoot.addEventListener("click", async () => { const issued = await api("admin_issue_pairing_code", { target_user_id: user.id }); alert(`One-time pairing code for @paipai77 (expires in ${issued.expires_in_hours} hours):\n\n${issued.pairing_code}`); });
        tdActions.append(pairRoot);
      }
      if (user.username !== "paipai77" && user.role !== "admin") {
        const role = document.createElement("button"); role.className = "button button-quiet"; role.textContent = "Change role"; role.addEventListener("click", async () => { const next = prompt("Role: user atau tester", user.role); if (!["user", "tester"].includes((next || "").toLowerCase())) return; await api("admin_set_role", { target_user_id: user.id, role: next.toLowerCase() }); await loadAdminOverview(); });
        const pair = document.createElement("button"); pair.className = "button button-quiet"; pair.textContent = "Pair device"; pair.addEventListener("click", async () => { const issued = await api("admin_issue_pairing_code", { target_user_id: user.id }); alert(`One-time device code for @${user.username} (expires in ${issued.expires_in_hours} hours):\n\n${issued.pairing_code}`); });
        const resetDevices = document.createElement("button"); resetDevices.className = "button button-quiet"; resetDevices.textContent = "Reset devices"; resetDevices.addEventListener("click", async () => { if (!confirm(`Revoke all paired devices for @${user.username} and issue a new one-time pairing code?`)) return; const reset = await api("admin_reset_devices", { target_user_id: user.id }); alert(`Old device sessions revoked. New pairing code for @${user.username}:\n\n${reset.pairing_code}`); });
        const toggle = document.createElement("button"); toggle.className = "button button-quiet"; toggle.textContent = user.is_active ? "Disable" : "Enable"; toggle.addEventListener("click", async () => { await api("admin_disable_user", { target_user_id: user.id, is_active: !user.is_active }); await loadAdminOverview(); });
        const remove = document.createElement("button"); remove.className = "button button-danger"; remove.textContent = "Delete"; remove.addEventListener("click", async () => { if (confirm(`Delete user ${user.username} and their uploaded assets? This cannot be undone.`)) { await api("admin_delete_user", { target_user_id: user.id }); await loadAdminOverview(); } });
        tdActions.append(role, pair, resetDevices, toggle, remove);
      }
      tr.append(tdName, tdRole, tdStatus, tdActions); tbody.append(tr);
    });
    table.append(tbody); $("adminUsersTable").replaceChildren(table);
    const rooms = document.createElement("table"); rooms.className = "data-table";
    rooms.innerHTML = "<thead><tr><th>Code</th><th>Host</th><th>Members</th><th>Status</th><th>Action</th></tr></thead>";
    const roomBody = document.createElement("tbody");
    (result.rooms || []).forEach(room => {
      const tr=document.createElement("tr");
      [room.room_code,room.host_username,`${room.member_count}/${room.capacity}`,room.status].forEach(value=>{const td=document.createElement("td");td.textContent=value??"—";tr.append(td);});
      const actionCell=document.createElement("td");
      const edit=document.createElement("button"); edit.className="button button-quiet"; edit.textContent="Edit"; edit.addEventListener("click",async()=>{const capacity=prompt("Room capacity (1-4)",String(room.capacity));if(capacity===null)return;const roomCode=prompt("Room code (4 digits)",room.room_code);if(roomCode===null)return;await api("admin_update_room",{room_id:room.id,capacity:Number(capacity),room_code:roomCode});await loadAdminOverview();}); actionCell.append(edit);
      if(room.status === "active") { const close=document.createElement("button"); close.className="button button-danger"; close.textContent="Close"; close.addEventListener("click",async()=>{if(confirm(`Close room ${room.room_code}?`)){await api("admin_close_room",{room_id:room.id});await loadAdminOverview();}}); actionCell.append(close); }
      tr.append(actionCell); roomBody.append(tr);
    });
    rooms.append(roomBody); $("adminRoomsTable").replaceChildren(rooms);
    const auditTitle = document.createElement("p");
    auditTitle.className = "muted";
    auditTitle.textContent = `${result.audit_count ?? 0} recorded actions · showing latest ${result.recent_audit?.length || 0}`;
    const auditTable = document.createElement("table"); auditTable.className = "data-table";
    auditTable.innerHTML = "<thead><tr><th>Time</th><th>Action</th><th>Actor ID</th><th>Target ID</th><th>Details</th></tr></thead>";
    const auditBody = document.createElement("tbody");
    (result.recent_audit || []).forEach(entry => {
      const tr = document.createElement("tr");
      const time = document.createElement("td"); time.textContent = new Date(entry.created_at).toLocaleString();
      const action = document.createElement("td"); action.textContent = entry.action;
      const actor = document.createElement("td"); actor.textContent = entry.actor_user_id || "system";
      const target = document.createElement("td"); target.textContent = entry.target_user_id || "—";
      const details = document.createElement("td"); details.textContent = JSON.stringify(entry.details || {});
      tr.append(time, action, actor, target, details); auditBody.append(tr);
    });
    auditTable.append(auditBody);
    $("adminAuditLog").replaceChildren(auditTitle, auditTable);
  } catch (error) {
    $("adminUsersTable").textContent = `Admin API belum tersedia: ${error.message}`;
  }
}

async function createUser() {
  const username = prompt("Username baru (3–24 karakter, huruf/angka/_):");
  if (!username) return;
  const role = prompt("Role: user atau tester", "user");
  if (!["user", "tester"].includes((role || "").toLowerCase())) return alert("Role harus user atau tester.");
  try {
    const result = await api("admin_create_user", { username, role: role.toLowerCase() });
    alert(`Akun dibuat. Berikan kode pairing ini secara privat kepada pengguna (hanya tampil sekali):\n\n${result.pairing_code}`);
    await loadAdminOverview();
  } catch (error) { alert(`Gagal membuat akun: ${error.message}`); }
}

async function startAdminSupportView(userId) {
  try {
    const result = await api("admin_impersonation_start", { target_user_id: userId, reason: "Admin support / troubleshooting" });
    activeSupportSession = { token: result.support_session, targetId: userId, username: result.target.username };
    const detail = await api("admin_user_detail", { target_user_id: userId, support_session: result.support_session });
    const panel = document.createElement("div");
    panel.className = "support-view-card panel-card";
    panel.style.cssText = "margin:16px 20px;padding:14px;border:1px solid #d7b66b66;border-radius:14px;background:#d7b66b10";
    const heading = document.createElement("strong"); heading.textContent = `SUPPORT VIEW · @${detail.user.username}`;
    const note = document.createElement("p"); note.className = "muted"; note.textContent = "Read-only identity preview with separately authorized profile/file changes. This is not a user password/session takeover. Support session expires after 15 minutes and is audited.";
    const profile = detail.user.vio_profiles?.[0] || { preferences: {} };
    const displayNameField = settingField("Display name", "adminTargetDisplayName", detail.user.display_name || detail.user.username);
    const prefsField = document.createElement("div"); prefsField.className = "setting-field";
    const prefsLabel = document.createElement("label"); prefsLabel.textContent = "Profile preferences (JSON)";
    const prefsInput = document.createElement("textarea"); prefsInput.id = "adminTargetPreferences"; prefsInput.className = "text-input"; prefsInput.rows = 6; prefsInput.value = JSON.stringify(profile.preferences || {}, null, 2);
    prefsField.append(prefsLabel, prefsInput);
    const save = actionButton("Save user profile", async () => {
      let preferences; try { preferences = JSON.parse(prefsInput.value || "{}"); } catch { return alert("Profile preferences harus JSON valid."); }
      if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return alert("Profile preferences harus berupa objek JSON.");
      await api("admin_update_profile", { target_user_id: userId, support_session: activeSupportSession?.token, display_name: $("adminTargetDisplayName").value, preferences });
      alert("Profil pengguna diperbarui dan tercatat di Audit Log.");
    }, true);
    const assetsTitle = document.createElement("h3"); assetsTitle.textContent = "Uploaded character assets";
    const assetsList = document.createElement("div"); assetsList.className = "asset-list";
    (detail.assets || []).forEach(asset => {
      const row = document.createElement("div"); row.className = "asset-row";
      const label = document.createElement("span"); label.textContent = `${asset.expression} · ${asset.mime_type} · ${Math.ceil(asset.size_bytes / 1024)} KB`;
      row.append(label);
      if (asset.signed_url) { const link = document.createElement("a"); link.href = asset.signed_url; link.target = "_blank"; link.rel = "noopener"; link.textContent = "Open"; row.append(link); }
      const remove = actionButton("Delete file", async () => { if (!confirm(`Delete ${asset.expression} asset for @${detail.user.username}?`)) return; await api("admin_delete_asset", { target_user_id: userId, asset_id: asset.id, asset_type: asset.asset_type || "expression", support_session: activeSupportSession?.token }); row.remove(); });
      row.append(remove); assetsList.append(row);
    });
    if (!detail.assets?.length) assetsList.textContent = "No uploaded assets.";
    const exit = actionButton("Exit support view", async () => {
      await api("admin_impersonation_end", { support_session: activeSupportSession?.token });
      activeSupportSession = null;
      panel.remove();
      await loadAdminOverview();
    }, true);
    panel.append(heading, note, displayNameField, prefsField, save, assetsTitle, assetsList, exit);
    $("adminUsersTable").after(panel);
  } catch (error) { alert(`Support view gagal: ${error.message}`); }
}

function setupEvents() {
  $("sidebarToggle").addEventListener("click", () => {
    const side = $("sidebar"); side.classList.toggle("is-collapsed");
    $("sidebarToggle").title = side.classList.contains("is-collapsed") ? "Expand sidebar" : "Collapse sidebar";
  });
  $("usernameInput").addEventListener("input", () => {
    const isRootAdmin = $("usernameInput").value.trim().toLowerCase() === "paipai77";
    $("pairingLabel").textContent = isRootAdmin ? "One-time Admin bootstrap token" : "Kode pairing perangkat";
    $("pairingInput").placeholder = isRootAdmin ? "Token setup Admin sekali pakai" : "Kode sekali pakai dari Admin";
    $("pairingHint").textContent = isRootAdmin
      ? "Hanya untuk aktivasi Superuser pertama. Simpan token di server, bukan di repository."
      : "Hanya diperlukan pada perangkat baru atau setelah sesi dihapus. Bukan password.";
  });
  $("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const username = $("usernameInput").value.trim().toLowerCase();
    const pairing = $("pairingInput").value.trim();
    $("loginButton").disabled = true;
    try { await login(username, pairing); }
    catch (error) { showMessage("loginMessage", error.message, "error"); if (/pairing|pasangkan/i.test(error.message)) $("pairingWrap").hidden = false; }
    finally { $("loginButton").disabled = false; }
  });
  $("logoutButton").addEventListener("click", logout);
  $("topRoomButton").addEventListener("click", openRoomChooser);
  $("exitRoom").addEventListener("click", () => leaveRoom(true));
  $("copyRoomCode").addEventListener("click", async () => { if (currentRoom) await navigator.clipboard.writeText(currentRoom.room_code); });
  $("obsLinkButton").addEventListener("click", generateOverlayLink);
  $("roomObsLink").addEventListener("click", generateOverlayLink);
  $("createUserButton").addEventListener("click", createUser);
  $("refreshRoomsButton").addEventListener("click", loadAdminOverview);
}

async function boot() {
  setupEvents();
  const configured = await loadConfig();
  if (!configured) { showView("loginGate"); return; }
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    try {
      const identity = await api("me");
      showMessage("loginMessage", `Perangkat ini terhubung ke @${identity.user.username}. Masukkan username untuk melanjutkan.`, "info");
    } catch {
      // Keep the login gate visible; a fresh device will be paired by Admin.
    }
  }
  showView("loginGate");
}

boot().catch(error => {
  console.error("Vio Studio boot error:", error);
  showMessage("loginMessage", `Gagal memulai aplikasi: ${error.message}`, "error");
});
