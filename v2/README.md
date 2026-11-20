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

## Important state

This is a **development foundation**, not a production release and not yet connected to your live Supabase project or GitHub repository. The legacy avatar/effects renderer from the 3.6 MB v1.0 `index.html` still needs to be ported into the new component boundary. The source file is currently available in the ChatGPT Library as indexed text but its raw bytes could not be materialized into the working directory. Do not replace the currently published site with this package until that renderer port and the integration tests pass.

## Repository strategy

After the GitHub connection is available and the repository has been renamed to `Vio-Studio`, place this package under `/v2/` first. That provides a test URL while leaving the current root page, Offline v1.7 file and v1.0 behavior intact:

`https://<github-username>.github.io/Vio-Studio/v2/`

When v2.0 passes testing, promote it to the repository root in a separate deployment change.

## Setup

1. Copy `src/config.example.js` to `src/config.js`.
2. Fill `supabaseUrl` and the public `sb_publishable_...` key from the existing Supabase project. Never use a secret/service-role key in this file.
3. In Supabase Auth settings, enable Anonymous Sign-Ins. Anonymous auth creates a persistent device session; users who clear browser storage or change devices need a new one-time pairing code from Admin. CAPTCHA / Turnstile is not wired into this frontend yet: integrate and test a challenge-token flow before enabling mandatory CAPTCHA or exposing anonymous sign-in broadly.
4. Review `supabase/migrations/001_vio_studio_v2.sql` against the existing project, then apply it. The migration creates new `vio_*` tables and a new private `vio-studio-assets` bucket. It deliberately leaves v1.0 tables and the `pngtuber-assets` bucket unchanged.
5. Set a long random Edge Function secret named `VIO_ADMIN_BOOTSTRAP_TOKEN`. Keep it private. It is used once to bootstrap the first `paipai77` Admin account.
6. Deploy the Edge Function directory `supabase/functions/vio-api` as `vio-api`.
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
- Apply SQL to the existing Supabase project after schema review.
- Configure and deploy `vio-api`.
- Add the original canvas renderer and port avatar effects/accessories/background/resolution support.
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
- Private Realtime authorization requires an active, unexpired room.
- Support View rejects inactive accounts and Admin targets.
- Asset metadata validates path segments, size and allowed expressions.
- Account deletion halts when Storage/Auth cleanup fails.

These are local source changes only. The migration and Edge Function have **not** been deployed to Supabase. Re-run `./tests/check-syntax.sh` after future edits. Runtime integration and live RLS/Realtime tests remain required.

- Admin account creation now runs through a single database RPC transaction so the account, profile, pairing code and creation audit cannot be partially committed.

## Renderer migration update

A first modular `src/avatar-renderer.js` pass is now wired into the v2 editor and OBS overlay. It supports expression/blink selection, scale, mirror, bounce, sway, breathing, transparent/solid/gradient backgrounds, and basic glow/shadow/stroke/filter/distortion effects. This is not full v1.0 parity yet: accessory import/placement/per-accessory effects, background image/video import, custom resolution controls, and device/OBS visual regression remain outstanding.
