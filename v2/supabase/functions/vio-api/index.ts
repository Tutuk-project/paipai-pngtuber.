import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Json = Record<string, unknown>;
type Identity = { authUid: string; id: string; username: string; role: string; is_active: boolean; display_name: string | null };

function json(body: Json, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function getKeys() {
  const publishableSet = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}") as Record<string, string>;
  const secretSet = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}") as Record<string, string>;
  const publishable = publishableSet.default || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const secret = secretSet.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const url = Deno.env.get("SUPABASE_URL") || "";
  if (!url || !publishable || !secret) throw new Error("Supabase environment keys are missing.");
  return { url, publishable, secret };
}

function bytesToHex(bytes: Uint8Array) { return [...bytes].map(value => value.toString(16).padStart(2, "0")).join(""); }
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}
function randomCode(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  return [...values].map(value => alphabet[value % alphabet.length]).join("");
}
function randomRoomCode() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return String(value[0] % 10000).padStart(4, "0");
}

async function audit(db: SupabaseClient, actor: string | null, target: string | null, action: string, details: Json = {}) {
  const { error } = await db.from("vio_audit_logs").insert({ actor_user_id: actor, target_user_id: target, action, details });
  if (error) {
    console.error("Audit log insert failed", error.message);
    throw new Error("AUDIT_LOG_WRITE_FAILED");
  }
}

async function enqueueStorageCleanup(db: SupabaseClient, bucketId: string, storagePath: string, requestedBy: string | null, targetUserId: string | null, reason: string) {
  const { data, error } = await db.from("vio_storage_cleanup_queue").upsert({
    bucket_id: bucketId,
    storage_path: storagePath,
    requested_by: requestedBy,
    target_user_id: targetUserId,
    reason,
    processed_at: null,
    last_error: null
  }, { onConflict: "bucket_id,storage_path" }).select("id,bucket_id,storage_path,attempts").single();
  if (error) throw error;
  return data;
}

async function cancelStorageCleanup(db: SupabaseClient, jobId: string, reason: string) {
  const { error } = await db.from("vio_storage_cleanup_queue").update({
    processed_at: new Date().toISOString(),
    last_error: `Cancelled: ${reason}`.slice(0, 1000)
  }).eq("id", jobId);
  if (error) throw error;
}

async function processStorageCleanup(db: SupabaseClient, job: any) {
  // A failed cancellation must never let the retry worker delete a file that
  // is still referenced by an expression, accessory, or active background.
  let referenced = false;
  if (job.bucket_id === "vio-studio-assets") {
    const [expressionQ, accessoryQ] = await Promise.all([
      db.from("vio_character_assets").select("id").eq("bucket_id", job.bucket_id).eq("storage_path", job.storage_path).limit(1),
      db.from("vio_character_accessories").select("id").eq("bucket_id", job.bucket_id).eq("storage_path", job.storage_path).limit(1)
    ]);
    if (expressionQ.error) throw expressionQ.error;
    if (accessoryQ.error) throw accessoryQ.error;
    referenced = Boolean(expressionQ.data?.length || accessoryQ.data?.length);
  } else if (job.bucket_id === "vio-backgrounds") {
    const { data, error } = await db.from("vio_profiles").select("user_id")
      .contains("preferences", { background: { bucket_id: "vio-backgrounds", storage_path: job.storage_path } })
      .limit(1);
    if (error) throw error;
    referenced = Boolean(data?.length);
  } else {
    throw new Error("STORAGE_CLEANUP_BUCKET_NOT_ALLOWED");
  }

  if (referenced) {
    const { error } = await db.from("vio_storage_cleanup_queue").update({
      processed_at: new Date().toISOString(),
      last_error: "Skipped safely: Storage object is still referenced by profile or asset metadata."
    }).eq("id", job.id);
    if (error) throw error;
    return { ok: true, skipped: true };
  }

  const { error: storageError } = await db.storage.from(job.bucket_id).remove([job.storage_path]);
  const attempts = (Number(job.attempts) || 0) + 1;
  if (storageError) {
    const { error: updateError } = await db.from("vio_storage_cleanup_queue").update({
      attempts,
      last_error: String(storageError.message || storageError).slice(0, 1000)
    }).eq("id", job.id);
    if (updateError) throw updateError;
    return { ok: false, error: storageError.message || "Storage deletion failed." };
  }
  const { error: updateError } = await db.from("vio_storage_cleanup_queue").update({
    attempts,
    last_error: null,
    processed_at: new Date().toISOString()
  }).eq("id", job.id);
  if (updateError) throw updateError;
  return { ok: true };
}

