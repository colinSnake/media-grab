# Bundled Node core

Release preparation fills this directory with:

```text
core/
├── node
├── dist/
├── node_modules/
└── web/
```

The Tauri host starts `node dist/index.js`, points `WEB_DIST` at `web/`, and
passes the application data and media-tool resource directories through the
environment. The generated runtime is ignored by Git; this file only keeps the
resource contract visible in source builds.
