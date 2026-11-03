# Repository Instructions

## Local Build Storage

- Before every desktop installer build (`pnpm build:desktop` or `pnpm build:desktop:release`), remove the previous installer packages from `apps/desktop/src-tauri/target/release/bundle/`. Do not let an old installer be mistaken for the output of the current build.
- Keep Rust/Tauri compilation caches during normal builds. Do not clear the whole `target/` directory just to replace installer packages; it forces a costly full rebuild.
- Generated local build caches older than 30 days should be cleaned before starting another large build when they are no longer needed. Check `apps/desktop/src-tauri/target/`, `.release-tools/`, `artifacts/`, and dependency/build output directories (`node_modules/`, `**/dist/`) for stale contents. Preserve recent or actively used contents; explain any cleanup that could discard a wanted installer or release artifact.
- Treat `data/`, `download/`, `apps/server/download/`, credentials, databases, and the staged runtime resources under `apps/desktop/src-tauri/resources/core/` and `apps/desktop/src-tauri/resources/media-tools/` as user data or required runtime inputs, not disposable caches. Never remove them as part of routine build cleanup.
- Use the system Trash/recycle bin for cleanup when available. Never use broad destructive cleanup commands when a narrowly scoped path will do.
