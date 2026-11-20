import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("cross-account profile, character, asset and storage access is not granted directly to Admin clients", () => {
  const sql = read("supabase/migrations/002_vio_studio_v2_security_hardening.sql");
  for (const policy of [
    "vio_profiles_update_self",
    "vio_characters_write_self",
    "vio_assets_write_self",
    "vio_storage_read_self",
    "vio_storage_delete_self",
  ]) assert.match(sql, new RegExp("create policy " + policy + "\\b", "i"));
  assert.doesNotMatch(sql, /using\s*\([^)]*vio_is_admin\(\)/i);
  assert.match(sql, /Admin cross-account reads are served by the Edge Function/i);
});

test("private Realtime reads and writes require an active, unexpired room", () => {
  const sql = read("supabase/migrations/002_vio_studio_v2_security_hardening.sql");
  const readPolicy = sql.match(/create policy vio_room_realtime_read[\s\S]*?\);/i)?.[0] || "";
  const writePolicy = sql.match(/create policy vio_room_realtime_write[\s\S]*?\);/i)?.[0] || "";
  for (const policy of [readPolicy, writePolicy]) {
    assert.match(policy, /r\.status='active'/i);
    assert.match(policy, /r\.expires_at > now\(\)/i);
  }
  assert.match(readPolicy, /vio_overlay_devices/i);
});

test("Admin bootstrap is serialized and restricted to a single Admin row", () => {
  const sql = read("supabase/migrations/002_vio_studio_v2_security_hardening.sql");
  assert.match(sql, /create unique index if not exists vio_single_admin_uq[\s\S]*?where role = 'admin'/i);
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('vio_bootstrap_admin'\)\)/i);
});

test("OBS overlay API rejects expired rooms before registering overlay devices", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const handler = edge.match(/if \(action === "overlay_connect"\)[\s\S]*?return json\(\{ ok: true, room:/)?.[0] || "";
  assert.match(handler, /expires_at/);
  assert.match(handler, /getTime\(\) <= Date\.now\(\)/);
  assert.ok(handler.indexOf("expires_at") < handler.indexOf('from("vio_overlay_devices")'));
});


test("character accessories have owner-scoped metadata and cloud lifecycle actions", () => {
  const sql = read("supabase/migrations/003_vio_character_accessories.sql");
  const edge = read("supabase/functions/vio-api/index.ts");
  for (const column of ["storage_path", "mime_type", "size_bytes", "x", "y", "w", "h", "mirror", "follow_avatar", "effects_enabled"]) {
    assert.match(sql, new RegExp("\\b" + column + "\\b"));
  }
  assert.match(sql, /create policy vio_accessories_read_self/i);
  assert.match(sql, /create policy vio_accessories_write_self/i);
  for (const action of ["record_accessory", "update_accessory", "delete_accessory", "my_assets"]) {
    assert.ok(edge.includes('action === "' + action + '"'), "missing accessory action " + action);
  }
  assert.match(edge, /vio_character_accessories/);
});

test("accessories are included in collaboration and OBS snapshots and rendered by the shared avatar renderer", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const app = read("src/app.js");
  const overlay = read("src/overlay.js");
  const renderer = read("src/avatar-renderer.js");
  assert.ok(edge.includes("vio_character_accessories(id,name,storage_path,bucket_id,x,y,w,h,mirror,follow_avatar,effects_enabled,sort_order)"));
  assert.ok(edge.includes("accessories: accessories.filter(Boolean)"));
  assert.ok(app.includes("avatarRenderer.setAccessories(characterAccessories)"));
  assert.ok(overlay.includes("renderer.setAccessories(member.accessories || [])"));
  assert.ok(renderer.includes("item.follow !== false"));
});

test("character library actions exist and expression uploads are bound to an owned character", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  for (const action of ["character_library", "create_character_draft", "save_character", "set_active_character", "delete_character"]) {
    assert.ok(edge.includes('action === "' + action + '"'), "missing character action " + action);
  }
  const record = edge.match(/if \(action === "record_asset"\)[\s\S]*?if \(action === "record_accessory"\)/)?.[0] || "";
  assert.match(record, /body\.character_id/);
  assert.match(record, /eq\("id", characterId\)\.eq\("user_id", user\.id\)/);
  assert.match(record, /expectedPath/);
  assert.doesNotMatch(record, /eq\("name", "Default"\)/);
});

test("my_assets only returns the selected character assets and includes its id", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const handler = edge.match(/if \(action === "my_assets"\)[\s\S]*?if \(action === "get_my_active_room"\)/)?.[0] || "";
  assert.match(handler, /character_id: characterId/);
  assert.match(handler, /eq\("character_id", characterId/);
  assert.match(handler, /active_character_id/);
});

test("accessory upload is scoped to the selected owned character, not a Default name", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const handler = edge.match(/if \(action === "record_accessory"\)[\s\S]*?if \(action === "update_accessory"\)/)?.[0] || "";
  assert.match(handler, /body\.character_id/);
  assert.match(handler, /expectedPrefix/);
  assert.match(handler, /pathParts.length !== 4/);
  assert.match(handler, /eq\("id", characterId\)\.eq\("user_id", user\.id\)/);
  assert.doesNotMatch(handler, /characters\/default|eq\("name", "Default"\)/);
});


test("saved profile audio device is loaded before microphone capture starts", () => {
  const app = read("src/app.js");
  const login = app.match(/currentUser = identity\.user;[\s\S]*?footerSession/)?.[0] || "";
  assert.ok(login.indexOf("await loadCurrentProfile()") >= 0);
  assert.ok(login.indexOf("await startMicrophone({ silent: true })") > login.indexOf("await loadCurrentProfile()"));
});

