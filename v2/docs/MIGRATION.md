# Vio Studio v2.0 migration plan

## Do not overwrite v1.0 yet

1. Keep the current published root page and current Supabase `pngtuber-api` Edge Function intact.
2. Rename the GitHub repository to `Vio-Studio` only after confirming the current Pages project URL and deployment source.
3. Add the new frontend under `/v2/` for the first deployment. GitHub Project Pages URLs include the repository path, so update any hard-coded paths and the overlay-link base after the rename.
4. Apply the v2 SQL migration only after reviewing the existing Supabase schema. It uses `vio_*` table names and a new bucket to avoid overwriting v1 assets.
5. Deploy `vio-api` alongside the existing `pngtuber-api`; do not delete the old function until old URLs are retired.
6. Test the new auth flow, audio engine and two-user room in `/v2/`.
7. Port the full v1 avatar renderer and verify old user assets can be imported or re-uploaded.
8. Promote v2 to the Pages root only after the test checklist passes. Keep the old v1 HTML and Offline v1.7 downloadable as archive files.

## Data mapping to v2

- v1 profile slug → `vio_app_users` / `vio_profiles` record created by Admin.
- v1 preset JSON → `vio_profiles.preferences` after an explicit one-time import review.
- v1 local/IndexedDB assets → upload to `vio-studio-assets` under `<app_user_id>/characters/<character_id>/...`.
- v1 `pngtuber-assets` objects remain untouched until their ownership and mapping are verified.

Do not copy old `ownerToken` values into the new identity model. Old public overlay links and v1 owner tokens should be retired only after v2 links work.
