# Supabase Development setup — Vio Studio v2.0

This guide is for a **new, separate Supabase Development project** used only by the v2 branch. Do not use the existing production project, v1.0 project, or any project that contains production data.

## 0. Safety rules

- Create a new Supabase project specifically for Vio Studio v2 Development.
- Keep the project reference, URL, and keys separate from production.
- Never put a secret/service-role key in `src/config.js`, GitHub, screenshots, chat, or browser code.
- Do not deploy migrations or functions to Supabase Live as part of this setup.
- If you cannot confidently distinguish the Development project from production, stop before applying SQL or deploying.

## 1. Create the Development project

In the Supabase Dashboard, create a new project with a distinct name such as `vio-studio-v2-dev`. Use a strong database password and store it in a password manager. Wait until the database is ready.

Record locally (not in Git):
- Project URL: `https://<project-ref>.supabase.co`
- Project reference: `<project-ref>`
- Publishable key: the `sb_publishable_...` key shown for this Development project

Do not copy any production values.

## 2. Apply database migrations

Open **SQL Editor** in the Development project. Run each file once, in this exact order, waiting for a successful result before running the next:

1. `supabase/migrations/001_vio_studio_v2.sql`
2. `supabase/migrations/002_vio_studio_v2_security_hardening.sql`
3. `supabase/migrations/003_vio_character_accessories.sql`
4. `supabase/migrations/004_vio_background_media.sql`
5. `supabase/migrations/005_vio_storage_cleanup_queue.sql`
6. `supabase/migrations/006_vio_storage_cleanup_reference_guard.sql`

Use the SQL file contents from this branch. Do not paste all six into one query initially: applying them separately makes the first failing migration identifiable and prevents later migrations from running after an earlier failure.

Afterward, verify these tables exist in the Development project's Table Editor:
- `vio_app_users`
- `vio_user_devices`
- `vio_pairing_codes`
- `vio_profiles`
- `vio_characters`
- `vio_character_assets`
- `vio_character_accessories`
- `vio_rooms`
- `vio_room_members`
- `vio_storage_cleanup_queue`
- `vio_audit_logs`

Also verify Storage contains private buckets `vio-studio-assets` and `vio-backgrounds`.

## 3. Configure Auth and Realtime

In **Authentication → Sign In / Providers**:
- Enable Anonymous Sign-Ins for this isolated Development project.
- Do not enable mandatory CAPTCHA/Turnstile yet. The v2 frontend does not currently submit a challenge token; CAPTCHA integration must be implemented and tested before making it mandatory or exposing anonymous sign-in publicly.

In **Realtime → Settings**:
- Disable **Allow public access** for Realtime channels after migrations have created the private-topic policies.
- Keep room channels private. The client subscribes to `room:<uuid>` with `config.private: true`.

## 4. Configure Edge Function secrets

In **Edge Functions → Secrets**, set `VIO_ADMIN_BOOTSTRAP_TOKEN` to a long, random, one-time value for Development only.

The function also needs the standard project environment values supplied by Supabase:
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEYS` or legacy `SUPABASE_ANON_KEY`
- `SUPABASE_SECRET_KEYS` or legacy `SUPABASE_SERVICE_ROLE_KEY`

The secret/service-role value must remain server-side. Never add it to the frontend config.

## 5. Deploy the function to Development only

From the `v2/` directory, with the Supabase CLI installed and authenticated, deploy only to the Development project reference:

```sh
supabase functions deploy vio-api --project-ref "$DEV_PROJECT_REF"
```

Set `DEV_PROJECT_REF` locally to the newly created Development project's reference. Before running the command, compare it with the project reference shown in the Dashboard and confirm it is not the production reference.

Do not run `supabase db push` for this initial setup: the repository migrations currently use numbered filenames rather than the timestamp naming convention expected by the Supabase CLI migration history. The SQL Editor sequence above is the controlled initial application path. Migration history automation can be added separately after this first isolated integration.

## 6. Configure the local frontend

From `v2/`:

```sh
cp src/config.example.js src/config.js
```

Edit the ignored local-only `src/config.js` and fill in **only** the Development project URL and its public publishable key. The file is listed in `.gitignore` and must never be committed.

Serve the `v2/` directory locally over HTTP (not `file://`) and open the local development URL. Confirm the connection badge changes from “Backend belum dikonfigurasi” only after the config and backend are ready.

## 7. Bootstrap Admin

1. Open the local v2 app connected to the Development project.
2. Enter username `paipai77` and the one-time `VIO_ADMIN_BOOTSTRAP_TOKEN`.
3. Confirm the Admin account and its device binding are created.
4. Immediately remove `VIO_ADMIN_BOOTSTRAP_TOKEN` from Development function secrets and redeploy `vio-api`.
5. Sign in again and confirm Admin access still works without the bootstrap token.
6. Create test User and Tester accounts from Admin. Use disposable test identities only.

Never send pairing codes or bootstrap secrets in screenshots, public issues, or chat.

## 8. Integration test checklist

Do not consider Supabase integration complete until all of these are exercised against Development:

- [ ] Anonymous Auth session persists after refresh on the same device.
- [ ] Pairing code is single-use, expires, and cannot bind an already-bound device to another user.
- [ ] Admin bootstrap works once; a second bootstrap attempt is rejected.
- [ ] User/Tester creation, role changes, disable, re-enable and deletion work.
- [ ] Expression PNG/WebP upload, replacement, signed delivery and deletion work.
- [ ] Accessory upload, position update, replacement and deletion work.
- [ ] Background image/GIF/video upload, replacement, clear and signed delivery work.
- [ ] Storage cleanup success, retry, skip-if-referenced and concurrent reference protection work through the Edge Function + Storage API.
- [ ] Room create/join/leave/close, capacity limit and expired-room rejection work.
- [ ] Private Realtime presence/broadcast works for two distinct devices and rejects non-members.
- [ ] OBS overlay token issue, rotation, revocation and expired-room rejection work.
- [ ] Support View is audited, expires after 15 minutes, and exits correctly after refresh.
- [ ] Admin account deletion and Auth cleanup failure paths are verified.
- [ ] Android Chrome, desktop Chrome and the target Browser Source are tested.

## 9. Stop conditions

Stop and do not proceed to production if:
- any migration fails;
- RLS or Storage policy behavior differs from the expected owner/member scope;
- any service-role secret reaches frontend code or browser storage;
- cleanup can delete a referenced object;
- a disabled/deleted user can still access an active room or support session;
- Realtime accepts a public/non-member subscription;
- the Admin bootstrap token remains configured after successful bootstrap.

Supabase Live, production GitHub Pages, repository `main`, Offline v1.7 and Online v1.0 are outside the scope of this guide.
