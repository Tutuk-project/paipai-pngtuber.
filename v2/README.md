# Vio Studio · PNGTuber v2.0 (development foundation)

This is the first modular v2.0 foundation for the existing PNGTuber project. It is intentionally additive: it does not replace the current v1.0 deployment or touch the Offline v1.7 release.

## What is included

- New responsive UI shell with collapsible icon-only / icon+label sidebar.
- Username-first login gate on every visit. After a device is paired once, returning use asks only for the username while the Supabase anonymous session remains on that device; app logout retains the device binding.
- Admin-created User / Tester accounts; no public registration route.
- One-time device pairing code for first use or a new device. This is not a reusable password.
- Admin bootstrap for `paipai77` through a one-time server-side bootstrap token.
- Admin overview, account creation, role/disable/delete, pairing-code reissue, device-session revocation, room inspection/edit/closure, profile editing, asset inspection/deletion, recent audit-log viewer, and audited support-view sessions.
- Support View is a scoped, time-limited inspection/edit session, not a full login as the user's identity. Admin keeps their own session; no user credential or device session is copied.
- GO Collaboration host/join foundation, capacity 1–4, 4-digit room code, private Realtime channel, persisted idle/talking snapshot for late-joining overlays, separate per-user room overrides, reconnectable rooms, and a separate one-player OBS room.
- Separate transparent OBS renderer page with per-player scale and X/Y room override rendering.
- New microphone engine with platform-friendly media constraints, fallback capture constraints, AGC/noise suppression preferences, adaptive noise floor, calibrated threshold, hysteresis, hangover, gain control and AudioContext resume support.
- Additive Supabase SQL schema and a single Edge Function API.

## Renderer performance benchmark\n\nThe fast CI smoke test validates pixel output at 360×640. A separate high-resolution benchmark exercises a 1080×1920 canvas, four accessories and all seven effects without a full-frame pixel readback. Run it from `v2/` with `node tests/browser-renderer.performance.mjs` after installing the Playwright dependencies and Chromium used by CI. It reports per-frame and average render time; results from GitHub-hosted Chromium are comparative only and do not establish POCO X7 Pro or iOS performance.\n\n## Important state

This is a **development foundation**, not a production release. The source is stored on GitHub in branch `develop/vio-studio-v2` under `/v2/`. It has not been connected to or deployed on the live Supabase project, and GitHub Pages production settings remain unchanged. The legacy avatar/effects renderer from the 3.6 MB v1.0 `index.html` is only partially ported. Do not replace the currently published site with this package until renderer parity and real integration tests pass.

## Repository strategy

The package currently lives under `/v2/` on the development branch only. The repository has not been renamed, and the Pages deployment source has not been changed to this branch. Confirm the Pages build source and project URL before enabling a v2 test deployment. Keep the current root page and Offline v1.7 / Online v1.0 baselines unchanged. When v2.0 passes testing, promote it in a separate deployment change.

## Setup

Follow the full [Supabase Development setup guide](docs/SUPABASE-DEV-SETUP.md) before connecting a backend. It uses a separate Development project and explicitly avoids Supabase Live.

1. Copy `src/config.example.js` to `src/config.js` and use only the separate Development project's URL and public publishable key.
2. Fill `supabaseUrl` and the public `sb_publishable_...` key from the existing Supabase project. Never use a secret/service-role key in this file.
3. In Supabase Auth settings, enable Anonymous Sign-Ins. Anonymous auth creates a persistent device session; users who clear browser storage or change devices need a new one-time pairing code from Admin. CAPTCHA / Turnstile is not wired into this frontend yet: integrate and test a challenge-token flow before enabling mandatory CAPTCHA or exposing anonymous sign-in broadly.
4. Create a **separate Supabase Development project** for v2. Review and apply migrations `001_vio_studio_v2.sql` through `008_move_rls_helpers_to_private_schema.sql` there in numerical order. They add v2 tables/policies, accessory metadata, the private `vio-studio-assets` and `vio-backgrounds` buckets, the server-only cleanup queue, and database guards that serialize cleanup reservations against new metadata references. They deliberately leave v1.0 tables and the `pngtuber-assets` bucket unchanged. Never use the production project for this initial integration test; none of these migrations has been applied to Supabase Live.
5. In the Development project only, set a long random Edge Function secret named `VIO_ADMIN_BOOTSTRAP_TOKEN`. Keep it private. It is used once to bootstrap the first `paipai77` Admin account.
6. Deploy the Edge Function directory `supabase/functions/vio-api` as `vio-api` to the Development project only. The local Supabase CLI config is `supabase/config.toml`; always pass the explicit Development project reference when deploying.
7. Open `/v2/`, enter `paipai77` and the one-time bootstrap token. After the first successful Admin bootstrap, remove `VIO_ADMIN_BOOTSTRAP_TOKEN` from the function secrets and redeploy the function.
8. From Admin, create User / Tester accounts and provide each new user the generated one-time device pairing code privately. Returning use on that device requires only their username. A new device needs a new pairing code from Admin. Admin can revoke all paired devices and issue a replacement code if access needs to be recovered.

