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
  assert.match(sql, /Admin cross-account inspection\/mutation must go through the audited Edge Function/i);
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
