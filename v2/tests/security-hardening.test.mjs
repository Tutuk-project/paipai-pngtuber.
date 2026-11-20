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