### Supabase keys

The Edge Function reads the current `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` variables when available, with legacy key names as compatibility fallback. The secret key remains server-side only.

### Security model and the username-only decision

A username alone is not proof of identity. To preserve the simple everyday login you asked for without letting someone claim `paipai77` or another user's account, the first login on each device is paired with a single-use code created by Admin. The browser stores a Supabase anonymous session after pairing. The role is always read from the server-side `vio_app_users` table; it is never accepted from local storage or supplied by the client.

The Admin bootstrap token is a one-time setup secret, not a recurring password. A username-only Admin login with no device binding or one-time proof would let anyone who types `paipai77` take over the Superuser account, so that unsafe shortcut is deliberately not implemented.

### Realtime

The migration adds private-topic authorization policies for room members and OBS overlay devices. In Supabase Dashboard, disable **Allow public access** for Realtime channels after confirming the policies are applied. Clients subscribe to `room:<uuid>` with `config.private: true`. Presence is for online membership; Broadcast carries only low-frequency `idle` / `talking` state transitions. Raw microphone audio is never sent.

## Required follow-up before release

- Connect GitHub and add the package under `/v2/` without replacing root files.
- Confirm repository rename and GitHub Pages source settings.
- Configure the separate Supabase Development project, apply migrations 001–008 there, and deploy `vio-api` there only.
- Complete runtime integration checks for Auth, Storage upload/signing/deletion/retry, account lifecycle, Realtime, and room membership before any production planning.
- Complete renderer parity: background image/video import, custom resolution controls, direct accessory drag positioning, legacy per-state/per-target effect controls, and remaining v1.0 motion/effect behavior.
- Load saved profile preferences and selected character from cloud on sign-in.
- Expand the dedicated storage browser, user filtering/pagination and full audit-log history; current build already includes basic user/profile/asset inspection and the recent audit viewer.
- Verify room position/scale overrides against real 2-user and 4-user layouts on OBS and mobile Browser Sources.
- Verify the support-view expiry and exit path after 15 minutes, including browser refresh while support mode is active.
- Test two distinct devices, then the four-user maximum.
- Integrate CAPTCHA / Turnstile token support before enabling mandatory anonymous-sign-in CAPTCHA for public use.
- Test Android Chrome, iOS Safari, desktop Chrome and the target streaming app Browser Source.

## Local syntax check

Run:

```sh
./tests/check-syntax.sh
```

## 2026-11-20 static security review update

The development copy now includes additional safeguards:
- Audit-log write failures are surfaced instead of silently ignored.
- OBS token rotation revokes previously registered overlay devices.
- Private Realtime authorization requires an active, unexpired room for members and OBS overlay devices.
- Cross-account Admin profile/character/asset/Storage access is routed through audited Edge Function support actions rather than broad client-side RLS exceptions.
- Admin bootstrap is serialized and constrained to a single Admin row.
- OBS overlay API rejects expired rooms before registering overlay devices.
- Disabling a user ends their active support-view sessions.
- Support View rejects inactive accounts and Admin targets.
- Asset metadata validates path segments, size and allowed expressions.
- Account deletion halts when Storage/Auth cleanup fails.

