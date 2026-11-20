import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("main and overlay HTML have no duplicate IDs", () => {
  for (const file of ["index.html", "overlay.html"]) {
    const ids = [...read(file).matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicates)], [], `${file} contains duplicate IDs`);
  }
});

test("v2 frontend never contains a Supabase service secret", () => {
  const publicFiles = ["index.html", "overlay.html", "src/app.js", "src/audio-engine.js", "src/overlay.js", "src/config.example.js", "assets/app.css"];
  for (const file of publicFiles) {
    const contents = read(file);
    assert.doesNotMatch(contents, /sb_secret_[A-Za-z0-9_-]{12,}/, `${file} contains a Supabase secret key`);
    assert.doesNotMatch(contents, /eyJ[A-Za-z0-9_-]{25,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, `${file} contains a JWT-like credential`);
  }
});

test("the new migration is additive and defines core v2 tables", () => {
  const sql = read("supabase/migrations/001_vio_studio_v2.sql");
  for (const table of ["vio_app_users", "vio_profiles", "vio_character_assets", "vio_rooms", "vio_room_members", "vio_room_overrides", "vio_support_sessions", "vio_audit_logs"]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\b`, "i"), `missing ${table}`);
  }
  assert.match(sql, /pngtuber-assets.*untouched|leaves all v1\.0 tables/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /ALREADY_IN_ROOM/i);
  assert.match(sql, /vio_rooms_active_code_uq.*where status='active'/i);
});

test("backend includes manual account, room, and audited support actions", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  for (const action of ["bootstrap_admin", "activate_device", "admin_create_user", "admin_update_profile", "admin_delete_asset", "admin_issue_pairing_code", "admin_reset_devices", "admin_update_room", "create_room", "join_room", "issue_room_overlay", "overlay_connect"]) {
    assert.ok(edge.includes(`action === "${action}"`), `missing action ${action}`);
  }
});

test("disabled accounts lose storage/realtime identity access", () => {
  const sql = read("supabase/migrations/001_vio_studio_v2.sql");
  assert.match(sql, /join public\.vio_app_users u on u\.id = d\.app_user_id and u\.is_active/i);
  assert.match(sql, /join public\.vio_app_users u on u\.id=m\.user_id and u\.is_active/i);
  assert.match(sql, /create or replace function public\.vio_is_room_member[\s\S]*?join public\.vio_app_users u on u\.id = d\.app_user_id and u\.is_active/i);
});

test("collaboration has local microphone controls and Admin recent audit viewer", () => {
  const app = read("src/app.js");
  const edge = read("supabase/functions/vio-api/index.ts");
  assert.match(app, /actionButton\("Start microphone", startMicrophone/);
  assert.match(app, /recent_audit/);
  assert.match(edge, /recent_audit: recentAuditQ\.data/);
});

test("audit failures are surfaced instead of silently ignored", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  assert.match(edge, /AUDIT_LOG_WRITE_FAILED/);
});

test("overlay token rotation revokes previously paired overlay devices", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  assert.match(edge, /vio_overlay_devices\"\)\.delete\(\)\.eq\(\"room_id\", roomId\)/);
});

test("closed and expired rooms cannot retain private realtime membership", () => {
  const sql = read("supabase/migrations/001_vio_studio_v2.sql");
  const helper = sql.match(/create or replace function public\.vio_is_room_member[\s\S]*?\$\$;/i)?.[0] || "";
  assert.match(helper, /r\.status = 'active'/i);
  assert.match(helper, /r\.expires_at > now\(\)/i);
});

test("Admin account creation is a single database transaction", () => {
  const sql = read("supabase/migrations/001_vio_studio_v2.sql");
  const edge = read("supabase/functions/vio-api/index.ts");
  assert.match(sql, /create or replace function public\.vio_admin_create_user[\s\S]*?insert into public\.vio_profiles[\s\S]*?insert into public\.vio_pairing_codes[\s\S]*?insert into public\.vio_audit_logs/i);
  assert.match(edge, /rpc\("vio_admin_create_user"/);
  assert.doesNotMatch(edge, /action === "admin_create_user"[\s\S]*?from\("vio_app_users"\)\.insert/);
});


test("collaboration preview and OBS overlay both render per-member accessories", () => {
  const app = read("src/app.js");
  const overlay = read("src/overlay.js");
  assert.ok(app.includes("entry.renderer.setAccessories(member.accessories || [])"));
  assert.ok(app.includes("roomPreviewRenderers.values()"));
  assert.ok(app.includes("function drawRoomStageFrame()"));
  assert.ok(app.includes("requestAnimationFrame(drawRoomStageFrame)"));
  assert.ok(overlay.includes("renderer.setAccessories(member.accessories || [])"));
});

test("accessory upload refreshes the active room snapshot", () => {
  const app = read("src/app.js");
  const start = app.indexOf("async function uploadCharacterAccessories(files)");
  const end = app.indexOf("\nfunction renderAccessorySettingsList()", start);
  const upload = start >= 0 && end > start ? app.slice(start, end) : "";
  assert.ok(upload.includes('api("my_assets")'));
  assert.ok(upload.includes("if (currentRoom) await loadRoomMembers()"));
});

test("modular avatar renderer is wired into editor and OBS overlay", () => {
  const app = read("src/app.js");
  const overlay = read("src/overlay.js");
  const renderer = read("src/avatar-renderer.js");
  assert.match(app, /import \{ AvatarRenderer \} from "\.\/avatar-renderer\.js"/);
  assert.match(overlay, /import \{ AvatarRenderer \} from "\.\/avatar-renderer\.js"/);
  for (const feature of ["drawBackground", "drawAvatar", "drawAccessories", "blinkDelay"]) assert.ok(renderer.includes(feature));
  for (const feature of ["glow", "shadow", "stroke", "filter", "distort"]) assert.ok(renderer.includes(feature));
});

test("live profile and asset updates refresh collaboration members and OBS snapshots", () => {
  const app = read("src/app.js");
  const overlay = read("src/overlay.js");
  assert.ok(app.includes('event: "member-assets-updated"'));
  assert.ok(app.includes("async function broadcastMemberAssetsUpdated()"));
  assert.ok(app.includes("await broadcastMemberAssetsUpdated()"));
  assert.ok(overlay.includes('event: "member-assets-updated"'));
  assert.ok(overlay.includes("refreshMembers().catch"));
  assert.ok(overlay.includes("setInterval(() => refreshMembers()"));
});

test("accessory metadata registration verifies the real storage object", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const record = edge.slice(edge.indexOf('if (action === "record_accessory")'), edge.indexOf('if (action === "update_accessory")'));
  assert.ok(record.includes('.storage.from("vio-studio-assets").list(folderPath'));
  assert.ok(record.includes('file.name === fileName'));
  assert.ok(record.includes("storedSize !== size"));
  assert.ok(record.includes("storedMime !== mime"));
  assert.ok(record.includes("Uploaded accessory object was not found in storage."));
});

test("failed accessory metadata registration removes the uploaded orphan", () => {
  const app = read("src/app.js");
  const uploadStart = app.indexOf("async function uploadCharacterAccessories(files)");
  const uploadEnd = app.indexOf("\nfunction renderAccessorySettingsList()", uploadStart);
  const upload = app.slice(uploadStart, uploadEnd);
  assert.ok(upload.includes("let metadataRecorded = false"));
  assert.ok(upload.includes('await api("record_accessory"'));
  assert.ok(upload.includes("if (storagePath && !metadataRecorded)"));
  assert.ok(upload.includes('.storage.from("vio-studio-assets").remove([storagePath])'));
});

test("accessories can be selected and dragged directly on the avatar canvas", () => {
  const app = read("src/app.js");
  assert.ok(app.includes("function bindAccessoryCanvasDrag(canvas)"));
  assert.ok(app.includes('canvas.addEventListener("pointerdown"'));
  assert.ok(app.includes('canvas.addEventListener("pointermove"'));
  assert.ok(app.includes('canvas.addEventListener("pointerup"'));
  assert.ok(app.includes("accessoryScreenBounds(item, canvas)"));
  assert.ok(app.includes("accessoryDragState.item.x"));
  assert.ok(app.includes("accessoryDragState.item.y"));
  assert.ok(app.includes("await saveAccessorySettings(item)"));
  assert.ok(app.includes("selectedAccessoryId = item.id"));
});

test("accessory deletion queues durable Storage cleanup before deleting metadata", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const migration = read("supabase/migrations/005_vio_storage_cleanup_queue.sql");
  const userDelete = edge.slice(edge.indexOf('if (action === "delete_accessory")'), edge.indexOf('if (action === "issue_room_overlay")'));
  const adminDelete = edge.slice(edge.indexOf('if (action === "admin_delete_asset")'), edge.indexOf('if (action === "my_assets")'));
  assert.ok(migration.includes("create table if not exists public.vio_storage_cleanup_queue"));
  assert.ok(migration.includes("unique (bucket_id, storage_path)"));
  assert.ok(migration.includes("enable row level security"));
  assert.ok(edge.includes("async function enqueueStorageCleanup"));
  assert.ok(edge.includes("async function processStorageCleanup"));
  assert.ok(userDelete.indexOf("enqueueStorageCleanup") < userDelete.indexOf('.delete().eq("id", accessoryId)'));
  assert.ok(userDelete.includes("cleanup_pending: !cleanup.ok"));
  assert.ok(userDelete.includes("Cancelled because accessory metadata deletion failed."));
  assert.ok(adminDelete.includes("admin_support_accessory_delete"));
  assert.ok(adminDelete.includes("Cancelled because accessory metadata deletion failed."));
  assert.ok(edge.includes('action === "admin_retry_storage_cleanup"'));
  assert.ok(edge.includes("limit(25)"));
});

test("Admin dashboard exposes pending Storage cleanup retry", () => {
  const app = read("src/app.js");
  const edge = read("supabase/functions/vio-api/index.ts");
  assert.ok(app.includes("Retry pending Storage cleanup"));
  assert.ok(app.includes('api("admin_retry_storage_cleanup")'));
  assert.ok(app.includes("penghapusan file Storage masih tertunda"));
  assert.ok(edge.includes("cleanup_pending_count: cleanupQ.count || 0"));
});

test("Admin expression deletion and background replacement use durable cleanup", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const app = read("src/app.js");
  const adminDelete = edge.slice(edge.indexOf('if (action === "admin_delete_asset")'), edge.indexOf('if (action === "my_assets")'));
  const background = edge.slice(edge.indexOf('if (action === "record_background_asset")'), edge.indexOf('if (action === "profile_save")'));
  assert.ok(adminDelete.includes('"admin_support_expression_delete"'));
  assert.ok(adminDelete.includes("processStorageCleanup(db, job)"));
  assert.ok(background.includes('"background_replaced"'));
  assert.ok(background.includes("cleanup_pending: cleanupPending"));
  assert.ok(app.includes("file background lama masih menunggu penghapusan Storage"));
  assert.ok(app.includes("Failed to clean up unregistered background upload:"));
});

test("Admin account deletion queues expression, accessory and background objects", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const app = read("src/app.js");
  const deletion = edge.slice(edge.indexOf('if (action === "admin_delete_user")'), edge.indexOf('if (action === "profile_get")'));
  assert.ok(deletion.includes('db.from("vio_character_assets")'));
  assert.ok(deletion.includes('db.from("vio_character_accessories")'));
  assert.ok(deletion.includes('db.from("vio_profiles")'));
  assert.ok(deletion.includes('"admin_user_deletion"'));
  assert.ok(deletion.indexOf("enqueueStorageCleanup") < deletion.indexOf("db.auth.admin.deleteUser"));
  assert.ok(deletion.includes("processStorageCleanup(db, job)"));
  assert.ok(app.includes("Storage object(s) still need cleanup"));
});

test("clearing an uploaded background detaches it before queued Storage cleanup", () => {
  const edge = read("supabase/functions/vio-api/index.ts");
  const app = read("src/app.js");
  const clear = edge.slice(edge.indexOf('if (action === "clear_background")'), edge.indexOf('if (action === "profile_save")'));
  assert.ok(clear.includes('"background_cleared"'));
  assert.ok(clear.indexOf("enqueueStorageCleanup") < clear.indexOf('db.from("vio_profiles").upsert'));
  assert.ok(clear.includes("cancelStorageCleanup"));
  assert.ok(clear.includes("processStorageCleanup(db, job)"));
  assert.ok(clear.includes("mode: \"transparent\""));
  assert.ok(app.includes("Clear uploaded background"));
  assert.ok(app.includes('api("clear_background")'));
  assert.ok(app.includes("Background sudah dilepas dari profil"));
});

test("visual effects UI exposes all seven legacy effects with per-state and per-target controls", () => {
  const app = read("src/app.js");
  const renderer = read("src/avatar-renderer.js");
  for (const label of ["Filter warna", "Stroke", "Shadow", "Emission / bloom", "Distorsi", "Eagle eye", "Bergetar"]) assert.ok(app.includes(label));
  for (const state of ["idle", "talking", "talking_blink"]) assert.ok(app.includes(state));
  assert.ok(app.includes("Ekspresi yang terkena efek"));
  assert.ok(app.includes("Target efek"));
  assert.ok(app.includes("Izinkan efek pada aksesori"));
  assert.ok(renderer.includes("function normalizeEffects"));
  assert.ok(renderer.includes("activeEffects(state, target"));
  assert.ok(renderer.includes('ids.includes("eagle")'));
  assert.ok(renderer.includes('ids.includes("shake")'));
});

test("portrait and custom output resolutions are shared by editor, room and OBS", () => {
  const app = read("src/app.js");
  const overlay = read("src/overlay.js");
  const edge = read("supabase/functions/vio-api/index.ts");
  const renderer = read("src/avatar-renderer.js");
  const index = read("index.html");
  const obs = read("overlay.html");
  assert.ok(app.includes("TikTok Portrait"));
  assert.ok(app.includes("Custom dimensions"));
  assert.ok(app.includes("profilePreferences.outputWidth"));
  assert.ok(app.includes("member.is_host"));
  assert.ok(overlay.includes("member.is_host"));
  assert.ok(overlay.includes("canvas.style.aspectRatio"));
  assert.ok(edge.includes('"outputWidth", "outputHeight"'));
  assert.ok(app.includes("width * height > 8294400"));
  assert.ok(edge.includes("outputWidth * outputHeight > 8294400"));
  assert.ok(edge.includes("member.is_host"));
  assert.ok(renderer.includes("outputWidth: 1080, outputHeight: 1920"));
  assert.ok(index.includes('id="avatarCanvas" width="1080" height="1920"'));
  assert.ok(obs.includes('id="stage" width="1080" height="1920"'));
});

test("private background media upload is owner-scoped and signed for editor, collaboration and OBS", () => {
  const app = read("src/app.js");
  const overlay = read("src/overlay.js");
  const renderer = read("src/avatar-renderer.js");
  const edge = read("supabase/functions/vio-api/index.ts");
  const migration = read("supabase/migrations/004_vio_background_media.sql");
  assert.ok(app.includes('option value="image">Image / GIF'));
  assert.ok(app.includes('option value="video">Video'));
  assert.ok(app.includes('from("vio-backgrounds").upload'));
  assert.ok(app.includes('api("record_background_asset"'));
  assert.ok(edge.includes('action === "record_background_asset"'));
  assert.ok(edge.includes('storage.from("vio-backgrounds").list'));
  assert.ok(edge.includes("signBackground(db"));
  assert.ok(edge.includes("profile: profile ? { ...profile, preferences: await signBackground(db, profile.preferences || {}) }"));
  assert.ok(edge.includes("preferences: await signBackground(db, member.vio_profiles?.preferences || {})"));
  assert.ok(edge.includes('storage.from("vio-backgrounds").list'));
  assert.ok(migration.includes("'image/jpeg'"));
  assert.ok(migration.includes("52428800"));
  assert.ok(migration.includes("'vio-backgrounds'"));
  assert.ok(migration.includes("public = false"));
  assert.ok(renderer.includes("setBackgroundVideo(src)"));
  assert.ok(overlay.includes("renderer.setBackgroundVideo(background.mode === \"video\" ? background.src : null)"));
  assert.ok(app.includes("entry.renderer.setBackgroundImage(background.mode === \"image\" ? background.src : null)"));
});
