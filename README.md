<p align="center">
  <img src="./apps/web/src/assets/mediagrab-logo.svg" width="96" valign="middle" alt="MediaGrab logo" />
  &nbsp;&nbsp;&nbsp;
  <img src="./apps/web/src/assets/mediagrab-wordmark.svg" width="390" valign="middle" alt="MediaGrab" />
</p>

<div style="height: 25px"></div>

> **A local-first media workspace for your desktop.**
>
> Turn a link into a clear, trackable download task, then keep the result on your own device.

[简体中文](./README.zh.md) · [Technical design](./docs/TECH-DESIGN.md) · [Technology choices](./docs/technology-selection.md)

MediaGrab brings link parsing, media selection, downloads, and task history into one focused desktop workspace. The project began as an effort to make saving authorized media less scattered and more understandable: one place to see what a link contains, what can actually be downloaded, and what happened to each task.

## Download v0.1.0

[Download MediaGrab v0.1.0](https://github.com/colinSnake/media-grab/releases/tag/v0.1.0) — the first desktop **pre-release**, published on October 29, 2026. It brings link parsing, video/audio selection, download tracking, and task history into one local workspace. Installers include Node.js, FFmpeg, and yt-dlp, so these tools do not need to be installed separately.

Choose the installer for your system from the release page's **Assets**:

| System | Installer |
| --- | --- |
| macOS Apple Silicon (M series) | `MediaGrab_0.1.0_aarch64.dmg` |
| macOS Intel | `MediaGrab_0.1.0_x64.dmg` |
| Windows x64 (64-bit Intel/AMD) | `MediaGrab_0.1.0_x64-setup.exe` |
| Linux x64 | `MediaGrab_0.1.0_amd64.deb` or `MediaGrab_0.1.0_amd64.AppImage` |

All four build targets passed CI builds and installed-package smoke tests. This is an early preview: installers are unsigned and have not been notarized by Apple, and real-device testing is ongoing. The release also includes `SHA256SUMS.txt` and media-tool source/build archives.

## Why MediaGrab

Media workflows are often split between browser tabs, command-line tools, format guesswork, and files with unclear names. MediaGrab aims to make that process feel like a dependable local tool instead: paste a link, inspect the available media, choose an output, and follow the task through to a file on your computer.

The project is evolving from a Bilibili-focused prototype into a platform-adapter-based workspace. Bilibili, Douyin, and Xiaohongshu paths are present in the codebase; platform behavior and access can vary, so support is not a promise that every link or quality is available. The longer-term direction is a reliable cross-platform desktop app with honest capability reporting, recoverable tasks, and a self-contained runtime.

## Product principles

- **Local first:** Tasks, settings, account data, and downloaded files belong on your device.
- **One workflow, many sources:** Platform-specific details stay behind adapters and a shared media model.
- **Show what is actually available:** Login requirements, quality limits, expired links, missing tools, and platform errors should be understandable rather than silently hidden.
- **Keep the core replaceable:** The interface, desktop shell, and media engine have separate responsibilities, so the current runtime can evolve without rewriting the product experience.
- **Respect access and ownership:** Use only content you are authorized to access and save. MediaGrab is not designed to bypass DRM, paywalls, or platform restrictions.

## How it fits together

| Layer | Technology | In plain terms |
| --- | --- | --- |
| Desktop shell | Tauri 2 + Rust | Creates the native app window and platform-specific bundles. |
| Interface | React 19 + TypeScript + Vite | The workspace for links, media choices, tasks, and settings. |
| Local service | Node.js 22 + Fastify | Shared business core for parsing, task orchestration, local APIs, and persistence. |
| Shared contracts | TypeScript + Zod | Keeps the interface and service aligned on data shapes and validation. |
| Local storage | SQLite | Stores settings and task records; media files remain ordinary files. |
| Media tools | FFmpeg and yt-dlp | Handle media processing and selected platform extraction workflows. |

The current repository is a working desktop application whose business core is Node.js/Fastify. Tauri provides the desktop shell and Rust-native integration. Release tooling now prepares the Node core and stages checksum-verified FFmpeg/yt-dlp resources; see [Build for desktop](#build-for-desktop) and the [media tools release plan](./docs/media-tools.md).

## Platform Cookies

Under **App Settings**, you can paste your own Bilibili, Douyin, Xiaohongshu, or YouTube Cookie. Douyin, Xiaohongshu, and YouTube accept a Cookie header or a Netscape-format export. YouTube Cookies are passed to yt-dlp when extracting resources that require sign-in; they do **not** guarantee higher-bitrate formats. The end-to-end YouTube download flow has not yet been verified with a real account Cookie.

Credentials are encrypted locally and never returned by the Cookie status API. The pasted text stays in the textarea during the current app session after saving; after restart the textarea is blank, while the stored credential remains usable. You can clear it explicitly. Bilibili credentials are also cleared when verification definitively reports a logged-out session. An extractor failure alone does not prove a Douyin, Xiaohongshu, or YouTube Cookie has expired, so those credentials are not automatically cleared on such failures. Bilibili account details are hidden by default; multiple saved accounts remain available under **Manage saved accounts**.

In App Settings, the download directory, yt-dlp path, and default output each save automatically when their field loses focus. The per-platform **Save / Clear** buttons manage only that platform's Cookie.

## Build for desktop

Build on the operating system you want to target. Run the matching commands from the repository root; Tauri packaging and native system libraries make native builds the recommended path.

| Target | Commands |
| --- | --- |
| macOS | `pnpm install` then `pnpm build:desktop` |
| Linux | `pnpm install` then `pnpm build:desktop` |
| Windows (PowerShell) | `pnpm install` then `pnpm build:desktop` |

The Tauri configuration currently requests all bundle formats supported on the build host. Typical outputs are placed under `apps/desktop/src-tauri/target/release/bundle/`:

| Build host | Common bundle formats |
| --- | --- |
| macOS | `.app`, `.dmg` |
| Windows | `.msi`, `.exe` (NSIS) |
| Linux | `.deb`, `.rpm`, `.AppImage` |

The exact set depends on the host and installed packaging tools. Building on one OS does not automatically produce native installers for all three. Cross-compilation has extra constraints; use a matching OS or CI runner for predictable release artifacts.

For hosted builds, add `build-ci-cd` to the latest pushed commit message or open **Actions → Desktop builds → Run workflow**. The workflow builds macOS arm64/x64, Windows x64, and Linux x64 installers, including the Node runtime, FFmpeg, and yt-dlp. Branch builds upload Actions artifacts. Version tags run the same checks and create a draft GitHub Release; the **Publish existing desktop build** workflow can also create a draft from a previously successful build. See [Desktop CI](./docs/desktop-ci.md) for triggers, downloads, and tool version updates.

### Build prerequisites

- **All platforms:** Node.js `>=22.5`, pnpm, Rust stable via rustup, and the platform's native build tools.
- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Windows:** Microsoft C++ Build Tools with “Desktop development with C++”, the MSVC Rust toolchain, and WebView2 Runtime. MSI packaging may also require the Windows Script Host optional feature (VBScript).
- **Linux (Debian/Ubuntu):** Tauri's GTK/WebKit development libraries and a C/C++ toolchain. Consult the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the package list for your distribution.

To build a particular format instead of every configured format, invoke the Tauri CLI from the desktop package, for example on macOS:

```bash
pnpm --filter @mediagrab/desktop exec tauri build --bundles app,dmg
```

For development, `pnpm dev:desktop` starts the Tauri window, Vite frontend, and local Node service. See [project structure and development conventions](./docs/project-structure-and-conventions.md) for more workflows.

## Project status

MediaGrab is under active development. The v0.1.0 desktop pre-release is available for macOS arm64/x64, Windows x64, and Linux x64, with CI builds and installed-package smoke tests passing for all four targets. Code signing, Apple notarization, and broader real-device testing remain pending; see the [roadmap](./docs/ROADMAP.md) for validation still in progress.

## Documentation

- [Product requirements](./docs/PRD.md)
- [Technical design](./docs/TECH-DESIGN.md)
- [Technology selection, explained](./docs/technology-selection.md)
- [Roadmap](./docs/ROADMAP.md)
- [Risk and responsible use](./docs/RISK-CONTROL.md)
- [Project structure and development conventions](./docs/project-structure-and-conventions.md)

## Responsible use

Use MediaGrab only for content you have the right to access, download, and retain. Follow applicable laws and each platform's terms. The project does not aim to defeat DRM, bypass paid or regional restrictions, remove watermarks, or use shared credentials.

## License

MediaGrab is licensed under the [MIT License](./LICENSE).

Third-party dependencies and bundled tools, including FFmpeg, LAME, and yt-dlp, retain their respective licenses. See the license notices included with those components.
