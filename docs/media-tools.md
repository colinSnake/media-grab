# Desktop media tools

## Decision

The desktop release bundles one pinned `ffmpeg` binary and one pinned `yt-dlp`
binary for each supported target. The app does not download executables at
runtime and does not ask users to install Python, FFmpeg, or yt-dlp separately.

The binaries are Tauri resources rather than Tauri sidecars. The Node/Fastify
core owns media-tool process execution, and Tauri starts that core from the
parallel `resources/core` bundle while passing `MEDIA_TOOLS_DIR`.

## Size budget

On the current macOS arm64 development host, the prepared Node core is about
`147 MB` uncompressed: the Node executable is about `115 MB`, production
dependencies about `29 MB`, and the web bundle about `2 MB`. The current debug
`.app` is about `171 MB` before FFmpeg and yt-dlp are staged.

The final installed size will normally gain roughly tens of megabytes for
yt-dlp and tens to low hundreds of megabytes for FFmpeg, depending on target
architecture and whether the FFmpeg build is minimal or full-featured. DMG,
MSI, and AppImage compression will make download size smaller than the raw
`.app`/resource size, but the installed application still needs the extracted
binaries.

The main size lever is the FFmpeg build: mediaGrab only needs remuxing and
audio conversion, so the release should use an LGPL-compatible, stripped build
with no unnecessary encoders, filters, documentation, or shared-library tree.
The release preflight rejects packages over `180 MiB` for the Node core or
media tools by default; override only for a documented target-specific reason
with `MEDIA_GRAB_RUNTIME_LIMIT_MB` or `MEDIA_GRAB_TOOLS_LIMIT_MB`.

## Resource layout

```text
apps/desktop/src-tauri/resources/media-tools/
├── darwin-arm64/
│   ├── ffmpeg
│   └── yt-dlp
├── win32-x64/
│   ├── ffmpeg.exe
│   └── yt-dlp.exe
└── linux-x64/
    ├── ffmpeg
    └── yt-dlp
```

The server resolves tools in this order:

1. An explicit path saved in settings.
2. `MEDIA_TOOLS_DIR/<platform>-<arch>/` from the desktop package.
3. The repository's staged resource directory during development.
4. The system `PATH` fallback; yt-dlp also retains the existing project `.venv`
   and `python3 -m yt_dlp` development fallback.

Stage binaries for the current host with:

```bash
MEDIA_TOOLS_SOURCE_DIR=/path/to/ffmpeg-and-ytdlp pnpm stage:desktop-tools
```

The source directory may contain the two canonical names directly or a nested
`<platform>-<arch>` directory. The staging script normalizes Windows `.exe`
names and sets executable bits on Unix systems.

## yt-dlp policy

Use the official standalone release for the target platform, pin the release
version and SHA-256 in the release workflow, and ship matching third-party
notices. `pnpm prepare:release-tools` requires fixed `YT_DLP_VERSION`,
`YT_DLP_URL`, and `YT_DLP_SHA256` values. URLs must point to the final executable,
not a zip or tar archive. Do not call yt-dlp's self-updater from
the installed application; update it together with a signed MediaGrab release.

The initial release matrix is macOS universal, Windows x64, and Linux x64. Add
Windows arm64 and Linux arm64 only after the corresponding desktop runtime and
installer paths are verified.

## FFmpeg policy

FFmpeg is built or sourced as a pinned executable for each target. The initial
release build must use an LGPL-compatible configuration without GPL or nonfree
components. `pnpm prepare:release-tools` requires fixed `FFMPEG_URL` and
`FFMPEG_SHA256` values. URLs must point to a standalone executable with the
required codecs, not a shared-library archive. Each release stores the exact source revision,
configure flags, checksums, and license notices alongside the artifacts.

Do not commit large binaries to the application repository. The release
workflow injects them into `resources/media-tools` before `tauri build`.

## Remaining release work

- Build or obtain reproducible FFmpeg artifacts for macOS, Windows, and Linux.
- Add per-target checksum/version values to the release CI matrix and verify
  third-party license notice generation.
- Test service lifecycle, resource lookup, and core log rotation on each OS.
- Add About/diagnostic output for tool version, path, architecture, and license.
- Run a real installed-package download test for each target.
