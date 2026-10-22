# Desktop media tools

## Decision

The desktop release bundles one pinned `ffmpeg` binary and one pinned `yt-dlp`
binary for each supported target. The app does not download executables at
runtime and does not ask users to install Python, FFmpeg, or yt-dlp separately.

The binaries are Tauri resources rather than Tauri sidecars. The Node/Fastify
core owns media-tool process execution, and Tauri starts that core from the
parallel `resources/core` bundle while passing `MEDIA_TOOLS_DIR`.

## Size budget

On the current macOS arm64 development host, the optimized Node core is about
`142 MiB` uncompressed: the Node executable is about `128 MiB`, production
dependencies about `11 MiB`, and the web bundle about `2.5 MiB`. Stripping Node
can save about `26 MiB`, but invalidates its original signature, so release
builds keep the upstream executable unchanged until the macOS signing workflow
is validated.

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

Runtime dependencies are copied as real files rather than pnpm symlinks,
which can be lost when Tauri collects application resources. The preflight
rejects remaining symlinks and copies the runtime outside the workspace to
start an isolated server, check its API endpoints, and verify desktop-origin
CORS access. This prevents repository dependencies from hiding missing files
in a release bundle.

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
not a zip or tar archive. For local release preparation, set `YT_DLP_BIN` to an
already downloaded executable and provide the same version/hash variables.
Do not call yt-dlp's self-updater from
the installed application; update it together with a signed MediaGrab release.

Build separate macOS arm64 and x64 packages. A universal package would need to
ship two Node runtimes and two FFmpeg binaries, increasing resource size
without improving the architecture-specific installer experience. The initial
matrix is macOS arm64/x64, Windows x64, and Linux x64. Add Windows arm64 and
Linux arm64 only after those desktop runtime and installer paths are verified.

## FFmpeg policy

FFmpeg is built or sourced as a pinned executable for each target. The initial
release build must use an LGPL-compatible configuration without GPL or nonfree
components. `pnpm prepare:release-tools` requires fixed `FFMPEG_URL` and
`FFMPEG_SHA256` values. URLs must point to a standalone executable with the
required codecs, not a shared-library archive. For local release preparation,
set `FFMPEG_BIN` to the standalone executable. Set `FFMPEG_VERSION`,
`FFMPEG_LICENSE_FILE`, and `YT_DLP_LICENSE_FILE`; the script verifies the
version output, rejects GPL/nonfree FFmpeg builds, requires `libmp3lame`, and
copies both notices plus a checksum manifest into the bundle. Each release
stores the exact source revision, configure flags, checksums, and notices.

## Prepared local tools

The macOS arm64 build host has inputs saved in
`.release-tools/darwin-arm64/`, outside the temporary directory. This directory
is ignored by Git. `prepare:release-tools` automatically reads its
`release-inputs.json`, resolves local paths relative to that directory, and
uses environment variables as overrides.

The prepared inputs are FFmpeg `9.0.2` (about `7.3 MiB`) and the official
yt-dlp `2026.10.21` macOS executable (about `35.5 MiB`). The FFmpeg binary
statically links LAME `3.100` and only depends on macOS system libraries.
Both license texts, the LAME notice, and yt-dlp bundled dependency notices
are copied into the app resources. Source archives, build configuration, and
the upstream yt-dlp checksum list are retained beside the inputs.

The inputs are already staged in
`apps/desktop/src-tauri/resources/media-tools/darwin-arm64/`. From the repository
root, verify them without building an installer:

```bash
pnpm prepare:release-tools
pnpm verify:desktop-runtime
```

To prepare the runtime again, verify the tools, and build the installer:

```bash
pnpm build:desktop:release
```

These cached binaries target this macOS arm64 host. Other build hosts need
their own native inputs and checksum manifests. No Windows, Linux, or Intel
macOS binary was prepared by this step.

## Supplying other tool builds

The final build command is run from the repository root with both tool inputs
and their license notices configured:

```bash
YT_DLP_BIN=/path/to/yt-dlp \
YT_DLP_VERSION=<pinned-version> \
YT_DLP_SHA256=<64-character-sha256> \
YT_DLP_LICENSE_FILE=/path/to/yt-dlp-license.txt \
FFMPEG_BIN=/path/to/ffmpeg \
FFMPEG_VERSION=<pinned-version> \
FFMPEG_SHA256=<64-character-sha256> \
FFMPEG_LICENSE_FILE=/path/to/ffmpeg-license.txt \
LAME_LICENSE_FILE=/path/to/lame-license.txt \
YT_DLP_THIRD_PARTY_LICENSE_FILE=/path/to/yt-dlp-third-party-licenses.txt \
pnpm build:desktop:release
```

Do not commit large binaries to the application repository. The release
workflow injects them into `resources/media-tools` before `tauri build`.

## Remaining release work

- Run the [desktop CI workflow](./desktop-ci.md) on all supported runners and
  confirm the uploaded installers. It compiles FFmpeg/LAME from fixed source
  archives and records per-target checksums, versions, build flags and notices.
- Test service lifecycle, resource lookup, and core log rotation on each OS.
- Add About/diagnostic output for tool version, path, architecture, and license.
- Run a real installed-package download test for each target.
