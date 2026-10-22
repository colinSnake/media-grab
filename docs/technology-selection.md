# mediaGrab 项目技术选型

这份文档用尽量直白的语言说明 mediaGrab 为什么采用现在的技术组合、每一层负责什么，以及哪些部分已经落地、哪些仍是目标。判断“当前实现”时以仓库代码为准，不把规划中的能力描述成已经完成。

## 一句话架构

可以把 mediaGrab 想成一间本地工作室：React 界面是工作台，Node 服务是业务引擎，SQLite 是本地记录本，FFmpeg/yt-dlp 是专用工具，而 Tauri 是把工作台装进 macOS、Windows、Linux 桌面窗口的外壳。Rust 用于 Tauri 桌面宿主和原生系统集成；Node/Fastify 继续负责业务，不规划迁移替换。

```text
React + TypeScript 界面
          │ 本地 HTTP API
          ▼
Node.js + Fastify 服务（当前核心）
   ├── 平台适配与媒体解析
   ├── 下载任务与状态更新
   ├── SQLite 设置和任务记录
   └── FFmpeg / yt-dlp 外部工具

Tauri 2 + Rust 桌面外壳
   └── 加载 Web 界面、构建桌面应用包
```

## 各层做什么

| 技术/模块 | 通俗解释 | 在 mediaGrab 中的职责 | 当前状态 |
| --- | --- | --- | --- |
| Tauri 2 | 用系统自带的网页显示组件承载界面，再用 Rust 提供桌面程序外壳。 | 创建应用窗口、启动随包 Node core、加载前端、通过 Tauri CLI 生成平台安装包。 | 已接入并能构建桌面外壳；Node core 资源准备和生命周期接线已完成，三端安装验收待完成。 |
| Rust | 一种编译型系统语言，适合编写桌面宿主和系统集成代码。 | 用于 Tauri 宿主、窗口生命周期及需要原生 API 的桌面能力。 | 当前用于 Tauri；不负责替换 Node/Fastify 业务核心。 |
| React 19 | 用组件拼装网页界面的工具。 | 构建链接输入、解析预览、下载任务、历史记录和设置界面。 | 当前界面已使用。 |
| TypeScript | 给 JavaScript 加上类型信息，帮助更早发现数据用错的问题。 | 用于前端、服务端和共享类型包。 | 当前主要开发语言。 |
| Vite | 前端开发服务器和打包工具，负责快速预览并生成网页静态文件。 | 开发时服务界面；桌面构建时生成 Tauri 加载的前端产物。 | 当前使用。 |
| Node.js 22 | 运行 JavaScript/TypeScript 服务端代码的环境。 | 运行本地 API、平台解析、任务编排和数据访问。 | 已增加按目标平台把 Node 运行时随桌面包提供的准备脚本；三端安装验收仍待完成。 |
| Fastify | Node.js 的 Web 服务框架，用来定义 API、校验请求并组织插件。 | 提供本机 HTTP/WebSocket API，连接前端与下载服务。 | 当前使用。 |
| SQLite | 单文件关系型数据库，不需要另起数据库服务器。 | 持久化设置、设备信息和下载任务快照；视频本身不放进数据库。 | 当前使用。 |
| Zod + shared | Zod 是运行时数据校验库；shared 是前后端共用的数据约定包。 | 约束任务、媒体、平台、账号等数据结构，尽早发现无效输入。 | 当前使用。 |
| FFmpeg | 常见的音视频处理工具。 | 按需合并音视频流、封装容器或转换音频格式。 | 支持从桌面资源目录、用户配置或 PATH 探测；发布构建需要提供固定版本和 SHA-256。 |
| yt-dlp | 可更新的媒体信息提取工具，覆盖多种网站。 | 作为部分平台适配路径的可选 extractor，由 mediaGrab 负责任务和结果管理。 | 支持从桌面资源目录、项目 `.venv`、用户配置或 PATH 探测；发布构建需要提供固定版本和 SHA-256。 |

## 为什么选 Tauri

mediaGrab 的核心界面天然适合用 Web 技术迭代，但目标产品又需要桌面窗口、本地文件和跨系统安装包。Tauri 让两者可以各做擅长的事：React 负责界面，Rust/Tauri 负责桌面宿主，并使用操作系统已有的 WebView 显示界面。

对这个项目而言，主要考虑是：

