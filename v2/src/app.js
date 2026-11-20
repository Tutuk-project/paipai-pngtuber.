import { AudioEngine } from "./audio-engine.js";
import { AvatarRenderer } from "./avatar-renderer.js";

const $ = (id) => document.getElementById(id);
const viewIds = ["loginGate", "editorView", "collaborationView", "adminView", "overlayView"];
const menus = [
  { id: "profile", icon: "◉", label: "Profile", title: "Profile" },
  { id: "character", icon: "▧", label: "Character", title: "Character & Assets" },
  { id: "audio", icon: "♫", label: "Microphone", title: "Microphone" },
  { id: "effects", icon: "✧", label: "Visual Effect +", title: "Visual Effect +" },
  { id: "collaboration", icon: "◎", label: "GO Collaboration", title: "GO Collaboration" },
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
let characterLibrary = [];
let activeCharacterId = null;
let activeMakeupEffect = null;
let characterDeleteDialog = null;
let avatarScalePercent = 0;
let profilePreferences = { scale: 1, avatarScalePercent: 0, outputWidth: 1080, outputHeight: 1920, sensitivity: 1, boostDb: 6, deviceId: "" };
let roomOverrides = { scale: 1, x: 0, y: 0, sensitivity: 1, boostDb: 6, deviceId: "" };
let renderFrame = 0;
let playerSequence = 0;
let layoutSequence = 0;
let activeSupportSession = null;
let micEnabled = false;
let generatedOverlayUrl = "";
let overlayGenerationBusy = false;
let toastTimer = 0;
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

function makeSettingsAccordion(title, subtitle = "") {
  const details = document.createElement("details");
  details.className = "settings-accordion";
  const summary = document.createElement("summary");
  const copy = document.createElement("span");
  copy.className = "accordion-copy";
  const heading = document.createElement("strong");
  heading.textContent = title;
  copy.append(heading);
  if (subtitle) {
    const hint = document.createElement("small");
    hint.textContent = subtitle;
    copy.append(hint);
  }
  const chevron = document.createElement("span");
  chevron.className = "accordion-chevron";
  chevron.textContent = "›";
  summary.append(copy, chevron);
  details.append(summary);
  const body = document.createElement("div");
  body.className = "accordion-body";
  details.append(body);
  return { details, body };
}

function showAppToast(message, type = "success") {
  if (typeof showToast === "function") return showToast(message, type);
  showMessage("loginMessage", message, type);
}

async function refreshCharacterLibrary() {
  const result = await api("character_library");
  characterLibrary = result.characters || [];
  activeCharacterId = result.active_character_id || null;
  return characterLibrary;
}

async function loadActiveCharacterAssets() {
  const result = await api("my_assets");
  activeCharacterId = result.character_id || activeCharacterId;
  assetUrls = { idle: null, talking: null, blink: null, talking_blink: null, ...(result.assets || {}) };
  characterAccessories = result.accessories || [];
  if (result.background) profilePreferences.background = result.background;
  drawPreview();
  renderAccessorySettingsList();
  renderAccessoryQuickScales();
  return result;
}

async function switchActiveCharacter(characterId) {
  await api("set_active_character", { character_id: characterId });
  activeCharacterId = characterId;
  await loadActiveCharacterAssets();
  await refreshCharacterLibrary();
  renderSettings("character");
  showAppToast("Avatar aktif berhasil diganti");
  if (currentRoom) {
    await loadRoomMembers();
    await broadcastMemberAssetsUpdated();
  }
}

async function createCharacterDraft() {
  const result = await api("create_character_draft");
  activeCharacterId = result.character.id;
  await refreshCharacterLibrary();
  assetUrls = { idle: null, talking: null, blink: null, talking_blink: null };
  characterAccessories = [];
  selectedAccessoryId = null;
  drawPreview();
  renderAccessorySettingsList();
  renderAccessoryQuickScales();
  renderSettings("character");
  showAppToast("Draft avatar baru dibuat");
}

async function saveCurrentCharacter() {
  if (!activeCharacterId) {
    await refreshCharacterLibrary();
    if (!activeCharacterId) throw new Error("Draft avatar belum tersedia.");
  }
  const result = await api("save_character", { character_id: activeCharacterId });
  await refreshCharacterLibrary();
  renderSettings("character");
  showAppToast(result.already_saved ? "Perubahan avatar sudah tersimpan otomatis" : `${result.character.name} berhasil disimpan`);
}

function openCharacterDeleteDialog() {
  if (!characterDeleteDialog) {
    characterDeleteDialog = document.createElement("dialog");
    characterDeleteDialog.className = "modal character-delete-dialog";
    characterDeleteDialog.innerHTML = `
      <div class="modal-heading">
        <div><p class="eyebrow">AVATAR LIBRARY</p><h2>Hapus karakter</h2></div>
        <button class="icon-button character-dialog-close" type="button" aria-label="Tutup">×</button>
      </div>
      <div class="character-delete-list"></div>`;
    characterDeleteDialog.querySelector(".character-dialog-close").addEventListener("click", () => characterDeleteDialog.close());
    characterDeleteDialog.addEventListener("click", event => {
      if (event.target === characterDeleteDialog) characterDeleteDialog.close();
    });
    document.body.append(characterDeleteDialog);
  }
  const list = characterDeleteDialog.querySelector(".character-delete-list");
  list.replaceChildren();
  const saved = characterLibrary.filter(item => item.is_saved);
  if (!saved.length) {
    const empty = document.createElement("p");
    empty.className = "muted character-empty";
    empty.textContent = "Belum ada karakter tersimpan.";
    list.append(empty);
  }
  for (const character of saved) {
    const row = document.createElement("div");
    row.className = "character-delete-row";
    const image = document.createElement("img");
    image.alt = "";
    image.src = character.preview || "";
    image.hidden = !character.preview;
    const fallback = document.createElement("span");
    fallback.className = "character-thumb-fallback";
    fallback.textContent = "✧";
    fallback.hidden = !!character.preview;
    const name = document.createElement("strong");
    name.textContent = character.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button delete-icon-button";
    remove.setAttribute("aria-label", `Hapus ${character.name}`);
    remove.title = `Hapus ${character.name}`;
    remove.textContent = "🗑";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        const result = await api("delete_character", { character_id: character.id });
        activeCharacterId = result.active_character_id || null;
        await refreshCharacterLibrary();
        await loadActiveCharacterAssets();
        openCharacterDeleteDialog();
        renderSettings("character");
        if (currentRoom) {
          await loadRoomMembers();
          await broadcastMemberAssetsUpdated();
        }
        showAppToast(`${character.name} dihapus`);
      } catch (error) {
        remove.disabled = false;
        showAppToast(`Gagal menghapus karakter: ${error.message}`, "error");
      }
    });
    const copy = document.createElement("div");
    copy.className = "character-delete-copy";
    copy.append(name, document.createTextNode(character.is_active ? "Sedang digunakan" : "Avatar tersimpan"));
    const thumb = document.createElement("div");
    thumb.className = "character-delete-thumb";
    thumb.append(image, fallback);
    row.append(thumb, copy, remove);
    list.append(row);
  }
  if (!characterDeleteDialog.open) characterDeleteDialog.showModal();
}

