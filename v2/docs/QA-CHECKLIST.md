# Vio Studio v2.0 QA checklist

## Foundation and access
- [ ] Existing root page and Offline v1.7 still load unchanged.
- [ ] v2 page loads from `/v2/` on GitHub Pages.
- [ ] Unauthenticated visitor sees the blurred login gate, not the editor.
- [ ] Fresh anonymous device cannot claim a username without a valid one-time pairing code.
- [ ] Paired returning device signs in by username without re-entering the pairing code.
- [ ] Username cannot be duplicated with different capitalization.
- [ ] `paipai77` is the only initial Admin; Admin bootstrap token is removed after bootstrap.
- [ ] User cannot see Admin / Test Lab menus.
- [ ] Tester sees Test Lab but not Admin Center.
- [ ] User role changes are enforced by Edge Function / RLS, not only hidden UI.

## Audio
- [ ] Android Chrome permission prompt and start button work.
- [ ] iOS Safari permission prompt is triggered from a user gesture.
- [ ] Device enumeration and input selection work after permission is granted.
- [ ] Normal speaking voice crosses adaptive threshold without shouting.
- [ ] Room noise does not keep avatar in talking state.
- [ ] Mic booster does not create sustained false talking due to noise.
- [ ] Changing input device and restarting mic works.
- [ ] AudioContext suspended/resume path is recovered after app focus returns.
- [ ] Microphone track mute/end is surfaced and can be restarted.
- [ ] No raw audio samples are sent to Supabase.

## Collaboration (first test: two users)
- [ ] Host can create capacity 1, 2, 3 or 4 room.
- [ ] Room code is four digits and unique among active rooms.
- [ ] Join succeeds with a valid code and fails for a closed/full/expired room.
- [ ] Join attempts are rate-limited.
- [ ] Both participants load their own profile and avatar assets.
- [ ] An OBS overlay opened after a player is already talking receives that current state.
- [ ] P1 talking only animates P1; P2 talking only animates P2.
- [ ] Both talking animates both avatars.
- [ ] Temporary scale/X/Y and microphone overrides do not overwrite profile settings.
- [ ] Guest exit leaves the room; host exit closes the room in the first prototype.
- [ ] Rejoin restores profile defaults and room overrides as designed.

## OBS
- [ ] Overlay URL has no editor UI or login form.
- [ ] Background is alpha-transparent.
- [ ] OBS overlay receives both users' state events without requesting microphone permission.
- [ ] Invalid/expired token and closed room are rejected.
- [ ] Overlay token can be rotated by issuing a new link.

## Admin
- [ ] Admin can create User and Tester accounts and copy the one-time code once.
- [ ] Admin can inspect users, profiles, character files and rooms.
- [ ] Admin can enable/disable non-root accounts and change User/Tester role.
- [ ] Root `paipai77` cannot be removed or disabled from the dashboard.
- [ ] Admin room close works and is audited.
- [ ] Recent audit actions display in Admin Center with actor, target and action details.
- [ ] Support view is clearly marked, time-limited and audited; exit returns to Admin session.
- [ ] Uploaded files are removed from storage when a user is deleted.

## Security regression checks added (static / local)
- [x] Audit-log insert failures are surfaced to the caller instead of silently ignored.
- [x] Rotating a room OBS token revokes previously registered overlay devices.
- [x] Closed or expired rooms no longer satisfy private Realtime membership authorization.
- [x] Support View cannot be started against disabled accounts or Admin accounts.
- [x] Asset metadata rejects path traversal, malformed paths, unsafe sizes and unsupported expressions.
- [x] Account deletion stops on storage/Auth cleanup errors rather than silently deleting the app account anyway.

- [x] Admin account + profile + one-time pairing code + creation audit are inserted in one PostgreSQL transaction.

## Renderer migration (first integrated pass)
- [x] New modular canvas renderer is wired into the v2 editor and OBS overlay.
- [x] Idle/talking/blink/talking-blink expression selection.
- [x] Configurable scale, mirror, talking bounce, sway, breathing and blink cadence.
- [x] Transparent, solid-color and gradient backgrounds.
- [x] Glow, shadow, stroke, color filter and slice-distortion render paths.
- [ ] Legacy accessory import, placement editor and per-accessory effects.
- [ ] Legacy background image/video import and custom output resolution.
- [ ] Full parity comparison against v1.0 on Android/iOS/OBS.
