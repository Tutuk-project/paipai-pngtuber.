#!/usr/bin/env sh
set -eu
node --check src/app.js
node --check src/avatar-renderer.js
node --check src/audio-engine.js
node --check src/overlay.js
node --test tests/audio-engine.test.mjs tests/project-smoke.test.mjs
if command -v tsc >/dev/null 2>&1; then
  tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck tests/deno-shims.d.ts supabase/functions/vio-api/index.ts
fi