async function signBackground(db: SupabaseClient, preferences: any) {
  const background = preferences?.background;
  if (!background?.storage_path || background.bucket_id !== "vio-backgrounds") return preferences || {};
  const { data, error } = await db.storage.from(background.bucket_id).createSignedUrl(background.storage_path, 3600);
  if (error || !data?.signedUrl) return preferences || {};
  return { ...preferences, background: { ...background, src: data.signedUrl } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    const { url, publishable, secret } = getKeys();
    const authorization = req.headers.get("Authorization") || "";
    const jwt = authorization.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ ok: false, error: "A Supabase Auth session is required." }, 401);

    const verifier = createClient(url, publishable, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await verifier.auth.getUser();
    if (authError || !authData.user) return json({ ok: false, error: "Invalid or expired session." }, 401);
    const authUser = authData.user;
    const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json().catch(() => ({})) as Json;
    const action = String(body.action || "");

    const getIdentity = async (): Promise<Identity | null> => {
      const { data, error } = await db.from("vio_user_devices")
        .select("app_user_id, vio_app_users!inner(id,username,role,is_active,display_name)")
        .eq("auth_user_id", authUser.id).maybeSingle();
      if (error || !data) return null;
      const user = (data as any).vio_app_users;
      if (!user?.is_active) return null;
      await db.from("vio_user_devices").update({ last_seen_at: new Date().toISOString() }).eq("auth_user_id", authUser.id);
      await db.from("vio_app_users").update({ last_seen_at: new Date().toISOString() }).eq("id", user.id);
      return { authUid: authUser.id, id: user.id, username: user.username, role: user.role, is_active: user.is_active, display_name: user.display_name };
    };
    const identity = await getIdentity();
    const requireUser = () => {
      if (!identity) throw new Error("DEVICE_NOT_PAIRED");
      return identity;
    };
    const requireAdmin = () => {
      const user = requireUser();
      if (user.role !== "admin") throw new Error("ADMIN_ONLY");
      return user;
    };

    if (action === "bootstrap_admin") {
      if (!authUser.is_anonymous) return json({ ok: false, error: "Bootstrap only accepts a fresh anonymous device session." }, 403);
      const username = String(body.username || "").trim().toLowerCase();
      const supplied = String(body.bootstrap_token || "");
      const expected = Deno.env.get("VIO_ADMIN_BOOTSTRAP_TOKEN") || "";
      if (username !== "paipai77" || !expected || supplied.length < 20 || supplied !== expected) return json({ ok: false, error: "Admin bootstrap authorization failed." }, 403);
      const { data, error } = await db.rpc("vio_bootstrap_admin", { p_auth_uid: authUser.id, p_username: username });
      if (error) throw error;
      await audit(db, data.id, data.id, "bootstrap_admin", { username });
      return json({ ok: true, user: data, note: "Remove VIO_ADMIN_BOOTSTRAP_TOKEN from function secrets after the first successful bootstrap." });
    }

    if (action === "activate_device") {
      if (!authUser.is_anonymous) return json({ ok: false, error: "Device pairing expects an anonymous Supabase session." }, 403);
      const username = String(body.username || "").trim().toLowerCase();
      const pairingCode = String(body.pairing_code || "").trim().toUpperCase();
      if (!/^[a-z0-9_]{3,24}$/.test(username) || pairingCode.length < 8) return json({ ok: false, error: "Username or pairing code is invalid." }, 400);
      const { data, error } = await db.rpc("vio_activate_device", { p_auth_uid: authUser.id, p_username: username, p_code_hash: await sha256(pairingCode) });
      if (error) throw error;
      await audit(db, data.id, data.id, "device_paired", { auth_uid: authUser.id });
      return json({ ok: true, user: data });
    }

    if (action === "me") {
      const user = requireUser();
      return json({ ok: true, user });
    }

    if (action === "admin_create_user") {
      const admin = requireAdmin();
      const username = String(body.username || "").trim().toLowerCase();
      const role = String(body.role || "user").toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(username)) return json({ ok: false, error: "Username must be 3–24 chars using letters, numbers or underscore." }, 400);
      if (!["user", "tester"].includes(role)) return json({ ok: false, error: "New accounts can only be User or Tester." }, 400);
      const pairingCode = randomCode(12);
      const { data: created, error: createError } = await db.rpc("vio_admin_create_user", {
        p_username: username, p_role: role, p_created_by: admin.id, p_code_hash: await sha256(pairingCode),
      });
      if (createError) throw createError;
      return json({ ok: true, user: created, pairing_code: pairingCode, expires_in_hours: 72 });
    }

    if (action === "admin_overview") {
      const admin = requireAdmin();
      // Expire stale active rooms before reporting live/inactive status to Admin.
      const { error: expiryError } = await db.from("vio_rooms").update({ status: "expired", closed_at: new Date().toISOString() }).eq("status", "active").lte("expires_at", new Date().toISOString());
      if (expiryError) throw expiryError;
      const [usersQ, roomsQ, assetsQ, auditQ, recentAuditQ, cleanupQ] = await Promise.all([
        db.from("vio_app_users").select("id,username,role,is_active,created_at,last_seen_at").order("created_at", { ascending: false }),
        db.from("vio_rooms").select("id,room_code,capacity,status,host_user_id,expires_at, vio_app_users!vio_rooms_host_user_id_fkey(username), vio_room_members(count)").order("created_at", { ascending: false }).limit(100),
        db.from("vio_character_assets").select("id", { count: "exact", head: true }),
        db.from("vio_audit_logs").select("id", { count: "exact", head: true }),
        db.from("vio_audit_logs").select("id,actor_user_id,target_user_id,action,details,created_at").order("created_at", { ascending: false }).limit(40),
        db.from("vio_storage_cleanup_queue").select("id", { count: "exact", head: true }).is("processed_at", null),
      ]);
      if (usersQ.error) throw usersQ.error;
      if (roomsQ.error) throw roomsQ.error;
      if (recentAuditQ.error) throw recentAuditQ.error;
      if (cleanupQ.error) throw cleanupQ.error;
      const rooms = (roomsQ.data || []).map((room: any) => ({
        id: room.id, room_code: room.room_code, capacity: room.capacity, status: room.status,
        host_username: room.vio_app_users?.username || "Unknown", member_count: room.vio_room_members?.[0]?.count || 0,
      }));
      await audit(db, admin.id, null, "admin_overview_viewed", {});
      return json({ ok: true, users: usersQ.data || [], rooms, active_rooms: rooms.filter((room: any) => room.status === "active").length, asset_count: assetsQ.count || 0, audit_count: auditQ.count || 0, cleanup_pending_count: cleanupQ.count || 0, recent_audit: recentAuditQ.data || [] });
    }

    if (action === "admin_retry_storage_cleanup") {
      const admin = requireAdmin();
      const { data: jobs, error } = await db.from("vio_storage_cleanup_queue").select("id,bucket_id,storage_path,attempts").is("processed_at", null).order("created_at").limit(25);
      if (error) throw error;
      let processed = 0;
      let pending = 0;
      for (const job of jobs || []) {
        try {
          const result = await processStorageCleanup(db, job);
          if (result.ok) processed++;
          else pending++;
        } catch (cleanupError) {
          pending++;
          console.error("Storage cleanup retry failed", job.id, cleanupError);
        }
      }
      await audit(db, admin.id, null, "admin_storage_cleanup_retried", { processed, pending, scanned: (jobs || []).length });
      return json({ ok: true, processed, pending, scanned: (jobs || []).length });
    }

    if (action === "admin_reset_devices") {
      const admin = requireAdmin();
      const targetId = String(body.target_user_id || "");
      const { data: target, error: targetError } = await db.from("vio_app_users").select("id,username,role,is_active").eq("id", targetId).single();
      if (targetError) throw targetError;
      if (target.username === "paipai77" || target.role === "admin") return json({ ok: false, error: "The root Admin account is protected." }, 403);
      const { data: devices, error: devicesError } = await db.from("vio_user_devices").select("auth_user_id").eq("app_user_id", targetId);
      if (devicesError) throw devicesError;
      for (const device of devices || []) {
        const { error } = await db.auth.admin.deleteUser(device.auth_user_id);
        if (error) throw new Error(`DEVICE_SESSION_REVOCATION_FAILED: ${error.message}`);
      }
      const { error: revokeCodeError } = await db.from("vio_pairing_codes").update({ used_at: new Date().toISOString() }).eq("app_user_id", targetId).is("used_at", null);
      if (revokeCodeError) throw revokeCodeError;
      const pairingCode = randomCode(12);
      const { error: pairingError } = await db.from("vio_pairing_codes").insert({ app_user_id: targetId, code_hash: await sha256(pairingCode), expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(), created_by: admin.id });
      if (pairingError) throw pairingError;
      await audit(db, admin.id, targetId, "user_devices_reset", { revoked_devices: devices?.length || 0 });
      return json({ ok: true, pairing_code: pairingCode, revoked_devices: devices?.length || 0, expires_in_hours: 72 });
    }

    if (action === "admin_issue_pairing_code") {
      const admin = requireAdmin();
      const targetId = String(body.target_user_id || "");
      const { data: target, error } = await db.from("vio_app_users").select("id,username,role,is_active").eq("id", targetId).single();
      if (error) throw error;
      const isRootSelf = target.username === "paipai77" && target.role === "admin" && target.id === admin.id;
      if (!target.is_active || (target.role === "admin" && !isRootSelf)) return json({ ok: false, error: "Pairing code can only be issued to active User/Tester accounts or the signed-in root Admin." }, 403);
      const { error: revokeCodeError } = await db.from("vio_pairing_codes").update({ used_at: new Date().toISOString() }).eq("app_user_id", targetId).is("used_at", null);
      if (revokeCodeError) throw revokeCodeError;
      const pairingCode = randomCode(12);
      const { error: pairingError } = await db.from("vio_pairing_codes").insert({ app_user_id: targetId, code_hash: await sha256(pairingCode), expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(), created_by: admin.id });
      if (pairingError) throw pairingError;
      await audit(db, admin.id, targetId, "device_pairing_code_issued", { expires_in_hours: 72 });
      return json({ ok: true, pairing_code: pairingCode, expires_in_hours: 72 });
    }

    if (action === "admin_set_role") {
      const admin = requireAdmin();
      const targetId = String(body.target_user_id || "");
      const role = String(body.role || "");
      if (!["user", "tester"].includes(role)) return json({ ok: false, error: "The root Admin role cannot be assigned or modified here." }, 400);
      const { data: target, error } = await db.from("vio_app_users").select("id,username,role").eq("id", targetId).single();
      if (error) throw error;
      if (target.username === "paipai77" || target.role === "admin") return json({ ok: false, error: "The root Admin account is protected." }, 403);
      const { error: updateError } = await db.from("vio_app_users").update({ role }).eq("id", targetId);
      if (updateError) throw updateError;
      await audit(db, admin.id, targetId, "role_changed", { role });
      return json({ ok: true });
    }

    if (action === "admin_disable_user") {
      const admin = requireAdmin();
      const targetId = String(body.target_user_id || "");
      const { data: target, error } = await db.from("vio_app_users").select("id,username,role").eq("id", targetId).single();
      if (error) throw error;
      if (target.username === "paipai77" || target.role === "admin") return json({ ok: false, error: "The root Admin account cannot be disabled from the dashboard." }, 403);
      const isActive = body.is_active === true;
      const { error: updateError } = await db.from("vio_app_users").update({ is_active: isActive }).eq("id", targetId);
      if (updateError) throw updateError;
      if (!isActive) {
        // Revoke any outstanding support-view token immediately when its target is disabled.
        const { error: supportRevokeError } = await db.from("vio_support_sessions").update({ ended_at: new Date().toISOString() }).eq("target_user_id", targetId).is("ended_at", null);
        if (supportRevokeError) throw supportRevokeError;
        // Remove disabled accounts from active rooms immediately. If the disabled
        // account is host, close the room rather than leaving an orphaned session.
        const { data: memberships, error: memberError } = await db.from("vio_room_members").select("room_id,is_host").eq("user_id", targetId);
        if (memberError) throw memberError;
        for (const membership of memberships || []) {
          // Revoke any previously generated OBS room token as part of account disable.
          const { error: tokenError } = await db.from("vio_rooms").update({ overlay_token_hash: null }).eq("id", membership.room_id);
          if (tokenError) throw tokenError;
          const { error: overlayError } = await db.from("vio_overlay_devices").delete().eq("room_id", membership.room_id);
          if (overlayError) throw overlayError;
          if (membership.is_host) {
            const { error: roomError } = await db.from("vio_rooms").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", membership.room_id);
            if (roomError) throw roomError;
            const { error: memberError } = await db.from("vio_room_members").delete().eq("room_id", membership.room_id);
            if (memberError) throw memberError;
          } else {
            const { error: memberError } = await db.from("vio_room_members").delete().eq("room_id", membership.room_id).eq("user_id", targetId);
            if (memberError) throw memberError;
          }
        }
      }
      await audit(db, admin.id, targetId, isActive ? "user_enabled" : "user_disabled", {});
      return json({ ok: true });
    }

    if (action === "admin_impersonation_start") {
      const admin = requireAdmin();
      const targetId = String(body.target_user_id || "");
      const reason = String(body.reason || "Support / user troubleshooting").slice(0, 200);
      const { data: target, error } = await db.from("vio_app_users").select("id,username,role,is_active").eq("id", targetId).single();
      if (error) throw error;
      if (!target.is_active || target.role === "admin" || target.username === "paipai77") return json({ ok: false, error: "Support View is only available for active non-admin accounts." }, 403);
      const token = randomCode(32);
      const { error: sessionError } = await db.from("vio_support_sessions").insert({ token_hash: await sha256(token), admin_user_id: admin.id, target_user_id: targetId, reason, expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
      if (sessionError) throw sessionError;
      await audit(db, admin.id, targetId, "support_session_started", { reason, expires_minutes: 15 });
      return json({ ok: true, target, support_session: token, expires_in_minutes: 15 });
    }

    if (action === "admin_user_detail") {
      const admin = requireAdmin();
      const targetId = String(body.target_user_id || "");
      const supportToken = String(body.support_session || "");
      const { data: session, error: sessionError } = await db.from("vio_support_sessions").select("id,target_user_id,expires_at,ended_at").eq("admin_user_id", admin.id).eq("target_user_id", targetId).eq("token_hash", await sha256(supportToken)).is("ended_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (sessionError || !session) return json({ ok: false, error: "Support session is invalid or expired." }, 403);
      const { data: target, error } = await db.from("vio_app_users").select("id,username,role,is_active,created_at,last_seen_at,vio_profiles(*),vio_characters(*,vio_character_assets(*),vio_character_accessories(*))").eq("id", targetId).single();
      if (error) throw error;
      if (!target.is_active || target.role === "admin") return json({ ok: false, error: "Support View target is no longer eligible." }, 403);
      const { data: assetRows, error: assetError } = await db.from("vio_character_assets").select("id,character_id,expression,bucket_id,storage_path,mime_type,size_bytes,updated_at").eq("user_id", targetId);
      if (assetError) throw assetError;
      const { data: accessoryRows, error: accessoryError } = await db.from("vio_character_accessories").select("id,character_id,name,bucket_id,storage_path,mime_type,size_bytes,updated_at").eq("user_id", targetId);
      if (accessoryError) throw accessoryError;
      const { data: profileRow, error: profileRowError } = await db.from("vio_profiles").select("active_character_id,preferences").eq("user_id", targetId).maybeSingle();
      if (profileRowError) throw profileRowError;
      const expressionAssets = await Promise.all((assetRows || []).map(async (asset: any) => {
        const { data: signed, error: signedError } = await db.storage.from(asset.bucket_id).createSignedUrl(asset.storage_path, 900);
        return { ...asset, asset_type: "expression", signed_url: signedError ? null : signed?.signedUrl || null };
      }));
      const accessoryAssets = await Promise.all((accessoryRows || []).map(async (asset: any) => {
        const { data: signed, error: signedError } = await db.storage.from(asset.bucket_id).createSignedUrl(asset.storage_path, 900);
        return { ...asset, expression: asset.name, asset_type: "accessory", signed_url: signedError ? null : signed?.signedUrl || null };
      }));
      const background = (profileRow?.preferences as any)?.background;
      const backgroundAssets = [];
      if (background?.storage_path && background.bucket_id === "vio-backgrounds") {
        const { data: signed, error: signedError } = await db.storage.from("vio-backgrounds").createSignedUrl(background.storage_path, 900);
        backgroundAssets.push({
          id: background.storage_path, name: "Background", expression: "Background", asset_type: "background",
          bucket_id: "vio-backgrounds", storage_path: background.storage_path, mime_type: background.mime_type || "unknown",
          size_bytes: Number(background.size_bytes) || 0, signed_url: signedError ? null : signed?.signedUrl || null
        });
      }
      const assets = [...expressionAssets, ...accessoryAssets, ...backgroundAssets];
      await audit(db, admin.id, targetId, "support_user_detail_viewed", { support_session_id: session.id });
      return json({ ok: true, user: target, assets, support_mode: true, support_expires_at: session.expires_at });
    }

    if (action === "admin_impersonation_end") {
      const admin = requireAdmin();
      const supportToken = String(body.support_session || "");
      const { data: session, error } = await db.from("vio_support_sessions").select("id,target_user_id").eq("admin_user_id", admin.id).eq("token_hash", await sha256(supportToken)).is("ended_at", null).maybeSingle();
      if (error) throw error;
      if (!session) return json({ ok: false, error: "Support session not found or already ended." }, 404);
      const { error: endError } = await db.from("vio_support_sessions").update({ ended_at: new Date().toISOString() }).eq("id", session.id);
      if (endError) throw endError;
      await audit(db, admin.id, session.target_user_id, "support_session_ended", { support_session_id: session.id });
      return json({ ok: true });
    }

    if (action === "admin_update_room") {
      const admin = requireAdmin();
      const roomId = String(body.room_id || "");
      const updates: Record<string, unknown> = {};
      if (body.capacity !== undefined) {
        const capacity = Number(body.capacity);
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4) return json({ ok: false, error: "Room capacity must be between 1 and 4." }, 400);
        const { count, error: countError } = await db.from("vio_room_members").select("user_id", { count: "exact", head: true }).eq("room_id", roomId);
        if (countError) throw countError;
        if ((count || 0) > capacity) return json({ ok: false, error: "Capacity cannot be lower than the current number of members." }, 409);
        updates.capacity = capacity;
      }
      if (body.room_code !== undefined) {
        const code = String(body.room_code || "").trim();
        if (!/^\d{4}$/.test(code)) return json({ ok: false, error: "Room code must contain exactly four digits." }, 400);
        updates.room_code = code;
      }
      if (!Object.keys(updates).length) return json({ ok: false, error: "No room changes supplied." }, 400);
      const { error } = await db.from("vio_rooms").update(updates).eq("id", roomId);
      if (error) throw error;
      await audit(db, admin.id, null, "admin_updated_room", { room_id: roomId, changes: updates });
      return json({ ok: true });
    }

    if (action === "admin_close_room") {
      const admin = requireAdmin();
      const roomId = String(body.room_id || "");
      const { error } = await db.from("vio_rooms").update({ status: "closed", closed_at: new Date().toISOString(), overlay_token_hash: null }).eq("id", roomId);
      if (error) throw error;
      const { error: overlayError } = await db.from("vio_overlay_devices").delete().eq("room_id", roomId);
      if (overlayError) throw overlayError;
      const { error: memberError } = await db.from("vio_room_members").delete().eq("room_id", roomId);
      if (memberError) throw memberError;
      await audit(db, admin.id, null, "admin_closed_room", { room_id: roomId });
      return json({ ok: true });
    }

    if (action === "admin_delete_user") {
      const admin = requireAdmin();
      const targetId = String(body.target_user_id || "");
      const { data: target, error: targetError } = await db.from("vio_app_users").select("id,username,role").eq("id", targetId).single();
      if (targetError) throw targetError;
      if (target.username === "paipai77" || target.role === "admin") return json({ ok: false, error: "The root Admin account is protected." }, 403);
      const [assetsQ, accessoriesQ, profileQ] = await Promise.all([
        db.from("vio_character_assets").select("bucket_id,storage_path").eq("user_id", targetId),
        db.from("vio_character_accessories").select("bucket_id,storage_path").eq("user_id", targetId),
        db.from("vio_profiles").select("preferences").eq("user_id", targetId).maybeSingle()
      ]);
      if (assetsQ.error) throw assetsQ.error;
      if (accessoriesQ.error) throw accessoriesQ.error;
      if (profileQ.error) throw profileQ.error;
      const background = (profileQ.data?.preferences as any)?.background;
      const allStoredAssets = [...(assetsQ.data || []), ...(accessoriesQ.data || [])];
      if (background?.storage_path && background.bucket_id === "vio-backgrounds") allStoredAssets.push({ bucket_id: background.bucket_id, storage_path: background.storage_path });
      const uniqueAssets = [...new Map(allStoredAssets.map((asset: any) => [`${asset.bucket_id}:${asset.storage_path}`, asset])).values()];
      const cleanupJobs = [];
      for (const asset of uniqueAssets) {
        cleanupJobs.push(await enqueueStorageCleanup(db, asset.bucket_id, asset.storage_path, admin.id, targetId, "admin_user_deletion"));
      }
      const cancelDeletionJobs = async (reason: string) => {
        for (const job of cleanupJobs) await cancelStorageCleanup(db, job.id, reason);
      };
      const { data: devices, error: devicesError } = await db.from("vio_user_devices").select("auth_user_id").eq("app_user_id", targetId);
      if (devicesError) {
        await cancelDeletionJobs("device lookup failed before account deletion");
        throw devicesError;
      }

      // Disable first. If any later Auth deletion fails partway through, every
      // remaining device is denied by getIdentity() and vio_current_app_user_id().
      const { error: disableError } = await db.from("vio_app_users").update({ is_active: false }).eq("id", targetId);
      if (disableError) {
        await cancelDeletionJobs("account could not be disabled before deletion");
        throw disableError;
      }
      const { error: supportError } = await db.from("vio_support_sessions")
        .update({ ended_at: new Date().toISOString() }).eq("target_user_id", targetId).is("ended_at", null);
      if (supportError) {
        await cancelDeletionJobs("support sessions could not be revoked before deletion");
        throw supportError;
      }

      // Close rooms hosted by the account and remove its membership elsewhere.
      // This also revokes overlay devices so a failed Auth cleanup cannot leave
      // an active OBS renderer attached to a disabled account's room.
      const { data: memberships, error: membershipsError } = await db.from("vio_room_members")
        .select("room_id,is_host").eq("user_id", targetId);
      if (membershipsError) {
        await cancelDeletionJobs("room membership lookup failed before account deletion");
        throw membershipsError;
      }
      for (const membership of memberships || []) {
        const { error: tokenError } = await db.from("vio_rooms").update({ overlay_token_hash: null }).eq("id", membership.room_id);
        if (tokenError) {
          await cancelDeletionJobs("room overlay revocation failed before account deletion");
          throw tokenError;
        }
        const { error: overlayError } = await db.from("vio_overlay_devices").delete().eq("room_id", membership.room_id);
        if (overlayError) {
          await cancelDeletionJobs("overlay device revocation failed before account deletion");
          throw overlayError;
        }
        if (membership.is_host) {
          const { error: roomError } = await db.from("vio_rooms").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", membership.room_id);
          if (roomError) {
            await cancelDeletionJobs("host room closure failed before account deletion");
            throw roomError;
          }
          const { error: memberError } = await db.from("vio_room_members").delete().eq("room_id", membership.room_id);
          if (memberError) {
            await cancelDeletionJobs("host room membership cleanup failed before account deletion");
            throw memberError;
          }
        } else {
          const { error: memberError } = await db.from("vio_room_members").delete().eq("room_id", membership.room_id).eq("user_id", targetId);
          if (memberError) {
            await cancelDeletionJobs("room membership cleanup failed before account deletion");
            throw memberError;
          }
        }
      }

      try {
        await audit(db, admin.id, targetId, "user_deletion_started", {
          username: target.username, linked_devices: devices?.length || 0,
          storage_objects: cleanupJobs.length, account_disabled_before_revocation: true
        });
      } catch (auditError) {
        await cancelDeletionJobs("deletion start audit failed; account remains disabled");
        throw auditError;
      }

      try {
        for (const device of devices || []) {
          const { error } = await db.auth.admin.deleteUser(device.auth_user_id);
          if (error) throw new Error(`AUTH_USER_CLEANUP_FAILED: ${error.message}`);
        }
        const { error } = await db.from("vio_app_users").delete().eq("id", targetId);
        if (error) throw error;
      } catch (deleteError) {
        await cancelDeletionJobs("account deletion did not complete; account remains disabled");
        throw deleteError;
      }
      let cleanupPending = 0;
      for (const job of cleanupJobs) {
        const cleanup = await processStorageCleanup(db, job);
        if (!cleanup.ok) cleanupPending++;
      }
      await audit(db, admin.id, null, "user_deletion_completed", { username: target.username, storage_objects: cleanupJobs.length, cleanup_pending: cleanupPending });
      return json({ ok: true, cleanup_pending: cleanupPending });
    }

    if (action === "profile_get") {
      const user = requireUser();
      const [{ data: account, error: accountError }, { data: profile, error: profileError }] = await Promise.all([
        db.from("vio_app_users").select("id,username,role,display_name").eq("id", user.id).single(),
        db.from("vio_profiles").select("preferences,active_character_id,updated_at").eq("user_id", user.id).maybeSingle(),
      ]);
      if (accountError) throw accountError;
      if (profileError) throw profileError;
      return json({ ok: true, account, profile: profile ? { ...profile, preferences: await signBackground(db, profile.preferences || {}) } : { preferences: {}, active_character_id: null } });
    }

    if (action === "record_background_asset") {
      const user = requireUser();
      const storagePath = String(body.storage_path || "");
      const mime = String(body.mime_type || "");
      const size = Number(body.size_bytes);
      const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"];
      const isVideo = mime.startsWith("video/");
      const maxBytes = isVideo ? 52428800 : 20971520;
      const prefix = `${user.id}/background/`;
      const parts = storagePath.split("/");
      if (!storagePath.startsWith(prefix) || parts.length !== 3 || parts.some(part => !part || part === "." || part === "..") || !allowed.includes(mime) || !Number.isSafeInteger(size) || size < 1 || size > maxBytes) return json({ ok: false, error: "Background asset metadata is invalid." }, 400);
      const fileName = parts[2];
      const { data: objects, error: listError } = await db.storage.from("vio-backgrounds").list(`${user.id}/background`, { search: fileName, limit: 100 });
      if (listError) throw listError;
      const stored = (objects || []).find((item: any) => item.name === fileName);
      if (!stored || Number(stored.metadata?.size || 0) !== size || (stored.metadata?.mimetype && stored.metadata.mimetype !== mime)) return json({ ok: false, error: "Uploaded background object does not match its metadata." }, 400);
      const { data: profile, error: profileError } = await db.from("vio_profiles").select("preferences").eq("user_id", user.id).maybeSingle();
      if (profileError) throw profileError;
      const previous = (profile?.preferences as any)?.background;
      const background = { ...(previous || {}), mode: isVideo ? "video" : "image", bucket_id: "vio-backgrounds", storage_path: storagePath, mime_type: mime, size_bytes: size };
      const preferences = { ...(profile?.preferences || {}), background };
      const oldJob = previous?.storage_path && previous.storage_path !== storagePath
        ? await enqueueStorageCleanup(db, previous.bucket_id || "vio-backgrounds", previous.storage_path, user.id, user.id, "background_replaced")
        : null;
      const { error: saveError } = await db.from("vio_profiles").upsert({ user_id: user.id, preferences, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (saveError) {
        if (oldJob) await cancelStorageCleanup(db, oldJob.id, "background replacement profile save failed");
        throw saveError;
      }
      let cleanupPending = false;
      if (oldJob) {
        const cleanup = await processStorageCleanup(db, oldJob);
        cleanupPending = !cleanup.ok;
      }
      const { data: signed, error: signError } = await db.storage.from("vio-backgrounds").createSignedUrl(storagePath, 3600);
      if (signError) throw signError;
      await audit(db, user.id, user.id, "background_asset_updated", { mime_type: mime, size_bytes: size, cleanup_pending: cleanupPending });
      return json({ ok: true, cleanup_pending: cleanupPending, background: { ...background, src: signed.signedUrl } });
    }

    if (action === "clear_background") {
      const user = requireUser();
      const { data: profile, error: profileError } = await db.from("vio_profiles").select("preferences").eq("user_id", user.id).maybeSingle();
      if (profileError) throw profileError;
      const preferences = { ...((profile?.preferences || {}) as Record<string, any>) };
      const previous = preferences.background || {};
      let job: any = null;
      if (previous.storage_path && previous.bucket_id === "vio-backgrounds") {
        job = await enqueueStorageCleanup(db, previous.bucket_id, previous.storage_path, user.id, user.id, "background_cleared");
      }
      const background = { ...previous, mode: "transparent" };
      delete background.src;
      delete background.storage_path;
      delete background.bucket_id;
      delete background.mime_type;
      preferences.background = background;
      const { error: saveError } = await db.from("vio_profiles").upsert({ user_id: user.id, preferences, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (saveError) {
        if (job) await cancelStorageCleanup(db, job.id, "profile background clear did not save");
        throw saveError;
      }
      let cleanupPending = false;
      if (job) {
        const cleanup = await processStorageCleanup(db, job);
        cleanupPending = !cleanup.ok;
      }
      await audit(db, user.id, user.id, "background_cleared", { cleanup_pending: cleanupPending });
      return json({ ok: true, cleanup_pending: cleanupPending, background });
    }

    if (action === "profile_save") {
      const user = requireUser();
      const displayName = String(body.display_name || user.display_name || user.username).trim().slice(0, 48);
      const preferences = body.preferences && typeof body.preferences === "object" && !Array.isArray(body.preferences) ? JSON.parse(JSON.stringify(body.preferences)) as Json : {};
      if (preferences.background && typeof preferences.background === "object") delete (preferences.background as Json).src;
      for (const key of ["outputWidth", "outputHeight"]) {
        if (Object.hasOwn(preferences as Record<string, unknown>, key)) {
          const value = Number((preferences as Record<string, unknown>)[key]);
          if (!Number.isInteger(value) || value < 320 || value > 3840) return json({ ok: false, error: `Invalid ${key}; expected an integer from 320 to 3840.` }, 400);
          (preferences as Record<string, unknown>)[key] = value;
        }
      }
      const output = preferences as Record<string, unknown>;
      const outputWidth = Number(output.outputWidth || 1080);
      const outputHeight = Number(output.outputHeight || 1920);
      if (outputWidth * outputHeight > 8294400) return json({ ok: false, error: "Output resolution exceeds the 8.3 megapixel safety limit." }, 400);
      if (JSON.stringify(preferences).length > 24000) return json({ ok: false, error: "Profile settings are too large." }, 413);
      const { error: accountError } = await db.from("vio_app_users").update({ display_name: displayName }).eq("id", user.id);
      if (accountError) throw accountError;
      const { error: profileError } = await db.from("vio_profiles").upsert({ user_id: user.id, preferences, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (profileError) throw profileError;
      await audit(db, user.id, user.id, "profile_updated", {});
      return json({ ok: true });
    }

    if (action === "admin_update_profile") {
      const admin = requireAdmin();
      const targetId = String(body.target_user_id || "");
      const supportToken = String(body.support_session || "");
      const { data: session } = await db.from("vio_support_sessions").select("id").eq("admin_user_id", admin.id).eq("target_user_id", targetId).eq("token_hash", await sha256(supportToken)).is("ended_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!session) return json({ ok: false, error: "A valid active support session is required." }, 403);
      const { data: target, error: targetError } = await db.from("vio_app_users").select("id,username,role").eq("id", targetId).single();
      if (targetError) throw targetError;
      if (target.username === "paipai77" || target.role === "admin") return json({ ok: false, error: "Admin profile cannot be modified from support view." }, 403);
      const preferences = body.preferences && typeof body.preferences === "object" && !Array.isArray(body.preferences) ? JSON.parse(JSON.stringify(body.preferences)) as Record<string, any> : {};
      if (JSON.stringify(preferences).length > 24000) return json({ ok: false, error: "Profile settings are too large." }, 413);
      const { data: currentProfile, error: currentProfileError } = await db.from("vio_profiles").select("preferences").eq("user_id", targetId).maybeSingle();
      if (currentProfileError) throw currentProfileError;
      const previousBackground = (currentProfile?.preferences as any)?.background || {};
      const requestedBackground = preferences.background && typeof preferences.background === "object" ? { ...preferences.background } : {};
      const requestedPath = String(requestedBackground.storage_path || "");
      if (requestedPath && (requestedPath !== previousBackground.storage_path || requestedBackground.bucket_id !== previousBackground.bucket_id || requestedBackground.bucket_id !== "vio-backgrounds")) {
        return json({ ok: false, error: "Support View cannot replace background files. Upload or clear the background through the dedicated asset controls." }, 400);
      }
      let backgroundCleanupJob: any = null;
      if (previousBackground.storage_path && !requestedPath) {
        backgroundCleanupJob = await enqueueStorageCleanup(db, "vio-backgrounds", previousBackground.storage_path, admin.id, targetId, "admin_support_profile_background_clear");
        const mode = ["solid", "gradient", "transparent"].includes(String(requestedBackground.mode)) ? requestedBackground.mode : "transparent";
        preferences.background = { ...requestedBackground, mode };
        delete preferences.background.src;
        delete preferences.background.storage_path;
        delete preferences.background.bucket_id;
        delete preferences.background.mime_type;
        delete preferences.background.size_bytes;
      } else if (requestedPath) {
        preferences.background = {
          ...requestedBackground,
          storage_path: previousBackground.storage_path,
          bucket_id: "vio-backgrounds",
          mime_type: previousBackground.mime_type,
          size_bytes: previousBackground.size_bytes
        };
        delete preferences.background.src;
      } else if (preferences.background && typeof preferences.background === "object") {
        delete preferences.background.src;
      }
      const displayName = String(body.display_name || target.username).trim().slice(0, 48);
      const { error: accountError } = await db.from("vio_app_users").update({ display_name: displayName }).eq("id", targetId);
      if (accountError) {
        if (backgroundCleanupJob) await cancelStorageCleanup(db, backgroundCleanupJob.id, "Admin profile account update failed");
        throw accountError;
      }
      const { error: profileError } = await db.from("vio_profiles").upsert({ user_id: targetId, preferences, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (profileError) {
        if (backgroundCleanupJob) await cancelStorageCleanup(db, backgroundCleanupJob.id, "Admin profile update failed");
        throw profileError;
      }
      let cleanupPending = false;
      if (backgroundCleanupJob) {
        const cleanup = await processStorageCleanup(db, backgroundCleanupJob);
        cleanupPending = !cleanup.ok;
      }
      await audit(db, admin.id, targetId, "admin_profile_updated", { cleanup_pending: cleanupPending, support_session_id: session.id });
      return json({ ok: true, cleanup_pending: cleanupPending });
    }

    if (action === "admin_delete_asset") {
      const admin = requireAdmin();
      const targetId = String(body.target_user_id || "");
      const assetId = String(body.asset_id || "");
      const supportToken = String(body.support_session || "");
      const { data: session } = await db.from("vio_support_sessions").select("id").eq("admin_user_id", admin.id).eq("target_user_id", targetId).eq("token_hash", await sha256(supportToken)).is("ended_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!session) return json({ ok: false, error: "A valid active support session is required." }, 403);
      const { data: target, error: targetError } = await db.from("vio_app_users").select("username,role").eq("id", targetId).single();
      if (targetError) throw targetError;
      if (target.username === "paipai77" || target.role === "admin") return json({ ok: false, error: "Admin assets are protected from support-view deletion." }, 403);
      const assetType = String(body.asset_type || "expression");
      let cleanupPending = false;
      if (assetType === "background") {
        const { data: profileRow, error: profileError } = await db.from("vio_profiles").select("preferences").eq("user_id", targetId).maybeSingle();
        if (profileError) throw profileError;
        const preferences = { ...((profileRow?.preferences || {}) as Record<string, any>) };
        const background = preferences.background || {};
        if (background.bucket_id !== "vio-backgrounds" || background.storage_path !== assetId) return json({ ok: false, error: "Background asset no longer matches the active profile." }, 409);
        const job = await enqueueStorageCleanup(db, "vio-backgrounds", background.storage_path, admin.id, targetId, "admin_support_background_delete");
        const nextBackground = { ...background, mode: "transparent" };
        delete nextBackground.src;
        delete nextBackground.storage_path;
        delete nextBackground.bucket_id;
        delete nextBackground.mime_type;
        delete nextBackground.size_bytes;
        preferences.background = nextBackground;
        const { error: saveError } = await db.from("vio_profiles").upsert({ user_id: targetId, preferences, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
        if (saveError) {
          await cancelStorageCleanup(db, job.id, "Admin background profile update failed");
          throw saveError;
        }
        const cleanup = await processStorageCleanup(db, job);
        cleanupPending = !cleanup.ok;
        await audit(db, admin.id, targetId, "admin_background_deleted", { cleanup_pending: cleanupPending, support_session_id: session.id });
      } else if (assetType === "accessory") {
        const { data: asset, error: assetError } = await db.from("vio_character_accessories").select("id,bucket_id,storage_path,name").eq("id", assetId).eq("user_id", targetId).single();
        if (assetError) throw assetError;
        const job = await enqueueStorageCleanup(db, asset.bucket_id, asset.storage_path, admin.id, targetId, "admin_support_accessory_delete");
        const { error: rowError } = await db.from("vio_character_accessories").delete().eq("id", assetId).eq("user_id", targetId);
        if (rowError) {
          const { error: cancelError } = await db.from("vio_storage_cleanup_queue").update({
            processed_at: new Date().toISOString(),
            last_error: "Cancelled because accessory metadata deletion failed."
          }).eq("id", job.id);
          if (cancelError) throw new Error("Metadata deletion failed and cleanup job cancellation also failed.");
          throw rowError;
        }
        const cleanup = await processStorageCleanup(db, job);
        cleanupPending = !cleanup.ok;
        await audit(db, admin.id, targetId, "admin_accessory_deleted", { asset_id: assetId, name: asset.name, cleanup_pending: cleanupPending, support_session_id: session.id });
      } else {
        const { data: asset, error: assetError } = await db.from("vio_character_assets").select("id,bucket_id,storage_path,expression").eq("id", assetId).eq("user_id", targetId).single();
        if (assetError) throw assetError;
        const job = await enqueueStorageCleanup(db, asset.bucket_id, asset.storage_path, admin.id, targetId, "admin_support_expression_delete");
        const { error: rowError } = await db.from("vio_character_assets").delete().eq("id", assetId).eq("user_id", targetId);
        if (rowError) {
          const { error: cancelError } = await db.from("vio_storage_cleanup_queue").update({
            processed_at: new Date().toISOString(),
            last_error: "Cancelled because expression metadata deletion failed."
          }).eq("id", job.id);
          if (cancelError) throw new Error("Expression metadata deletion failed and cleanup job cancellation also failed.");
          throw rowError;
        }
        const cleanup = await processStorageCleanup(db, job);
        cleanupPending = !cleanup.ok;
        await audit(db, admin.id, targetId, "admin_asset_deleted", { asset_id: assetId, expression: asset.expression, cleanup_pending: cleanupPending, support_session_id: session.id });
      }
      return json({ ok: true, cleanup_pending: cleanupPending });
    }

    if (action === "my_assets") {
      const user = requireUser();
      const { data: assets, error } = await db.from("vio_character_assets").select("expression,storage_path,bucket_id,character_id").eq("user_id", user.id);
      if (error) throw error;
      const signedAssets: Record<string, string> = {};
      for (const asset of assets || []) {
        const { data } = await db.storage.from(asset.bucket_id).createSignedUrl(asset.storage_path, 3600);
        if (data?.signedUrl) signedAssets[asset.expression] = data.signedUrl;
      }
      const { data: profile, error: profileError } = await db.from("vio_profiles").select("active_character_id,preferences").eq("user_id", user.id).maybeSingle();
      if (profileError) throw profileError;
      const signedPreferences = await signBackground(db, profile?.preferences || {});
      let accessoryQuery = db.from("vio_character_accessories").select("id,name,storage_path,bucket_id,x,y,w,h,mirror,follow_avatar,effects_enabled,sort_order").eq("user_id", user.id).order("sort_order");
      if (profile?.active_character_id) accessoryQuery = accessoryQuery.eq("character_id", profile.active_character_id);
      const { data: accessories, error: accessoryError } = await accessoryQuery;
      if (accessoryError) throw accessoryError;
      const signedAccessories = await Promise.all((accessories || []).map(async (item: any) => {
        const { data, error: signError } = await db.storage.from(item.bucket_id).createSignedUrl(item.storage_path, 3600);
        if (signError || !data?.signedUrl) return null;
        return { id: item.id, name: item.name, src: data.signedUrl, x: item.x, y: item.y, w: item.w, h: item.h, mirror: item.mirror, follow: item.follow_avatar, effectsEnabled: item.effects_enabled, sort_order: item.sort_order };
      }));
      return json({ ok: true, assets: signedAssets, accessories: signedAccessories.filter(Boolean), background: signedPreferences.background || null });
    }

    if (action === "create_room") {
      const user = requireUser();
      const capacity = Number(body.capacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4) return json({ ok: false, error: "Room capacity must be 1–4." }, 400);
      const requestedPurpose = String(body.purpose || "collaboration");
      if (!["collaboration", "personal_overlay"].includes(requestedPurpose) || (requestedPurpose === "personal_overlay" && capacity !== 1)) return json({ ok: false, error: "Personal overlay rooms must have capacity 1." }, 400);
      const purpose = requestedPurpose;
      const { data: activeMembership, error: activeMembershipError } = await db.from("vio_room_members").select("room_id,vio_rooms!inner(id,status,expires_at)").eq("user_id", user.id).eq("vio_rooms.status", "active").gt("vio_rooms.expires_at", new Date().toISOString()).limit(1).maybeSingle();
      if (activeMembershipError) throw activeMembershipError;
      if (activeMembership) return json({ ok: false, error: "ALREADY_IN_ROOM" }, 409);
      let room: any = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        const code = randomRoomCode();
        const { data, error } = await db.from("vio_rooms").insert({ room_code: code, host_user_id: user.id, capacity, purpose }).select("id,room_code,capacity,purpose,status,host_user_id,expires_at").maybeSingle();
        if (!error && data) { room = data; break; }
        if (error && error.code !== "23505") throw error;
      }
      if (!room) throw new Error("ROOM_CODE_EXHAUSTED");
      const { error: memberError } = await db.from("vio_room_members").insert({ room_id: room.id, user_id: user.id, is_host: true });
      if (memberError) {
        const { error: rollbackError } = await db.from("vio_rooms").update({ status: "closed", closed_at: new Date().toISOString(), overlay_token_hash: null }).eq("id", room.id);
        if (rollbackError) console.error("Room creation rollback failed", rollbackError.message);
        throw memberError;
      }
      await audit(db, user.id, null, "room_created", { room_id: room.id, capacity });
      return json({ ok: true, room });
    }

    if (action === "join_room") {
      const user = requireUser();
      const code = String(body.room_code || "").trim();
      const { error: cleanupError } = await db.from("vio_room_join_attempts").delete().lt("attempted_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      if (cleanupError) throw cleanupError;
      const { count, error: countError } = await db.from("vio_room_join_attempts").select("id", { count: "exact", head: true }).eq("auth_user_id", user.authUid).gt("attempted_at", new Date(Date.now() - 60_000).toISOString());
      if (countError) throw countError;
      if ((count || 0) >= 8) return json({ ok: false, error: "Too many room-code attempts. Wait one minute and try again." }, 429);
      const { error: attemptError } = await db.from("vio_room_join_attempts").insert({ auth_user_id: user.authUid, attempted_code: code });
      if (attemptError) throw attemptError;
      if (!/^\d{4}$/.test(code)) return json({ ok: false, error: "Room code must contain exactly four digits." }, 400);
      const { data: room, error } = await db.rpc("vio_join_room", { p_room_code: code, p_user_id: user.id });
      if (error) throw error;
      await audit(db, user.id, null, "room_joined", { room_id: room.id });
      return json({ ok: true, room });
    }

    if (action === "reconnect_room") {
      const user = requireUser();
      const roomId = String(body.room_id || "");
      const { data: room, error } = await db.from("vio_rooms").select("id,room_code,capacity,purpose,status,host_user_id,expires_at").eq("id", roomId).maybeSingle();
      if (error) throw error;
      if (!room || room.status !== "active" || new Date(room.expires_at).getTime() <= Date.now()) return json({ ok: false, error: "ROOM_NOT_FOUND" }, 404);
      const { data: membership, error: membershipError } = await db.from("vio_room_members").select("user_id").eq("room_id", roomId).eq("user_id", user.id).maybeSingle();
      if (membershipError) throw membershipError;
      if (!membership) return json({ ok: false, error: "You are no longer a member of this room." }, 403);
      return json({ ok: true, room });
    }

    if (action === "leave_room") {
      const user = requireUser();
      const roomId = String(body.room_id || "");
      const { data: member, error } = await db.from("vio_room_members").select("is_host").eq("room_id", roomId).eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      if (!member) return json({ ok: true });
      if (member.is_host) {
        const { error: closeError } = await db.from("vio_rooms").update({ status: "closed", closed_at: new Date().toISOString(), overlay_token_hash: null }).eq("id", roomId);
        if (closeError) throw closeError;
        const { error: overlayError } = await db.from("vio_overlay_devices").delete().eq("room_id", roomId);
        if (overlayError) throw overlayError;
        const { error: memberError } = await db.from("vio_room_members").delete().eq("room_id", roomId);
        if (memberError) throw memberError;
        await audit(db, user.id, null, "room_closed_by_host_exit", { room_id: roomId });
      } else {
        const { error: leaveError } = await db.from("vio_room_members").delete().eq("room_id", roomId).eq("user_id", user.id);
        if (leaveError) throw leaveError;
        await audit(db, user.id, null, "room_left", { room_id: roomId });
      }
      return json({ ok: true });
    }

    if (action === "set_room_state") {
      const user = requireUser();
      const roomId = String(body.room_id || "");
      const state = String(body.state || "idle");
      if (!["idle", "talking"].includes(state)) return json({ ok: false, error: "Invalid player state." }, 400);
      const { data: member, error: memberError } = await db.from("vio_room_members").select("user_id").eq("room_id", roomId).eq("user_id", user.id).maybeSingle();
      if (memberError) throw memberError;
      if (!member) return json({ ok: false, error: "Not a room member." }, 403);
      const { error } = await db.from("vio_room_members").update({ state, state_updated_at: new Date().toISOString() }).eq("room_id", roomId).eq("user_id", user.id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "room_members") {
      const user = requireUser();
      const roomId = String(body.room_id || "");
      const { data: membership } = await db.from("vio_room_members").select("user_id").eq("room_id", roomId).eq("user_id", user.id).maybeSingle();
      if (!membership) return json({ ok: false, error: "You are not a member of this room." }, 403);
      const { data: members, error } = await db.from("vio_room_members").select("user_id,is_host,state,state_updated_at,vio_app_users!inner(username),vio_profiles!inner(preferences,active_character_id),vio_characters(id,name,vio_character_assets(expression,storage_path,bucket_id),vio_character_accessories(id,name,storage_path,bucket_id,x,y,w,h,mirror,follow_avatar,effects_enabled,sort_order)),vio_room_overrides(overrides)").eq("room_id", roomId);
      if (error) throw error;
      const mapped = await Promise.all((members || []).map(async (member: any) => {
        const activeCharacter = (member.vio_characters || []).find((item: any) => item.id === member.vio_profiles?.active_character_id) || member.vio_characters?.[0];
        const assets: Record<string, string> = {};
        for (const asset of activeCharacter?.vio_character_assets || []) {
          const { data: signed } = await db.storage.from(asset.bucket_id).createSignedUrl(asset.storage_path, 3600);
          if (signed?.signedUrl) assets[asset.expression] = signed.signedUrl;
        }
        const accessories = await Promise.all((activeCharacter?.vio_character_accessories || []).map(async (item: any) => {
          const { data, error: signError } = await db.storage.from(item.bucket_id).createSignedUrl(item.storage_path, 3600);
          if (signError || !data?.signedUrl) return null;
          return { id: item.id, name: item.name, src: data.signedUrl, x: item.x, y: item.y, w: item.w, h: item.h, mirror: item.mirror, follow: item.follow_avatar, effectsEnabled: item.effects_enabled, sort_order: item.sort_order };
        }));
        return { user_id: member.user_id, is_host: member.is_host, username: member.vio_app_users?.username || "Unknown", state: member.state || "idle", state_updated_at: member.state_updated_at, assets, accessories: accessories.filter(Boolean), preferences: await signBackground(db, member.vio_profiles?.preferences || {}), overrides: member.vio_room_overrides?.[0]?.overrides || {} };
      }));
      return json({ ok: true, members: mapped });
    }

    if (action === "set_room_override") {
      const user = requireUser();
      const roomId = String(body.room_id || "");
      const overrides = body.overrides && typeof body.overrides === "object" ? body.overrides as Json : {};
      const { data: member } = await db.from("vio_room_members").select("user_id").eq("room_id", roomId).eq("user_id", user.id).maybeSingle();
      if (!member) return json({ ok: false, error: "Not a room member." }, 403);
      const allowed = ["scale", "x", "y", "sensitivity", "boostDb", "deviceId"];
      const clean: Json = {};
      for (const key of allowed) if (Object.hasOwn(overrides, key)) clean[key] = overrides[key];
      const { error } = await db.from("vio_room_overrides").upsert({ room_id: roomId, user_id: user.id, overrides: clean, updated_at: new Date().toISOString() }, { onConflict: "room_id,user_id" });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "record_asset") {
      const user = requireUser();
      const path = String(body.storage_path || "");
      const expression = String(body.expression || "");
      const mime = String(body.mime_type || "");
      const size = Number(body.size_bytes);
      if (path.length > 512 || !path.startsWith(`${user.id}/`) || path.split("/").some(part => !part || part === "." || part === "..") || !["idle", "talking", "blink", "talking_blink", "thumbnail"].includes(expression) || !["image/png", "image/webp"].includes(mime) || !Number.isSafeInteger(size) || size < 1 || size > 8388608) return json({ ok: false, error: "Asset metadata is invalid." }, 400);
      let { data: character } = await db.from("vio_characters").select("id").eq("user_id", user.id).eq("name", "Default").maybeSingle();
      if (!character) {
        const { data, error } = await db.from("vio_characters").insert({ user_id: user.id, name: "Default" }).select("id").single();
        if (error) throw error;
        character = data;
        await db.from("vio_profiles").upsert({ user_id: user.id, active_character_id: character.id });
      }
      const { error } = await db.from("vio_character_assets").upsert({ user_id: user.id, character_id: character.id, expression, storage_path: path, bucket_id: "vio-studio-assets", mime_type: mime, size_bytes: size, updated_at: new Date().toISOString() }, { onConflict: "character_id,expression" });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "record_accessory") {
      const user = requireUser();
      const storagePath = String(body.storage_path || "");
      const name = String(body.name || "Accessory").trim().slice(0, 120);
      const mime = String(body.mime_type || "");
      const size = Number(body.size_bytes);
      if (storagePath.length > 512 || !storagePath.startsWith(`${user.id}/characters/default/accessories/`) || storagePath.split("/").some(part => !part || part === "." || part === "..") || !["image/png", "image/webp"].includes(mime) || !Number.isSafeInteger(size) || size < 1 || size > 8388608) return json({ ok: false, error: "Accessory metadata is invalid." }, 400);
      const pathParts = storagePath.split("/");
      const fileName = pathParts.pop() || "";
      const folderPath = pathParts.join("/");
      const { data: storedFiles, error: storageLookupError } = await db.storage.from("vio-studio-assets").list(folderPath, { search: fileName, limit: 100 });
      if (storageLookupError) throw storageLookupError;
      const storedFile = (storedFiles || []).find((file: any) => file.name === fileName);
      if (!storedFile) return json({ ok: false, error: "Uploaded accessory object was not found in storage." }, 409);
      const storedSize = Number(storedFile.metadata?.size ?? storedFile.metadata?.contentLength);
      if (Number.isFinite(storedSize) && storedSize !== size) return json({ ok: false, error: "Uploaded accessory size does not match its metadata." }, 409);
      const storedMime = String(storedFile.metadata?.mimetype || storedFile.metadata?.contentType || "");
      if (storedMime && storedMime !== mime) return json({ ok: false, error: "Uploaded accessory MIME type does not match its metadata." }, 409);
      let { data: character, error: characterError } = await db.from("vio_characters").select("id").eq("user_id", user.id).eq("name", "Default").maybeSingle();
      if (characterError) throw characterError;
      if (!character) {
        const { data, error } = await db.from("vio_characters").insert({ user_id: user.id, name: "Default" }).select("id").single();
        if (error) throw error;
        character = data;
        const { error: profileError } = await db.from("vio_profiles").upsert({ user_id: user.id, active_character_id: character.id });
        if (profileError) throw profileError;
      }
      const { data: accessory, error } = await db.from("vio_character_accessories").insert({ user_id: user.id, character_id: character.id, name, storage_path: storagePath, bucket_id: "vio-studio-assets", mime_type: mime, size_bytes: size }).select("id").single();
      if (error) throw error;
      return json({ ok: true, accessory_id: accessory.id });
    }

    if (action === "update_accessory") {
      const user = requireUser();
      const accessoryId = String(body.accessory_id || "");
      const updates: Record<string, unknown> = {};
      for (const key of ["x", "y", "w", "h"] as const) {
        if (body[key] === undefined) continue;
        const value = Number(body[key]);
        const min = key === "w" || key === "h" ? 0.01 : 0;
        const max = key === "w" || key === "h" ? 2 : 1;
        if (!Number.isFinite(value) || value < min || value > max) return json({ ok: false, error: `Invalid accessory ${key}.` }, 400);
        updates[key] = value;
      }
      for (const key of ["mirror", "follow_avatar", "effects_enabled"] as const) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== "boolean") return json({ ok: false, error: `Invalid accessory ${key}.` }, 400);
          updates[key] = body[key];
        }
      }
      if (!Object.keys(updates).length) return json({ ok: false, error: "No accessory changes supplied." }, 400);
      updates.updated_at = new Date().toISOString();
      const { error } = await db.from("vio_character_accessories").update(updates).eq("id", accessoryId).eq("user_id", user.id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "delete_accessory") {
      const user = requireUser();
      const accessoryId = String(body.accessory_id || "");
      const { data: accessory, error: lookupError } = await db.from("vio_character_accessories").select("id,bucket_id,storage_path").eq("id", accessoryId).eq("user_id", user.id).single();
      if (lookupError) throw lookupError;
      const job = await enqueueStorageCleanup(db, accessory.bucket_id, accessory.storage_path, user.id, user.id, "user_accessory_delete");
      const { error: rowError } = await db.from("vio_character_accessories").delete().eq("id", accessoryId).eq("user_id", user.id);
      if (rowError) {
        const { error: cancelError } = await db.from("vio_storage_cleanup_queue").update({
          processed_at: new Date().toISOString(),
          last_error: "Cancelled because accessory metadata deletion failed."
        }).eq("id", job.id);
        if (cancelError) throw new Error("Metadata deletion failed and cleanup job cancellation also failed.");
        throw rowError;
      }
      const cleanup = await processStorageCleanup(db, job);
      return json({ ok: true, cleanup_pending: !cleanup.ok });
    }

    if (action === "issue_room_overlay") {
      const user = requireUser();
      const roomId = String(body.room_id || "");
      const { data: member } = await db.from("vio_room_members").select("user_id").eq("room_id", roomId).eq("user_id", user.id).maybeSingle();
      if (!member) return json({ ok: false, error: "Only a room member can create its overlay link." }, 403);
      const token = randomCode(40);
      const { error: revokeError } = await db.from("vio_overlay_devices").delete().eq("room_id", roomId);
      if (revokeError) throw revokeError;
      const { error } = await db.from("vio_rooms").update({ overlay_token_hash: await sha256(token) }).eq("id", roomId);
      if (error) throw error;
      await audit(db, user.id, null, "room_overlay_issued", { room_id: roomId });
      return json({ ok: true, room_id: roomId, overlay_token: token });
    }

    if (action === "overlay_connect") {
      const roomId = String(body.room_id || "");
      const token = String(body.overlay_token || "");
      if (!roomId || token.length < 20) return json({ ok: false, error: "Overlay credentials are invalid." }, 400);
      const { data: room, error } = await db.from("vio_rooms").select("id,status,overlay_token_hash,capacity,expires_at,host_user_id").eq("id", roomId).single();
      if (error || !room || room.status !== "active" || new Date(room.expires_at).getTime() <= Date.now() || room.overlay_token_hash !== await sha256(token)) return json({ ok: false, error: "Overlay link is invalid or room is closed or expired." }, 403);
      const { error: deviceError } = await db.from("vio_overlay_devices").upsert({ auth_user_id: authUser.id, room_id: roomId }, { onConflict: "auth_user_id" });
      if (deviceError) throw deviceError;
      const { data: members, error: memberError } = await db.from("vio_room_members").select("user_id,is_host,state,state_updated_at,vio_app_users!inner(username),vio_profiles!inner(preferences,active_character_id),vio_characters(id,vio_character_assets(expression,storage_path,bucket_id),vio_character_accessories(id,name,storage_path,bucket_id,x,y,w,h,mirror,follow_avatar,effects_enabled,sort_order)),vio_room_overrides(overrides)").eq("room_id", roomId);
      if (memberError) throw memberError;
      const mapped = await Promise.all((members || []).map(async (member: any) => {
        const assets: Record<string, string> = {};
        const character = (member.vio_characters || []).find((item: any) => item.id === member.vio_profiles?.active_character_id) || member.vio_characters?.[0];
        for (const asset of character?.vio_character_assets || []) {
          const { data: signed } = await db.storage.from(asset.bucket_id).createSignedUrl(asset.storage_path, 3600);
          if (signed?.signedUrl) assets[asset.expression] = signed.signedUrl;
        }
        const accessories = await Promise.all((character?.vio_character_accessories || []).map(async (item: any) => {
          const { data, error: signError } = await db.storage.from(item.bucket_id).createSignedUrl(item.storage_path, 3600);
          if (signError || !data?.signedUrl) return null;
          return { id: item.id, name: item.name, src: data.signedUrl, x: item.x, y: item.y, w: item.w, h: item.h, mirror: item.mirror, follow: item.follow_avatar, effectsEnabled: item.effects_enabled, sort_order: item.sort_order };
        }));
        return { user_id: member.user_id, is_host: member.is_host, username: member.vio_app_users?.username || "Unknown", state: member.state || "idle", state_updated_at: member.state_updated_at, assets, accessories: accessories.filter(Boolean), preferences: await signBackground(db, member.vio_profiles?.preferences || {}), overrides: member.vio_room_overrides?.[0]?.overrides || {} };
      }));
      return json({ ok: true, room: { id: room.id, capacity: room.capacity, host_user_id: room.host_user_id }, members: mapped });
    }

    return json({ ok: false, error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const map: Record<string, number> = { DEVICE_NOT_PAIRED: 401, ADMIN_ONLY: 403, ACCOUNT_NOT_FOUND: 404, PAIRING_CODE_INVALID: 403, DEVICE_ALREADY_BOUND: 409, ROOM_NOT_FOUND: 404, ROOM_FULL: 409, ALREADY_IN_ROOM: 409, ADMIN_ALREADY_EXISTS: 409 };
    return json({ ok: false, error: message }, map[message] || 400);
  }
});