function buildExpressionUploadTile(state, labelText) {
  const tile = document.createElement("div");
  tile.className = "expression-upload-tile";
  tile.dataset.expression = state;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/webp";
  input.hidden = true;
  input.setAttribute("aria-label", `Upload ${labelText}`);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "expression-upload-button";
  button.setAttribute("aria-label", `Tambah ${labelText}`);
  const preview = document.createElement("img");
  preview.className = "expression-upload-preview";
  preview.alt = labelText;
  const plus = document.createElement("span");
  plus.className = "expression-upload-plus";
  plus.textContent = "+";
  const caption = document.createElement("span");
  caption.className = "expression-upload-caption";
  caption.textContent = labelText;
  button.append(preview, plus, caption);
  const updatePreview = () => {
    const src = assetUrls[state];
    preview.hidden = !src;
    plus.hidden = !!src;
    preview.src = src || "";
    tile.classList.toggle("has-image", !!src);
  };
  button.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    await uploadCharacterAsset(state, file);
    updatePreview();
  });
  tile.append(input, button);
  updatePreview();
  return tile;
}

function renderCharacterWorkspace(content) {
  const characterGroup = makeSettingsAccordion("Character & Assets", "Avatar tersimpan, ekspresi PNG, dan aksesori");
  const selectorField = document.createElement("div");
  selectorField.className = "setting-field character-selector-field";
  const selectorLabel = document.createElement("label");
  selectorLabel.textContent = "Avatar tersimpan";
  selectorLabel.htmlFor = "savedCharacterSelect";
  const select = document.createElement("select");
  select.id = "savedCharacterSelect";
  select.className = "select-input";
  const saved = characterLibrary.filter(item => item.is_saved);
  const active = characterLibrary.find(item => item.id === activeCharacterId);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = saved.length ? "Pilih avatar tersimpan" : "Belum ada karakter";
  placeholder.disabled = true;
  placeholder.selected = !active?.is_saved;
  select.append(placeholder);
  for (const character of saved) {
    const option = document.createElement("option");
    option.value = character.id;
    option.textContent = character.name;
    option.selected = character.id === activeCharacterId;
    select.append(option);
  }
  if (active && !active.is_saved) {
    const draft = document.createElement("option");
    draft.value = active.id;
    draft.textContent = "Draft baru · belum disimpan";
    draft.selected = true;
    select.append(draft);
  }
  const createOption = document.createElement("option");
  createOption.value = "__new_avatar__";
  createOption.textContent = "＋ Buat avatar baru";
  select.append(createOption);
  select.addEventListener("change", async () => {
    const value = select.value;
    try {
      if (value === "__new_avatar__") await createCharacterDraft();
      else if (value) await switchActiveCharacter(value);
    } catch (error) {
      showAppToast(`Tidak dapat mengganti avatar: ${error.message}`, "error");
      renderSettings("character");
    }
  });
  selectorField.append(selectorLabel, select);

  const uploadTitle = document.createElement("p");
  uploadTitle.className = "muted";
  uploadTitle.textContent = "Tekan tombol + untuk menambahkan ekspresi. Setelah diunggah, file tampil sebagai thumbnail tanpa nama file.";
  const uploadGrid = document.createElement("div");
  uploadGrid.className = "expression-upload-grid";
  for (const [state, label] of [["idle","Idle"],["talking","Talking"],["blink","Blink"],["talking_blink","Talking Blink"]]) {
    uploadGrid.append(buildExpressionUploadTile(state, label));
  }
  const characterActions = document.createElement("div");
  characterActions.className = "character-action-row";
  characterActions.append(
    actionButton("Simpan karakter", () => saveCurrentCharacter().catch(error => showAppToast(error.message, "error")), true),
    actionButton("Hapus karakter", openCharacterDeleteDialog)
  );

  const accessorySection = document.createElement("section");
  accessorySection.className = "accessory-library";
  const accessoryHeading = document.createElement("div");
  accessoryHeading.className = "accessory-library-heading";
  const accessoryTitle = document.createElement("h3");
  accessoryTitle.textContent = "Accessories";
  const accessoryHint = document.createElement("p");
  accessoryHint.className = "muted";
  accessoryHint.textContent = "Tekan + untuk mengunggah, lalu geser aksesori langsung di jendela preview. Skala tiap aksesori tersedia di bawah indikator mikrofon.";
  accessoryHeading.append(accessoryTitle, accessoryHint);
  const accessoryInput = document.createElement("input");
  accessoryInput.type = "file";
  accessoryInput.accept = "image/png,image/webp";
  accessoryInput.multiple = true;
  accessoryInput.hidden = true;
  const accessoryAdd = document.createElement("button");
  accessoryAdd.type = "button";
  accessoryAdd.className = "accessory-add-tile";
  accessoryAdd.innerHTML = '<span>+</span><small>Tambah aksesori</small>';
  accessoryAdd.addEventListener("click", () => accessoryInput.click());
  accessoryInput.addEventListener("change", async () => {
    const files = [...(accessoryInput.files || [])];
    accessoryInput.value = "";
    await uploadCharacterAccessories(files);
  });
  const accessoryControls = document.createElement("div");
  accessoryControls.id = "accessorySettingsList";
  accessoryControls.className = "accessory-library-grid";
  accessorySection.append(accessoryHeading, accessoryInput, accessoryAdd, accessoryControls);

  const uploadCard = document.createElement("div");
  uploadCard.className = "character-upload-section";
  uploadCard.append(selectorField, uploadTitle, uploadGrid, characterActions, accessorySection);
  characterGroup.body.append(uploadCard);

  const main = makeSettingsAccordion("Main Settings", "Gerakan avatar, mirror, dan resolusi output");
  const motion = document.createElement("div");
  motion.className = "setting-grid";
  const fields = [
    ["bounce", "Talking bounce", 0, 0.12, 0.005, 0.035],
    ["squash", "Talking squash", 0, 0.25, 0.005, 0.07],
    ["bounceMs", "Bounce duration (ms)", 120, 600, 10, 240],
    ["idleBob", "Idle bob", 0, 0.03, 0.001, 0.006],
    ["sway", "Sway (degrees)", 0, 18, 0.5, 0],
    ["breathing", "Breathing (%)", 0, 8, 0.25, 0],
    ["blinkRate", "Blink rate", 1, 12, 0.5, 4],
    ["fps", "Preview FPS", 10, 60, 5, 30]
  ];
  for (const [key, label, min, max, step, defaultValue] of fields) {
    const field = settingField(label, `main_${key}`, String(profilePreferences[key] ?? defaultValue), "", "range");
    const input = field.querySelector("input");
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.addEventListener("input", () => { profilePreferences[key] = Number(input.value); drawPreview(); });
    motion.append(field);
  }
  const mirror = document.createElement("label");
  mirror.className = "check-field";
  const mirrorInput = document.createElement("input");
  mirrorInput.type = "checkbox";
  mirrorInput.checked = profilePreferences.mirror !== false;
  mirrorInput.addEventListener("change", () => { profilePreferences.mirror = mirrorInput.checked; drawPreview(); });
  mirror.append(mirrorInput, document.createTextNode("Mirror avatar"));
  motion.append(mirror);

  const resolutionTitle = document.createElement("h3");
  resolutionTitle.textContent = "Output resolution";
  const resolution = document.createElement("div");
  resolution.className = "setting-grid";
  const presetField = document.createElement("div");
  presetField.className = "setting-field";
  const presetLabel = document.createElement("label");
  presetLabel.textContent = "Preset";
  const preset = document.createElement("select");
  preset.className = "select-input";
  preset.innerHTML = '<option value="1080x1920">TikTok Portrait · 1080 × 1920</option><option value="720x1280">Portrait HD · 720 × 1280</option><option value="1920x1080">Landscape Full HD · 1920 × 1080</option><option value="1280x720">Landscape HD · 1280 × 720</option><option value="1080x1080">Square · 1080 × 1080</option><option value="custom">Custom dimensions</option>';
  const key = `${Number(profilePreferences.outputWidth) || 1080}x${Number(profilePreferences.outputHeight) || 1920}`;
  preset.value = ["1080x1920","720x1280","1920x1080","1280x720","1080x1080"].includes(key) ? key : "custom";
  const widthField = settingField("Width (px)", "main_outputWidth", String(profilePreferences.outputWidth || 1080));
  const width = widthField.querySelector("input"); width.type = "number"; width.min = "320"; width.max = "3840"; width.step = "1";
  const heightField = settingField("Height (px)", "main_outputHeight", String(profilePreferences.outputHeight || 1920));
  const height = heightField.querySelector("input"); height.type = "number"; height.min = "320"; height.max = "3840"; height.step = "1";
  const applyResolution = () => {
    const nextWidth = Math.max(320, Math.min(3840, Math.round(Number(width.value) || 1080)));
    const nextHeight = Math.max(320, Math.min(3840, Math.round(Number(height.value) || 1920)));
    if (nextWidth * nextHeight > 8294400) return showAppToast("Resolusi melebihi batas 8,3 megapiksel.", "error");
    profilePreferences.outputWidth = nextWidth;
    profilePreferences.outputHeight = nextHeight;
    width.value = String(nextWidth); height.value = String(nextHeight);
    const nextKey = `${nextWidth}x${nextHeight}`;
    preset.value = ["1080x1920","720x1280","1920x1080","1280x720","1080x1080"].includes(nextKey) ? nextKey : "custom";
    drawPreview();
  };
  preset.addEventListener("change", () => {
    if (preset.value === "custom") return;
    const [nextWidth,nextHeight] = preset.value.split("x").map(Number);
    profilePreferences.outputWidth = nextWidth; profilePreferences.outputHeight = nextHeight;
    width.value = String(nextWidth); height.value = String(nextHeight);
    drawPreview();
  });
  width.addEventListener("change", applyResolution);
  height.addEventListener("change", applyResolution);
  presetField.append(presetLabel, preset);
  resolution.append(presetField, widthField, heightField);
  const save = actionButton("Simpan Main Settings", async () => {
    try {
      await api("profile_save", { display_name: currentUser.display_name || currentUser.username, preferences: profilePreferences });
      drawPreview();
      if (currentRoom) await broadcastMemberAssetsUpdated();
      showAppToast("Main Settings tersimpan");
    } catch (error) { showAppToast(`Gagal menyimpan: ${error.message}`, "error"); }
  }, true);
  main.body.append(motion, resolutionTitle, resolution, save);

  content.append(characterGroup.details, main.details);
  renderAccessorySettingsList();
  renderAccessoryQuickScales();
}

