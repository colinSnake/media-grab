# mediaGrab

> **把多平台媒体整理，变成一件清楚、可追踪的本地工作。**
>
> 粘贴链接，查看可用内容，创建下载任务，把文件留在自己的设备上。

[English](./README.md) · [技术设计](./docs/TECH-DESIGN.md) · [项目技术选型](./docs/项目技术选型.md)

![mediaGrab 标志](./apps/web/src/assets/mediagrab-logo.svg)

mediaGrab 是一款面向个人用户的本地媒体工作台，目标是把链接解析、视频/音频选择、下载进度和任务历史放到同一个桌面应用里。项目从解决“工具分散、资源看不懂、下载过程难追踪”开始：让用户知道链接里有什么、当前账号实际能获取什么，以及每个任务最后发生了什么。

## 项目缘起与愿景

保存一段自己有权访问的媒体，常常要在浏览器、命令行、格式转换工具和一堆文件之间来回切换。mediaGrab 希望把这条流程变成一件可理解、可管理的本地工作：粘贴链接，检查资源，选择产物，跟踪任务，最后在电脑上找到文件。

仓库历史从 2026 年 10 月 16 日的初始提交开始，随后逐步加入 B 站解析与下载链路，再扩展到通用媒体模型、抖音/小红书适配、账号管理和任务工作区。现在它正从以 B 站为中心的原型，演进为基于平台适配器的多来源工作台。代码中已有多个平台的接入路径，但平台规则、登录状态和资源可用性会变化，因此“有适配器”不代表任意链接或清晰度都一定可用。

我们的长期愿景是：做一款跨 macOS、Windows、Linux 的可靠桌面工具，让能力边界说清楚、任务状态可追踪、数据留在本机，并提供不要求用户手动安装 Node 的桌面版本；FFmpeg/yt-dlp 则根据体积、许可和平台支持选择随包提供或按需准备。

## 项目原则

- **本地优先**：任务、设置、账号信息和下载文件由用户自己的设备保存。
- **多来源、同一套流程**：平台差异放在适配器内部，产品界面使用统一媒体模型。
- **能力如实呈现**：登录要求、画质限制、链接失效、工具缺失和平台错误都应该有明确反馈。
- **模块边界清楚**：界面、桌面窗口和媒体处理各司其职，让当前实现可以逐步演进。
- **尊重访问权限**：只处理用户有权访问和保存的内容，不以绕过 DRM、付费或平台限制为目标。

## 技术栈一览

| 部分 | 技术 | 通俗说明 |
| --- | --- | --- |
| 桌面外壳 | Tauri 2 + Rust | 创建原生应用窗口，并生成各系统的安装包。 |
| 用户界面 | React 19 + TypeScript + Vite | 链接输入、媒体选择、任务和设置所在的界面。 |
| 本地服务 | Node.js 22 + Fastify | 负责解析、任务编排、本机 API 和数据访问，也是 Web 与桌面共用的业务核心。 |
| 共享数据约定 | TypeScript + Zod | 让界面与服务对“数据长什么样、输入是否合法”有共同约定。 |
| 本地存储 | SQLite | 保存设置和任务记录；媒体文件仍作为普通文件存放。 |
| 媒体工具 | FFmpeg、yt-dlp | 分别参与媒体处理，以及部分平台的格式提取流程。 |

更完整的选型理由、优缺点和当前/目标架构见[项目技术选型](./docs/项目技术选型.md)。

## 手动构建桌面版

请在目标系统本机打开仓库根目录，运行对应命令。三种系统使用同一组 pnpm 命令：

| 目标系统 | 命令 |
| --- | --- |
| macOS | `pnpm install`，然后 `pnpm build:desktop` |
| Linux | `pnpm install`，然后 `pnpm build:desktop` |
| Windows（PowerShell） | `pnpm install`，然后 `pnpm build:desktop` |

当前 Tauri 配置会请求构建主机支持的全部安装包格式。常见产物如下，实际格式取决于系统及已安装的打包工具：

| 构建系统 | 常见产物 |
| --- | --- |
| macOS | `.app`、`.dmg` |
| Windows | `.msi`、`.exe`（NSIS） |
| Linux | `.deb`、`.rpm`、`.AppImage` |

产物通常位于 `apps/desktop/src-tauri/target/release/bundle/`。在一台系统上执行命令不会自动生成另外两种系统的原生安装包；要可靠发布，请分别在对应系统或相应 CI runner 上构建。

如果只想生成指定格式，可以直接调用 Tauri CLI。例如在 macOS 只构建 `.app` 和 `.dmg`：

```bash
pnpm --filter @mediagrab/desktop exec tauri build --bundles app,dmg
```

### 构建前准备

- **所有系统**：Node.js `>=22.5`、pnpm、通过 rustup 安装的稳定版 Rust，以及对应系统的原生编译工具。
- **macOS**：安装 Xcode Command Line Tools：`xcode-select --install`。
- **Windows**：安装 Microsoft C++ Build Tools，并勾选“使用 C++ 的桌面开发”；使用 MSVC Rust 工具链，并确保 WebView2 Runtime 可用。构建 MSI 报 `light.exe` 错误时，检查 Windows 可选功能中的 VBScript。
- **Linux（Debian/Ubuntu）**：安装 GTK/WebKitGTK 开发库及 C/C++ 编译工具链。其他发行版的依赖包名称不同，请查看 [Tauri 官方前置要求](https://v2.tauri.app/zh-cn/start/prerequisites/)。

### 当前发行限制

当前构建能生成 Tauri 桌面外壳和 Web 界面安装包，但完整发行版仍需要把 Node.js 运行时和本地服务随应用提供，并确定 FFmpeg/yt-dlp 的分发策略。因此当前产物是可构建的开发阶段桌面包，不是安装后即可完成全部任务的正式发行版。Rust 在这里负责 Tauri 桌面外壳和原生系统集成，不负责替换现有 Node 业务核心。

## 开发

```bash
pnpm install
pnpm dev:desktop
```

`pnpm dev:desktop` 会启动 Tauri 窗口、Vite 界面和本地 Node 服务。单独运行检查时可用：`pnpm typecheck`、`pnpm test`、`pnpm build`。

## 文档

- [产品需求](./docs/PRD.md)
- [技术设计](./docs/TECH-DESIGN.md)
- [项目技术选型（通俗版）](./docs/项目技术选型.md)
- [项目路线图](./docs/ROADMAP.md)
- [风险与合规边界](./docs/RISK-CONTROL.md)
- [项目结构与开发规范](./docs/项目结构与开发规范.md)

## 合规使用

请仅使用 mediaGrab 处理你有权访问、下载和保存的内容，并遵守适用法律及平台服务条款。本项目不以破解 DRM、绕过付费或区域限制、去水印或共享账号凭据为目标。

## 许可证

仓库目前没有声明项目级许可证。在添加许可证之前，请不要默认代码可以被再发布或复用。