- 同一套 React 界面可以服务桌面应用和开发期 Web 页面，减少多端界面重复开发。
- Tauri 桌面包通常不需要为每个应用附带一整份 Chromium，安装包体积有机会更小；实际大小仍取决于应用附带的运行时和资源。
- Rust 宿主适合承接窗口生命周期、文件选择、通知、托盘和跨平台打包等本地能力。
- 桌面 shell 与媒体核心分离，平台解析规则不必塞进窗口层。

取舍也要说明：Tauri 并不会自动让程序跨平台构建。构建机仍需要目标系统的编译工具和 WebView/GTK 等依赖；macOS、Windows、Linux 的签名、安装包和原生依赖也不同。系统 WebView 可能带来渲染差异，需要实际多平台验收。Rust 本身也有学习成本。

因此这里选 Tauri，不是因为它“没有依赖”或“一次构建得到三端安装包”，而是它能让共享 Web UI 和原生桌面能力保持相对清晰的边界。

## 前端、服务端与媒体工具如何配合

1. 用户在 React 界面粘贴链接并选择媒体资源。
2. 界面通过本机 API 把请求交给 Fastify 服务；共享类型和 Zod schema 帮助两侧对齐输入输出。
3. 服务端根据平台路由到相应适配器，整理成通用媒体信息和任务状态。
4. 下载任务由本地服务管理，需要时调用 yt-dlp 获取媒体描述、调用 FFmpeg 做合并或转码。
5. SQLite 保存设置与任务状态，媒体文件写入用户选择的下载目录。
6. 桌面开发模式下 Tauri 窗口显示同一 Web UI；当前生产 bundle 还没有负责启动并分发 Node 服务及其工具。

## 当前实现与目标架构

**现在已经落地**：React/Vite UI、Node.js/Fastify 本地服务、SQLite 持久化、共享 TypeScript/Zod 契约、Tauri 2 桌面 shell，以及服务端调用媒体工具的代码路径。

**仍需完成**：为三平台固定并注入 FFmpeg/yt-dlp 二进制和许可证说明；完成三系统真实安装和端到端验收；补齐签名、升级和发行流程。详见[桌面媒体工具方案](./media-tools.md)、[路线图](./roadmap.md) 与 [技术设计](./tech-design.md)。

## 手动构建命令

在 macOS、Linux 或 Windows 的目标机器上打开仓库根目录，执行同一条命令：

```bash
pnpm install
pnpm build:desktop
```

当前配置通过 `apps/desktop/package.json` 中的 `tauri build` 调用 Tauri CLI，并在构建前执行 `pnpm build:web`。Tauri 配置的 bundle targets 为 `all`，也就是尝试构建当前系统所支持/配置的格式，而不是跨系统生成全部格式。

常见输出位置：

```text
apps/desktop/src-tauri/target/release/bundle/
```

| 系统 | 常见格式 |
| --- | --- |
| macOS | `.app`、`.dmg` |
| Windows | `.msi`、`.exe`（NSIS） |
| Linux | `.deb`、`.rpm`、`.AppImage` |

只构建指定格式的例子（macOS）：

```bash
pnpm --filter @mediagrab/desktop exec tauri build --bundles app,dmg
```

### 基础依赖

- **通用**：Node.js `>=22.5`、pnpm、稳定版 Rust（rustup）、系统原生 C/C++ 构建工具。
- **macOS**：Xcode Command Line Tools，可通过 `xcode-select --install` 安装。
- **Windows**：Microsoft C++ Build Tools 的“Desktop development with C++”组件、MSVC Rust 工具链、WebView2 Runtime。若 MSI 构建报 `light.exe` 错误，检查系统是否启用了 VBScript 可选功能。
- **Linux**：需安装发行版对应的 GTK/WebKitGTK 开发依赖和构建工具。Debian/Ubuntu 与其他发行版的包名不同，具体列表以 [Tauri 官方前置要求](https://v2.tauri.app/zh-cn/start/prerequisites/)为准。

首次克隆后请先安装 JavaScript 依赖；Rust/Tauri 构建还需要上述系统依赖。正式发行构建还需在目标系统 runner 上设置匹配目标平台的 Node 二进制，执行 `pnpm prepare:desktop-runtime`，为 FFmpeg/yt-dlp 设置固定 URL 和 SHA-256 后执行 `pnpm prepare:release-tools`，再运行 Tauri bundler。当前仍未完成三系统真实安装、签名及媒体工具许可证审查。

## 相关文档

- [README English](./README.md)
- [产品需求](./prd.md)
- [技术设计](./tech-design.md)
- [项目路线图](./roadmap.md)
- [风险与合规边界](./risk-control.md)
- [项目结构与开发规范](./project-structure-and-conventions.md)
- [桌面媒体工具方案](./media-tools.md)