function buildEffectDefaults(raw = {}) {
  const states = ["idle", "talking", "blink", "talking_blink"];
  const definitions = [
    ["filter", { intensity: 55, color: "#ffd7b8", filter: { hue: 0, saturation: 100, brightness: 100, contrast: 100, invert: 0, grayscale: 0, sepia: 0 } }],
    ["stroke", { intensity: 55, color: "#ffd7b8", thickness: 8, invert: false }],
    ["shadow", { intensity: 55, color: "#101010" }],
    ["bloom", { intensity: 55, color: "#ffd7b8" }],
    ["distort", { intensity: 20, color: "#ffd7b8" }],
    ["eagle", { intensity: 55, color: "#ffd7b8" }],
    ["shake", { intensity: 55, color: "#ffd7b8" }]
  ];
  const effects = {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : definitions.some(([key]) => raw[key]?.enabled),
    stickerEffectsEnabled: raw.stickerEffectsEnabled !== false
  };
  for (const [key, defaults] of definitions) {
    const old = key === "bloom" && !raw.bloom ? raw.glow || {} : raw[key] || {};
    const storedStates = Array.isArray(old.states) ? old.states.map(value => value === "talkingBlink" ? "talking_blink" : value) : states;
    const storedTargets = Array.isArray(old.targets) ? old.targets : ["avatar", "accessories"];
    effects[key] = {
      ...defaults, ...old,
      states: storedStates.includes("all") ? states : storedStates.filter(value => states.includes(value)),
      targets: storedTargets.includes("all") ? ["avatar", "accessories"] : storedTargets.filter(value => ["avatar","accessories"].includes(value))
    };
    if (key === "filter") effects[key].filter = { ...defaults.filter, ...(old.filter || {}) };
  }
  return effects;
}

