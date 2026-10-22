# mediaGrab

> **A local-first media workspace for your desktop.**
>
> Turn a link into a clear, trackable download task, then keep the result on your own device.

[简体中文](./README.zh.md) · [Technical design](./docs/TECH-DESIGN.md) · [Technology choices](./docs/项目技术选型.md)

![mediaGrab logo](./apps/web/src/assets/mediagrab-logo.svg)

mediaGrab brings link parsing, media selection, downloads, and task history into one focused desktop workspace. The project began as an effort to make saving authorized media less scattered and more understandable: one place to see what a link contains, what can actually be downloaded, and what happened to each task.

## Why mediaGrab

Media workflows are often split between browser tabs, command-line tools, format guesswork, and files with unclear names. mediaGrab aims to make that process feel like a dependable local tool instead: paste a link, inspect the available media, choose an output, and follow the task through to a file on your computer.

The project is evolving from a Bilibili-focused prototype into a platform-adapter-based workspace. Bilibili, Douyin, and Xiaohongshu paths are present in the codebase; platform behavior and access can vary, so support is not a promise that every link or quality is available. The longer-term direction is a reliable cross-platform desktop app with honest capability reporting, recoverable tasks, and a self-contained runtime.

## Product principles

- **Local first:** Tasks, settings, account data, and downloaded files belong on your device.
- **One workflow, many sources:** Platform-specific details stay behind adapters and a shared media model.
- **Show what is actually available:** Login requirements, quality limits, expired links, missing tools, and platform errors should be understandable rather than silently hidden.
- **Keep the core replaceable:** The interface, desktop shell, and media engine have separate responsibilities, so the current runtime can evolve without rewriting the product experience.
- **Respect access and ownership:** Use only content you are authorized to access and save. mediaGrab is not designed to bypass DRM, paywalls, or platform restrictions.

## How it fits together

| Layer | Technology | In plain terms |
| --- | --- | --- |
| Desktop shell | Tauri 2 + Rust | Creates the native app window and platform-specific bundles. |
| Interface | React 19 + TypeScript + Vite | The workspace for links, media choices, tasks, and settings. |
| Local service | Node.js 22 + Fastify | Shared business core for parsing, task orchestration, local APIs, and persistence. |
| Shared contracts | TypeScript + Zod | Keeps the interface and service aligned on data shapes and validation. |
| Local storage | SQLite | Stores settings and task records; media files remain ordinary files. |
| Media tools | FFmpeg and yt-dlp | Handle media processing and selected platform extraction workflows. |

The current repository is a working desktop application whose business core is Node.js/Fastify. Tauri provides the desktop shell and Rust-native integration; the production packaging work is to ship the Node runtime and local service with the app, then provide a clear FFmpeg/yt-dlp strategy. See [Build for desktop](#build-for-desktop) and the [technology selection](./docs/项目技术选型.md) for details.

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

### Build prerequisites

- **All platforms:** Node.js `>=22.5`, pnpm, Rust stable via rustup, and the platform's native build tools.
- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Windows:** Microsoft C++ Build Tools with “Desktop development with C++”, the MSVC Rust toolchain, and WebView2 Runtime. MSI packaging may also require the Windows Script Host optional feature (VBScript).
- **Linux (Debian/Ubuntu):** Tauri's GTK/WebKit development libraries and a C/C++ toolchain. Consult the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the package list for your distribution.

To build a particular format instead of every configured format, invoke the Tauri CLI from the desktop package, for example on macOS:

```bash
pnpm --filter @mediagrab/desktop exec tauri build --bundles app,dmg
```

For development, `pnpm dev:desktop` starts the Tauri window, Vite frontend, and local Node service. See [project structure and development conventions](./docs/项目结构与开发规范.md) for more workflows.

## Project status

mediaGrab is under active development. The desktop shell can be built on macOS; Windows and Linux packaging should be built and verified on their respective hosts. Core platform flows are still being validated, and the desktop bundle does not yet include its runtime dependencies. Treat generated bundles as development artifacts rather than polished, self-contained releases.

## Documentation

- [Product requirements](./docs/PRD.md)
- [Technical design](./docs/TECH-DESIGN.md)
- [Technology selection, explained](./docs/项目技术选型.md)
- [Roadmap](./docs/ROADMAP.md)
- [Risk and responsible use](./docs/RISK-CONTROL.md)
- [Project structure and development conventions](./docs/项目结构与开发规范.md)

## Responsible use

Use mediaGrab only for content you have the right to access, download, and retain. Follow applicable laws and each platform's terms. The project does not aim to defeat DRM, bypass paid or regional restrictions, remove watermarks, or use shared credentials.

## License

The repository does not currently declare a project-level license. Do not assume the code is licensed for redistribution or reuse until a license is added.