The migrations 001–008 and Edge Function `vio-api` v1 are deployed to the isolated Supabase Development project only, with gateway JWT verification enabled. Runtime Auth/bootstrap, Storage, Realtime and multi-device integration tests remain required. Supabase Live is untouched.

- Admin account creation now runs through a single database RPC transaction so the account, profile, pairing code and creation audit cannot be partially committed.

## Renderer migration update

A modular `src/avatar-renderer.js` is wired into the v2 editor and OBS overlay. It supports expression/blink selection, scale, mirror, bounce, sway, breathing, transparent/solid/gradient backgrounds, and basic glow/shadow/stroke/filter/distortion effects. Character accessories now have a separate private metadata table, PNG/WebP upload, per-item position and size controls, mirror/follow/effects toggles, and signed asset delivery to collaboration and OBS snapshots. This remains partial v1.0 parity: direct drag positioning, background image/video import, custom resolution controls, full per-accessory effect tuning, and device/OBS visual regression remain outstanding.

## 2026-11-20 Vio-Studio v2.0 checkpoints and CI

- Latest checkpoint: `docs/CHECKPOINT-46-2026-11-21.md`.
- Previous checkpoints: `docs/CHECKPOINT-45-2026-11-21.md`, `docs/CHECKPOINT-44-2026-11-21.md`, and `docs/CHECKPOINT-43-2026-11-21.md`.
- Previous checkpoints: `docs/CHECKPOINT-17-2026-11-20.md`, `docs/CHECKPOINT-16-2026-11-20.md`, and `docs/CHECKPOINT-15-2026-11-20.md`.
- Previous checkpoints: `docs/CHECKPOINT-10-2026-11-20.md`, `docs/CHECKPOINT-09-2026-11-20.md`, and `docs/CHECKPOINT-08-2026-11-20.md`.
- GitHub Actions workflow: `.github/workflows/vio-v2-ci.yml`.
- Checkpoint 34 verified run: `44747638566`, 57 tests passed, 0 failed, 0 skipped.
- Checkpoint 35 verified run: `44748939403`, 58 tests passed, 0 failed, 0 skipped; PostgreSQL 16 concurrency suite passed 4/4 scenarios.
- Coverage includes security policy checks, expired-room Realtime checks, Admin bootstrap, accessory lifecycle/transforms/direct drag, collaboration animation, private background media validation/signed delivery, portrait/custom output dimensions, host-selected room resolution, mobile pixel-budget validation, and live asset-update broadcast wiring.
- Migrations 001–008 and Edge Function `vio-api` v1 are deployed to the isolated Supabase Development project `vio-studio-v2-dev` (`nbpqnwjxavuhpiuntcep`). JWT verification is enabled. Supabase Live remains untouched.

## 2026-11-21 Collaboration and OBS hotfix

- Root cause confirmed from Supabase logs: PostgREST error `PGRST200` on room-member queries. The code attempted to embed `vio_profiles` and `vio_characters` directly from `vio_room_members`, although both relationships are reachable through `vio_app_users`.
- Corrected both `room_members` and `overlay_connect` to embed profile and character relations through `vio_app_users` using the declared foreign keys.
- Added explicit handling for membership-query errors and structured PostgREST error serialization/logging instead of returning `[object Object]`.
- Deployed the corrected `vio-api` Edge Function to the isolated Development project only: version 11, `verify_jwt=true`.
- Updated the preview repository's OBS overlay error display to surface backend response details.
- GitHub development commits: `f2d7e393e26d41339effe0fcc858959d0bf449c3` (Edge Function), `a5b881ebf47423ff6b269d4a970dadb43c539f8b` (OBS diagnostics), `8176d9cb81e5ab4a1d7fc0f23f0c4b253d0c8b21` (regression test).
- Preview commits: `8c7c008056a54141a7fd652f8d81f8a5f34580ce` (OBS diagnostics), `1e07ea967811c4c8df701f9e543759cf284b04eb` (Edge Function source sync).
- Runtime re-test of room participants and generated OBS link is still pending user confirmation. No production Pages, Supabase Live, Offline v1.7 or Online v1.0 deployment was changed.