function renderVisualEffectWorkspace(content) {
  const prefs = profilePreferences;
  const background = { mode: "transparent", ...(prefs.background || {}) };
  const bgGroup = makeSettingsAccordion("Background", "Warna, gradient, gambar, GIF, atau video");
  const modeField = document.createElement("div");
  modeField.className = "setting-field";
  const modeLabel = document.createElement("label");
  modeLabel.textContent = "Background mode";
  const mode = document.createElement("select");
  mode.className = "select-input";
  mode.innerHTML = '<option value="transparent">Transparent</option><option value="solid">Solid color</option><option value="gradient">Gradient</option><option value="image">Image / GIF</option><option value="video">Video</option>';
  mode.value = background.mode;
  const palette = document.createElement("div");
  palette.className = "background-palette";
  const paletteItems = [];
  for (const [key, label, initial] of [["color","Solid",background.color || "#11151b"],["color1","Start",background.color1 || "#254c4a"],["color2","End",background.color2 || "#e2b48c"]]) {
    const item = document.createElement("label");
    item.className = "palette-swatch";
    const input = document.createElement("input");
    input.type = "color"; input.value = initial; input.title = label; input.setAttribute("aria-label", label);
    const caption = document.createElement("small"); caption.textContent = label;
    input.addEventListener("input", () => {
      background[key] = input.value;
      prefs.background = { ...background };
      drawPreview();
    });
    item.append(input, caption);
    palette.append(item);
    paletteItems.push(item);
  }
  const syncPalette = () => {
    palette.hidden = !["solid","gradient"].includes(mode.value);
    paletteItems[0].hidden = mode.value !== "solid";
    paletteItems[1].hidden = mode.value !== "gradient";
    paletteItems[2].hidden = mode.value !== "gradient";
  };
  mode.addEventListener("change", () => {
    background.mode = mode.value;
    prefs.background = { ...background };
    syncPalette();
    drawPreview();
  });
  modeField.append(modeLabel, mode);

  const mediaWrap = document.createElement("div");
  mediaWrap.className = "background-upload-row";
  const mediaInput = document.createElement("input");
  mediaInput.type = "file"; mediaInput.hidden = true;
  mediaInput.accept = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm";
  const mediaButton = document.createElement("button");
  mediaButton.type = "button";
  mediaButton.className = "background-upload-button";
  mediaButton.innerHTML = '<span class="upload-plus">+</span><span>Tambah background</span>';
  mediaButton.addEventListener("click", () => mediaInput.click());
  mediaInput.addEventListener("change", async () => {
    const file = mediaInput.files?.[0]; mediaInput.value = "";
    if (!file) return;
    if (!supabase || !currentUser) return showAppToast("Backend belum siap.", "error");
    const isVideo = file.type.startsWith("video/");
    const allowed = ["image/png","image/jpeg","image/webp","image/gif","video/mp4","video/webm"];
    const limit = isVideo ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
    if (!allowed.includes(file.type) || file.size < 1 || file.size > limit) return showAppToast("Format atau ukuran background tidak didukung.", "error");
    const ext = { "image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif","video/mp4":"mp4","video/webm":"webm" }[file.type];
    const storagePath = `${currentUser.id}/background/${crypto.randomUUID()}.${ext}`;
    try {
      const { error } = await supabase.storage.from("vio-backgrounds").upload(storagePath, file, { upsert: false, contentType: file.type, cacheControl: "3600" });
      if (error) throw error;
      const saved = await api("record_background_asset", { storage_path: storagePath, mime_type: file.type, size_bytes: file.size });
      Object.assign(background, saved.background);
      prefs.background = { ...background };
      mode.value = background.mode;
      drawPreview();
      if (currentRoom) await loadRoomMembers();
      await broadcastMemberAssetsUpdated();
      showAppToast("Background berhasil diunggah");
      renderSettings("effects");
    } catch (error) {
      await supabase.storage.from("vio-backgrounds").remove([storagePath]).catch(() => {});
      showAppToast(`Upload background gagal: ${error.message}`, "error");
    }
  });
  const clearBackground = actionButton("Hapus background tersimpan", async () => {
    try {
      const result = await api("clear_background");
      Object.assign(background, result.background);
      prefs.background = { ...background };
      mode.value = "transparent";
      syncPalette();
      drawPreview();
      showAppToast("Background direset");
      if (currentRoom) await loadRoomMembers();
      await broadcastMemberAssetsUpdated();
    } catch (error) { showAppToast(`Gagal menghapus background: ${error.message}`, "error"); }
  });
  mediaWrap.append(mediaButton, mediaInput, clearBackground);
  bgGroup.body.append(modeField, palette, mediaWrap);
  syncPalette();

  const makeup = makeSettingsAccordion("Makeup", "Pilih efek untuk membuka parameter");
  const effects = buildEffectDefaults(prefs.effects || {});
  const global = document.createElement("label");
  global.className = "check-field";
  const globalToggle = document.createElement("input");
  globalToggle.type = "checkbox"; globalToggle.checked = !!effects.enabled;
  globalToggle.addEventListener("change", () => { effects.enabled = globalToggle.checked; prefs.effects = effects; drawPreview(); });
  global.append(globalToggle, document.createTextNode("Aktifkan Visual Effect +"));
  const accessorySwitch = document.createElement("label");
  accessorySwitch.className = "check-field";
  const accessoryToggle = document.createElement("input");
  accessoryToggle.type = "checkbox"; accessoryToggle.checked = effects.stickerEffectsEnabled;
  accessoryToggle.addEventListener("change", () => { effects.stickerEffectsEnabled = accessoryToggle.checked; prefs.effects = effects; drawPreview(); });
  accessorySwitch.append(accessoryToggle, document.createTextNode("Izinkan efek pada aksesori"));
  const effectDefinitions = [["filter","Filter warna"],["stroke","Stroke"],["shadow","Shadow"],["bloom","Emission / bloom"],["distort","Distorsi"],["eagle","Eagle eye"],["shake","Bergetar"]];
  const buttonGrid = document.createElement("div");
  buttonGrid.className = "makeup-button-grid";
  const parameterPanel = document.createElement("div");
  parameterPanel.className = "makeup-parameter-panel";
  const renderPanel = key => {
    parameterPanel.replaceChildren();
    if (!key) { parameterPanel.hidden = true; return; }
    parameterPanel.hidden = false;
    const effect = effects[key];
    const title = document.createElement("h3");
    title.textContent = effectDefinitions.find(item => item[0] === key)?.[1] || key;
    const active = document.createElement("label");
    active.className = "check-field";
    const enabled = document.createElement("input");
    enabled.type = "checkbox"; enabled.checked = !!effect.enabled;
    enabled.addEventListener("change", () => { effect.enabled = enabled.checked; prefs.effects = effects; drawPreview(); });
    active.append(enabled, document.createTextNode("Aktif"));
    parameterPanel.append(title, active);
    const addRange = (labelText, value, min, max, step, onChange) => {
      const field = document.createElement("label"); field.className = "setting-field";
      const label = document.createElement("span"); label.textContent = `${labelText}: ${value}`;
      const input = document.createElement("input"); input.type = "range"; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
      input.addEventListener("input", () => { const next = Number(input.value); label.textContent = `${labelText}: ${next}`; onChange(next); prefs.effects = effects; drawPreview(); });
      field.append(label, input); parameterPanel.append(field);
    };
    const addCheck = (labelText, value, onChange) => {
      const field = document.createElement("label"); field.className = "check-field";
      const input = document.createElement("input"); input.type = "checkbox"; input.checked = !!value;
      input.addEventListener("change", () => { onChange(input.checked); prefs.effects = effects; drawPreview(); });
      field.append(input, document.createTextNode(labelText)); parameterPanel.append(field);
    };
    addRange("Intensitas", effect.intensity, 0, 100, 1, value => effect.intensity = value);
    if (["stroke","shadow","bloom"].includes(key)) {
      const colorRow = document.createElement("label"); colorRow.className = "setting-field";
      const caption = document.createElement("span"); caption.textContent = "Warna";
      const color = document.createElement("input"); color.type = "color"; color.value = effect.color || "#ffd7b8";
      color.addEventListener("input", () => { effect.color = color.value; prefs.effects = effects; drawPreview(); });
      colorRow.append(caption, color); parameterPanel.append(colorRow);
    }
    if (key === "stroke") {
      addRange("Ketebalan", effect.thickness || 8, 1, 24, 1, value => effect.thickness = value);
      addCheck("Mode invert", effect.invert, value => effect.invert = value);
    }
    if (key === "filter") {
      for (const [prop,label,min,max,step] of [["hue","Hue",-180,180,1],["saturation","Saturation",0,200,1],["brightness","Brightness",0,200,1],["contrast","Contrast",0,200,1],["invert","Invert",0,100,1],["grayscale","Grayscale",0,100,1],["sepia","Sepia",0,100,1]]) {
        addRange(label, effect.filter[prop], min, max, step, value => effect.filter[prop] = value);
      }
    }
    const stateWrap = document.createElement("div"); stateWrap.className = "makeup-chip-list";
    for (const [state,label] of [["idle","Idle"],["talking","Talking"],["blink","Blink"],["talking_blink","Talking + Blink"]]) {
      addCheck(label, effect.states.includes(state), checked => {
        effect.states = checked ? [...new Set([...effect.states,state])] : effect.states.filter(item => item !== state);
      });
    }
    parameterPanel.append(stateWrap);
    const targetWrap = document.createElement("div"); targetWrap.className = "makeup-chip-list";
    for (const [target,label] of [["avatar","Avatar"],["accessories","Aksesori"]]) {
      addCheck(label, effect.targets.includes(target), checked => {
        effect.targets = checked ? [...new Set([...effect.targets,target])] : effect.targets.filter(item => item !== target);
      });
    }
    parameterPanel.append(targetWrap);
  };
  for (const [key,label] of effectDefinitions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "makeup-effect-button";
    button.textContent = label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      const same = activeMakeupEffect === key;
      activeMakeupEffect = same ? null : key;
      for (const candidate of buttonGrid.children) {
        candidate.classList.toggle("active", candidate.dataset.effect === activeMakeupEffect);
        candidate.setAttribute("aria-pressed", String(candidate.dataset.effect === activeMakeupEffect));
      }
      renderPanel(activeMakeupEffect);
    });
    button.dataset.effect = key;
    buttonGrid.append(button);
  }
  const save = actionButton("Simpan Visual Effect +", async () => {
    prefs.effects = effects;
    try {
      await api("profile_save", { display_name: currentUser.display_name || currentUser.username, preferences: prefs });
      await broadcastMemberAssetsUpdated();
      showAppToast("Visual Effect + tersimpan");
    } catch (error) { showAppToast(`Gagal menyimpan efek: ${error.message}`, "error"); }
  }, true);
  makeup.body.append(global, accessorySwitch, buttonGrid, parameterPanel, save);
  content.append(bgGroup.details, makeup.details);
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
    renderCharacterWorkspace(content);
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
    renderVisualEffectWorkspace(content);
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
        if (body?.code) message = `[${body.code}] ${message}`;
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
  // Start capture right after the user completes login; browser permission is still required.
  await startMicrophone({ silent: true });
  await loadCurrentProfile();
  try {
    await refreshCharacterLibrary();
    await loadActiveCharacterAssets();
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
    profilePreferences = { scale: 1, avatarScalePercent: 0, outputWidth: 1080, outputHeight: 1920, sensitivity: 1, boostDb: 6, deviceId: "", ...(result.profile?.preferences || {}) };
    avatarScalePercent = Math.max(-100, Math.min(100, Math.round(Number(profilePreferences.avatarScalePercent) || 0)));
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

function updateMicToggleButtons() {
  const text = micEnabled ? "Mic ON" : "Mic OFF";
  for (const id of ["micToggleButton", "roomMicToggleButton"]) {
    const button = $(id);
    if (!button) continue;
    button.textContent = text;
    button.classList.toggle("is-mic-on", micEnabled);
    button.setAttribute("aria-pressed", String(micEnabled));
  }
}

function updateAvatarScaleWidget() {
  const value = $("avatarScaleValue");
  if (value) value.textContent = `${avatarScalePercent}%`;
  const minus = $("avatarScaleDecrease"), plus = $("avatarScaleIncrease");
  if (minus) minus.disabled = avatarScalePercent <= -100;
  if (plus) plus.disabled = avatarScalePercent >= 100;
}

let avatarScaleSaveTimer = 0;
function changeAvatarScale(delta) {
  avatarScalePercent = Math.max(-100, Math.min(100, avatarScalePercent + delta));
  profilePreferences.avatarScalePercent = avatarScalePercent;
  profilePreferences.scale = Math.max(0, 1 + avatarScalePercent / 100);
  roomOverrides.scale = profilePreferences.scale;
  updateAvatarScaleWidget();
  drawPreview();
  clearTimeout(avatarScaleSaveTimer);
  avatarScaleSaveTimer = setTimeout(async () => {
    if (!currentUser) return;
    try {
      await api("profile_save", { display_name: currentUser.display_name || currentUser.username, preferences: profilePreferences });
      if (currentRoom) {
        await api("set_room_override", { room_id: currentRoom.id, overrides: { scale: roomOverrides.scale } });
        await loadRoomMembers();
        await broadcastMemberAssetsUpdated();
      }
    } catch (error) {
      showAppToast(`Skala avatar gagal disimpan: ${error.message}`, "error");
    }
  }, 320);
}

function showToast(message, type = "success") {
  let toast = $("appToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "appToast";
    toast.className = "app-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.dataset.type = type;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

async function copyText(text) {
  if (!text) throw new Error("Link belum tersedia.");
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Browser tidak mengizinkan penyalinan otomatis.");
}

function syncOverlayGeneratorButtons(label, loading = false, mode = "generate") {
  const buttons = [$("obsLinkButton"), $("roomObsLink"), ...document.querySelectorAll("[data-overlay-generator]")].filter(Boolean);
  for (const button of buttons) {
    button.textContent = label;
    button.disabled = loading;
    button.classList.toggle("is-loading", loading);
    button.dataset.mode = mode;
  }
}

function createOverlayGeneratorButton() {
  const button = actionButton(generatedOverlayUrl ? "Salin Link" : "Generate OBS Link", () => generateOverlayLink(button), true);
  button.dataset.overlayGenerator = "true";
  button.dataset.mode = generatedOverlayUrl ? "copy" : "generate";
  return button;
}

async function startMicrophone(options = {}) {
  const silent = options.silent === true;
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
        micEnabled = status === "active" || status === "requesting" || status === "device-fallback";
        updateMicToggleButtons();
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
    micEnabled = true;
    updateMicToggleButtons();
    $("micStateBadge").textContent = "Mic active";
    await refreshAudioDevices();
  } catch (error) {
    micEnabled = false;
    updateMicToggleButtons();
    $("micStateBadge").textContent = "Mic error";
    showToast(`Mic belum bisa aktif: ${error.message}`, "error");
  }
}

async function stopMicrophone() {
  await audio?.stop();
  micEnabled = false;
  updateMicToggleButtons();
  $("micStateBadge").textContent = "Mic stopped";
  currentMicState = "idle";
  $("expressionState").textContent = "IDLE";
  drawPreview();
  if (roomChannel) await broadcastPlayerState("idle");
}

async function uploadCharacterAccessories(files) {
  if (!files?.length || !supabase || !currentUser) return;
  if (!activeCharacterId) await refreshCharacterLibrary();
  if (!activeCharacterId) throw new Error("Pilih atau buat avatar terlebih dahulu.");
  for (const file of [...files]) {
    if (!/^image\/(png|webp)$/.test(file.type) || file.size < 1 || file.size > 8 * 1024 * 1024) {
      showAppToast(`Aksesori ${file.name} dilewati. Gunakan PNG/WebP maksimal 8 MB.`, "error");
      continue;
    }
    let storagePath = "";
    let recorded = false;
    try {
      const ext = file.type === "image/webp" ? "webp" : "png";
      storagePath = `${currentUser.id}/characters/${activeCharacterId}/accessories/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from("vio-studio-assets").upload(storagePath, file, { upsert: false, contentType: file.type, cacheControl: "3600" });
      if (error) throw error;
      const index = characterAccessories.length + 1;
      await api("record_accessory", { character_id: activeCharacterId, storage_path: storagePath, name: `Aksesori ${index}`, mime_type: file.type, size_bytes: file.size });
      recorded = true;
    } catch (error) {
      if (storagePath && !recorded) {
        const { error: cleanupError } = await supabase.storage.from("vio-studio-assets").remove([storagePath]);
        if (cleanupError) console.warn("Failed accessory upload cleanup:", cleanupError);
      }
      showAppToast(`Upload aksesori ${file.name} gagal: ${error.message}`, "error");
    }
  }
  await loadActiveCharacterAssets();
  renderAccessorySettingsList();
  renderAccessoryQuickScales();
  if (currentRoom) await loadRoomMembers();
  await broadcastMemberAssetsUpdated();
}

function renderAccessorySettingsList() {
  const host = $("accessorySettingsList");
  if (!host) return;
  host.replaceChildren();
  if (!characterAccessories.length) {
    const empty = document.createElement("p");
    empty.className = "muted accessory-empty";
    empty.textContent = "Belum ada aksesori.";
    host.append(empty);
    return;
  }
  characterAccessories.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = `accessory-library-card ${selectedAccessoryId === item.id ? "is-selected" : ""}`;
    card.dataset.accessoryId = item.id;
    const image = document.createElement("img");
    image.src = item.src;
    image.alt = item.name || `Aksesori ${index + 1}`;
    const meta = document.createElement("div");
    meta.className = "accessory-library-meta";
    const name = document.createElement("strong");
    name.textContent = item.name || `Aksesori ${index + 1}`;
    const hint = document.createElement("small");
    hint.textContent = "Geser langsung di jendela preview";
    meta.append(name, hint);
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "icon-button delete-icon-button";
    remove.textContent = "🗑"; remove.title = "Hapus aksesori";
    remove.addEventListener("click", async event => {
      event.stopPropagation(); remove.disabled = true;
      try {
        const deletion = await api("delete_accessory", { accessory_id: item.id });
        characterAccessories = characterAccessories.filter(entry => entry.id !== item.id);
        if (selectedAccessoryId === item.id) selectedAccessoryId = null;
        drawPreview(); renderAccessorySettingsList(); renderAccessoryQuickScales();
        if (deletion.cleanup_pending) showAppToast("File aksesori masih menunggu penghapusan Storage.", "error");
        if (currentRoom) await loadRoomMembers();
        await broadcastMemberAssetsUpdated();
      } catch (error) {
        remove.disabled = false;
        showAppToast(`Gagal menghapus aksesori: ${error.message}`, "error");
      }
    });
    card.addEventListener("click", () => { selectedAccessoryId = item.id; renderAccessorySettingsList(); });
    card.append(image, meta, remove);
    host.append(card);
  });
}

function renderAccessoryQuickScales() {
  const host = $("accessoryScaleControls");
  if (!host) return;
  host.replaceChildren();
  host.hidden = !characterAccessories.length;
  characterAccessories.forEach((item, index) => {
    const row = document.createElement("div"); row.className = "accessory-quick-scale";
    const label = document.createElement("span"); label.textContent = `Aksesori ${index + 1}`;
    const controls = document.createElement("div"); controls.className = "stepper-control";
    const value = document.createElement("strong");
    const read = () => Math.round((Number(item.w || .18) / .18) * 100);
    value.textContent = `${read()}%`;
    const update = async delta => {
      const oldW = Number(item.w || .18), oldH = Number(item.h || .18);
      const ratio = oldH / Math.max(.01, oldW);
      const nextW = Math.max(.04, Math.min(.8, oldW + delta * .009));
      item.w = nextW; item.h = Math.max(.01, Math.min(2, nextW * ratio));
      value.textContent = `${read()}%`;
      drawPreview(); await saveAccessorySettings(item);
    };
    const minus = document.createElement("button"); minus.type = "button"; minus.className = "stepper-button"; minus.textContent = "−";
    minus.addEventListener("click", () => update(-1));
    const plus = document.createElement("button"); plus.type = "button"; plus.className = "stepper-button"; plus.textContent = "+";
    plus.addEventListener("click", () => update(1));
    controls.append(minus, value, plus); row.append(label, controls); host.append(row);
  });
}

async function saveAccessorySettings(item) {
  try {
    await api("update_accessory", {
      accessory_id: item.id, x: item.x, y: item.y, w: item.w, h: item.h,
      mirror: !!item.mirror, follow_avatar: item.follow !== false, effects_enabled: item.effectsEnabled !== false
    });
    if (currentRoom) await loadRoomMembers();
    await broadcastMemberAssetsUpdated();
  } catch (error) { alert(`Pengaturan aksesori gagal disimpan: ${error.message}`); }
}

async function uploadCharacterAsset(state, file) {
  if (!file) return;
  if (!supabase || !currentUser) return showAppToast("Backend belum siap.", "error");
  if (!/^image\/(png|webp)$/.test(file.type)) return showAppToast("Gunakan PNG atau WebP.", "error");
  if (file.size < 1 || file.size > 8 * 1024 * 1024) return showAppToast("Ukuran maksimal file 8 MB.", "error");
  try {
    if (!activeCharacterId) await refreshCharacterLibrary();
    if (!activeCharacterId) {
      const created = await api("create_character_draft");
      activeCharacterId = created.character.id;
    }
    const ext = file.type === "image/webp" ? "webp" : "png";
    const storagePath = `${currentUser.id}/characters/${activeCharacterId}/${state}.${ext}`;
    const { error: uploadError } = await supabase.storage.from("vio-studio-assets").upload(storagePath, file, { upsert: true, contentType: file.type, cacheControl: "3600" });
    if (uploadError) throw uploadError;
    const { data: signed, error: signedError } = await supabase.storage.from("vio-studio-assets").createSignedUrl(storagePath, 3600);
    if (signedError) throw signedError;
    await api("record_asset", { character_id: activeCharacterId, storage_path: storagePath, expression: state, mime_type: file.type, size_bytes: file.size });
    assetUrls[state] = signed.signedUrl;
    drawPreview();
    renderAccessoryQuickScales();
    if (currentRoom) await loadRoomMembers();
    await broadcastMemberAssetsUpdated();
    showAppToast(`${state.replace("_"," ").toUpperCase()} berhasil diunggah`);
  } catch (error) {
    showAppToast(`Upload gagal: ${error.message}`, "error");
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
  if (stageFrame) stageFrame.style.aspectRatio = "4 / 3";
  updateAvatarScaleWidget();
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
  const side = $("sidebar");
  side?.classList.add("is-collapsed");
  const sideButton = $("sidebarToggle");
  if (sideButton) { sideButton.textContent = "›"; sideButton.title = "Expand sidebar"; }
  activeMenu = "collaboration";
  renderNavigation();
  if (currentRoom) {
    $("app").classList.add("in-room");
    showView("collaborationView");
    $("pageTitle").textContent = "GO Collaboration";
    $("roomCodeLabel").textContent = currentRoom.room_code || "----";
    return;
  }
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
  $("sidebar")?.classList.add("is-collapsed");
  if ($("sidebarToggle")) { $("sidebarToggle").textContent = "›"; $("sidebarToggle").title = "Expand sidebar"; }
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
    .on("broadcast", { event: "member-assets-updated" }, ({ payload }) => {
      if (!payload?.user_id || payload.user_id === currentUser.id) return;
      loadRoomMembers().catch(console.warn);
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

async function broadcastMemberAssetsUpdated() {
  if (!roomChannel || !currentRoom) return;
  await roomChannel.send({ type: "broadcast", event: "member-assets-updated", payload: { user_id: currentUser.id, at: Date.now() } });
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
      avatarScalePercent: overrides.scale != null ? undefined : member.preferences?.avatarScalePercent,
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

async function generateOverlayLink(button = null) {
  const sourceButton = button || $("obsLinkButton") || $("roomObsLink");
  if (overlayGenerationBusy) return;
  if (generatedOverlayUrl) {
    try {
      if (sourceButton) { sourceButton.disabled = true; sourceButton.textContent = "Menyalin…"; }
      await copyText(generatedOverlayUrl);
      showToast("Berhasil disalin");
    } catch (error) {
      showToast(`Gagal menyalin link: ${error.message}`, "error");
    } finally {
      syncOverlayGeneratorButtons("Salin Link", false, "copy");
    }
    return;
  }

  overlayGenerationBusy = true;
  syncOverlayGeneratorButtons("Membuat link…", true, "generate");
  try {
    let room = currentRoom;
    if (!room) {
      // Reuse an active room first; this handles stale in-memory state after refresh.
      const active = await api("get_my_active_room");
      room = active.room || null;
    }
    if (!room) {
      try {
        const created = await api("create_room", { capacity: 1, purpose: "personal_overlay" });
        room = created.room;
      } catch (error) {
        if (!String(error?.message || error).includes("ALREADY_IN_ROOM")) throw error;
        const active = await api("get_my_active_room");
        room = active.room || null;
        if (!room) throw new Error("Akun masih tercatat berada di room aktif. Keluar dari room tersebut, lalu coba lagi.");
      }
    }
    if (!room?.id) throw new Error("Room aktif tidak ditemukan.");
    if (!currentRoom) {
      currentRoom = room;
      profilePreferences.lastRoomId = room.id;
      await api("profile_save", { display_name: currentUser.display_name || currentUser.username, preferences: profilePreferences });
      await subscribeRoom(room.id);
      await loadRoomMembers();
    }
    const result = await api("issue_room_overlay", { room_id: room.id });
    const url = new URL("./overlay.html", window.location.href);
    url.hash = new URLSearchParams({ room: result.room_id, token: result.overlay_token }).toString();
    generatedOverlayUrl = url.toString();
    syncOverlayGeneratorButtons("Salin Link", false, "copy");
    showToast("Link berhasil dibuat");
  } catch (error) {
    syncOverlayGeneratorButtons("Generate OBS Link", false, "generate");
    showToast(`OBS Link belum bisa dibuat: ${error.message}`, "error");
  } finally {
    overlayGenerationBusy = false;
  }
}

async function loadAdminOverview() {
  try {
    const result = await api("admin_overview");
    $("adminUserCount").textContent = result.users.length;
    $("adminRoomCount").textContent = result.active_rooms;
    $("adminAssetCount").textContent = result.asset_count;
    const cleanupButton = document.createElement("button");
    cleanupButton.className = "button button-quiet";
    cleanupButton.textContent = `Retry pending Storage cleanup (${result.cleanup_pending_count || 0})`;
    cleanupButton.disabled = !(result.cleanup_pending_count > 0);
    cleanupButton.addEventListener("click", async () => {
      cleanupButton.disabled = true;
      try {
        const retry = await api("admin_retry_storage_cleanup");
        alert(`Storage cleanup: ${retry.processed} object(s) removed, ${retry.pending} still pending.`);
        await loadAdminOverview();
      } catch (error) {
        alert(`Storage cleanup retry failed: ${error.message}`);
        cleanupButton.disabled = false;
      }
    });
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
        const remove = document.createElement("button"); remove.className = "button button-danger"; remove.textContent = "Delete"; remove.addEventListener("click", async () => { if (confirm(`Delete user ${user.username} and their uploaded assets? This cannot be undone.`)) { try { const result = await api("admin_delete_user", { target_user_id: user.id }); if (result.cleanup_pending > 0) alert(`Account deleted. ${result.cleanup_pending} Storage object(s) still need cleanup; use the Admin retry control.`); await loadAdminOverview(); } catch (error) { alert(`User deletion failed: ${error.message}`); } } });
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
    $("adminAuditLog").replaceChildren(auditTitle, cleanupButton, auditTable);
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
      const saved = await api("admin_update_profile", { target_user_id: userId, support_session: activeSupportSession?.token, display_name: $("adminTargetDisplayName").value, preferences });
      alert(saved.cleanup_pending
        ? "Profil diperbarui. File background lama masih menunggu penghapusan Storage; gunakan retry cleanup di Admin."
        : "Profil pengguna diperbarui dan tercatat di Audit Log.");
    }, true);
    const assetsTitle = document.createElement("h3"); assetsTitle.textContent = "Uploaded character assets";
    const assetsList = document.createElement("div"); assetsList.className = "asset-list";
    (detail.assets || []).forEach(asset => {
      const row = document.createElement("div"); row.className = "asset-row";
      const assetLabel = asset.name || asset.expression || asset.asset_type || "Uploaded asset";
      const label = document.createElement("span"); label.textContent = `${assetLabel} · ${asset.mime_type} · ${Math.ceil((Number(asset.size_bytes) || 0) / 1024)} KB`;
      row.append(label);
      if (asset.signed_url) { const link = document.createElement("a"); link.href = asset.signed_url; link.target = "_blank"; link.rel = "noopener"; link.textContent = "Open"; row.append(link); }
      const remove = actionButton("Delete file", async () => {
        if (!confirm(`Delete ${assetLabel} asset for @${detail.user.username}?`)) return;
        try {
          const result = await api("admin_delete_asset", { target_user_id: userId, asset_id: asset.id, asset_type: asset.asset_type || "expression", support_session: activeSupportSession?.token });
          if (result.cleanup_pending) alert("Asset reference removed, but Storage cleanup is still pending. Use the Admin retry control.");
          row.remove();
        } catch (error) { alert(`Asset deletion failed: ${error.message}`); }
      });
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
    const collapsed = side.classList.contains("is-collapsed");
    $("sidebarToggle").textContent = collapsed ? "›" : "‹";
    $("sidebarToggle").title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    $("sidebarToggle").setAttribute("aria-label", $("sidebarToggle").title);
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
    finally {
      // Bootstrap/pairing credentials are one-time secrets. Never leave them
      // visible in the form after either success or failure.
      $("pairingInput").value = "";
      $("loginButton").disabled = false;
    }
  });
  $("logoutButton").addEventListener("click", logout);
  $("topRoomButton").addEventListener("click", openRoomChooser);
  $("exitRoom").addEventListener("click", () => leaveRoom(true));
  $("copyRoomCode").addEventListener("click", async () => { if (currentRoom) await navigator.clipboard.writeText(currentRoom.room_code); });
  $("avatarScaleDecrease").addEventListener("click", () => changeAvatarScale(-5));
  $("avatarScaleIncrease").addEventListener("click", () => changeAvatarScale(5));
  updateAvatarScaleWidget();
  $("obsLinkButton").addEventListener("click", () => generateOverlayLink($("obsLinkButton")));
  $("roomObsLink").addEventListener("click", () => generateOverlayLink($("roomObsLink")));
  $("micToggleButton").addEventListener("click", () => micEnabled ? stopMicrophone() : startMicrophone());
  $("roomMicToggleButton").addEventListener("click", () => micEnabled ? stopMicrophone() : startMicrophone());
  updateMicToggleButtons();
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