test("room controls reset from profile defaults before applying room-scoped overrides", () => {
  const app = read("src/app.js");
  const loader = app.match(/async function loadRoomMembers\(\)[\s\S]*?function renderRoomParticipants/)?.[0] || "";
  assert.match(loader, /profileRoomDefaults/);
  assert.match(loader, /roomOverrides = \{ \.\.\.profileRoomDefaults, \.\.\.\(ownMember\?\.overrides \|\| \{\}\) \}/);
  assert.match(loader, /renderRoomControls\(\)/);
  assert.match(loader, /currentDeviceId !== nextDeviceId/);
});

test("new Solo OBS rooms publish the current microphone state after Realtime subscription", () => {
  const app = read("src/app.js");
  const generator = app.match(/async function generateOverlayLink[\s\S]*?async function /)?.[0] || "";
  assert.match(generator, /if \(!micEnabled\) await startMicrophone\(\)/);
  assert.match(generator, /await subscribeRoom\(room\.id\);[\s\S]*?await loadRoomMembers\(\);[\s\S]*?await broadcastPlayerState\(currentMicState\)/);
});

test("collaboration and OBS snapshots pass profile preferences and active-character assets to the shared renderer", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const app = read("src/app.js");
  const overlay = read("src/overlay.js");
  for (const action of ["room_members", "overlay_connect"]) {
    const start = edge.indexOf('if (action === "' + action + '")');
    const next = edge.indexOf('if (action === "', start + 10);
    const handler = start >= 0 ? edge.slice(start, next > start ? next : undefined) : "";
    assert.match(handler, /active_character_id/);
    assert.match(handler, /preferences/);
    assert.match(handler, /vio_character_assets/);
  }
  assert.match(app, /entry\.renderer\.setPreferences\(preferences\)/);
  assert.match(overlay, /renderer\.setPreferences\(preferences\)/);
});


test("legacy global Visual Effect setting enables configured effect objects without per-effect enabled flags", async () => {
  const { normalizeEffects } = await import("../src/avatar-renderer.js");
  const legacy = normalizeEffects({
    enabled: true,
    bloom: { intensity: 55, color: "#ffd7b8" },
    filter: { intensity: 40 },
    shake: { enabled: false, intensity: 20 }
  });
  assert.equal(legacy.enabled, true);
  assert.equal(legacy.bloom.enabled, true);
  assert.equal(legacy.filter.enabled, true);
  assert.equal(legacy.stroke.enabled, false);
  assert.equal(legacy.shake.enabled, false);
  const disabled = normalizeEffects({ enabled: false, bloom: { intensity: 55 } });
  assert.equal(disabled.bloom.enabled, false);
});

test("GO Collaboration opens Host/Join chooser even while a personal Solo OBS room is restored", () => {
  const app = read("src/app.js");
  const chooser = app.match(/function openRoomChooser\(\)[\s\S]*?function showHostForm/)?.[0] || "";
  assert.match(chooser, /currentRoom && currentRoom\.purpose !== "personal_overlay"/);
  assert.match(chooser, /currentRoom\?\.purpose === "personal_overlay"/);
  assert.match(chooser, /hostRoomChoice/);
  assert.match(chooser, /joinRoomChoice/);
});

test("GO Collaboration shared stage uses a dedicated landscape canvas", () => {
  const app = read("src/app.js");
  const stage = app.match(/function renderRoomParticipants\(\)[\s\S]*?function drawRoomStageFrame/)?.[0] || "";
  assert.match(stage, /const width = 1920/);
  assert.match(stage, /const height = 1080/);
  assert.match(stage, /16 \/ 9/);
  const overlay = read("src/overlay.js");
  assert.match(overlay, /isCollaborationRoom\s*=\s*roomPurpose === "collaboration"/);
});

test("room layout sliders update the local member renderer immediately", () => {
  const app = read("src/app.js");
  const controls = app.match(/function renderRoomControls\(\)[\s\S]*?async function subscribeRoom/)?.[0] || "";
  const stage = app.match(/function renderRoomParticipants\(\)[\s\S]*?function drawRoomStageFrame/)?.[0] || "";
  assert.match(controls, /ownMember\.overrides = \{ \.\.\.\(ownMember\.overrides \|\| \{\}\), \[item\.key\]: value \}/);
  assert.match(stage, /member\.user_id === currentUser\.id[\s\S]*?\.\.\.roomOverrides/);
});

test("Solo OBS overlay keeps its canvas clean while starting invisible local mic capture", () => {
  const overlay = read("src/overlay.js");
  const html = read("overlay.html");
  assert.match(overlay, /import \{ AudioEngine \} from "\.\/audio-engine\.js"/);
  assert.match(overlay, /startInvisibleSoloMicrophone/);
  assert.match(overlay, /roomPurpose !== "personal_overlay"/);
  assert.match(overlay, /updateLocalMicState/);
  assert.doesNotMatch(html, /<button\b/i);
  assert.match(html, /<canvas id="stage"/);
});

test("overlay API returns room purpose for Solo or Collaboration rendering", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const start = edge.indexOf('if (action === "overlay_connect")');
  const end = edge.indexOf("return json({ ok: true, room:", start);
  const handler = edge.slice(start, end > start ? end + 120 : undefined);
  assert.match(handler, /select\("id,status,purpose,overlay_token_hash/);
  assert.match(handler, /purpose: room\.purpose/);
});
