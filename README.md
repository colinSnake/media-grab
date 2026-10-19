# mediaGrab

mediaGrab 是一个面向 macOS、Windows 和 Linux 的本地媒体工作台：粘贴抖音、小红书、B 站等平台的链接，解析媒体信息，选择视频或音频产物，然后下载到本机。平台能力通过适配器扩展，产品层不绑定某一个站点。

## 当前定位

- **本地优先**：所有任务、历史、配置和下载文件保存在用户自己的设备上。
- **多平台**：首批覆盖 B 站、抖音、小红书；后续通过平台适配器增加其他来源。
- **视频与音频分离**：支持视频+音频合并、仅视频、仅音频，以及音频格式转换。
- **跨平台桌面应用**：统一 React UI，macOS / Windows / Linux 使用同一套产品体验。
- **如实反馈**：平台权限、清晰度、登录要求、链接过期和风控失败都在 UI 中明确呈现，不静默降级。

## 设计原则

1. **产品层与平台层隔离**：UI 只消费统一的 `MediaItem`、`StreamOption`、`DownloadTask`，不直接知道 B 站 WBI、抖音签名等细节。
2. **桌面壳与核心引擎隔离**：桌面壳负责窗口、文件选择、通知和打包；解析和下载核心可独立测试、独立运行。
3. **默认免登录，登录是能力增强**：只使用用户自己有权限访问的内容，不注入他人 Cookie，不绕过付费、区域限制或 DRM。
4. **小步迁移**：现有 B 站解析链路作为第一个平台适配器保留，逐步迁移到通用接口，不把已验证的网络细节扩散到产品 API。

## 技术基线

| 层 | 选择 | 责任 |
| --- | --- | --- |
| Desktop | Tauri 2 + Rust | 窗口、系统菜单、文件对话框、通知、托盘、签名与安装包 |
| UI | React 19 + TypeScript + Vite | 解析工作台、任务中心、设置、状态反馈 |
| Core API（过渡期） | Node.js 22 + Fastify | 复用当前服务端、统一 API、SQLite、B 站适配器 |
| Core API（目标） | Rust workspace | 平台适配器、下载编排、FFmpeg 进程管理、跨平台分发 |
| 数据 | SQLite | 配置、解析缓存、任务快照、历史；媒体文件不进数据库 |
| 媒体处理 | FFmpeg | 合并、remux、音频转码；使用参数数组启动，不经 shell |
| 平台 extractor | yt-dlp（可选） | 抖音、小红书等平台的格式提取；不把平台私有签名写入产品核心 |
| 类型契约 | Zod + shared types | UI / API 的输入输出校验与状态模型 |

Tauri 的选择是产品目标下的工程决策：三端发布、低资源占用、原生文件系统能力和 Rust 生态更适合本地下载器。Electron 仍可作为备选，但不作为当前主线。详见 [技术设计](./docs/TECH-DESIGN.md)。

## 工作区

```text
mediaGrab/
├─ apps/
│  ├─ web/                 React UI；当前由 Fastify 静态托管
│  ├─ server/              迁移期 Node 服务与 B 站适配器
│  └─ desktop/             目标 Tauri 桌面壳（按路线图接入）
├─ packages/
│  ├─ shared/              API、任务、媒体和平台无关类型
│  └─ core-contracts/      目标 Rust core 与 UI 的稳定契约（规划中）
├─ docs/                   产品、架构、风险和路线图
└─ data/                   本地运行数据（gitignored）
```

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev:server
pnpm dev:web
pnpm dev:desktop
```

当前迁移期的 Web 入口是 `http://127.0.0.1:8787`。桌面安装包尚未进入仓库，按 [ROADMAP](./docs/ROADMAP.md) 的 D1 里程碑接入。

网页版开发入口是 `http://localhost:5173`：先运行 `pnpm dev:server`，再运行 `pnpm dev:web`。生产构建后由本地核心服务直接托管，访问 `http://127.0.0.1:8787` 即可。

### 账号与画质

打开网页版的“设置”，在“B站账号”区域粘贴用户自己账号的 Cookie。mediaGrab 只保留必要的 B站登录字段，并在本机使用 AES-256-GCM 加密保存；页面、任务记录和日志都不会显示完整 Cookie。账号验证成功后，解析接口会使用当前账号请求 B站资源，并只把 B站实际交付的清晰度标为可下载。账号删除会同时删除本机凭据。

当前第一阶段支持 B站账号导入、验证、切换和删除；抖音、小红书账号管理会沿用同一平台隔离模型，待对应授权方式接入后开放。

`pnpm dev:desktop` 会启动 Tauri 窗口、Vite UI 和本地 Node core。当前安装包已经能生成 macOS `.app` / `.dmg`，但发行版还需要 D2 把 Node core、FFmpeg 和 yt-dlp 一并封装，避免用户手动安装运行时。

抖音和小红书 adapter 通过可选的 `yt-dlp` 可执行文件工作。未安装命令行入口但 Python module 可用时，mediaGrab 会自动尝试 `python3 -m yt_dlp`。未安装时，B 站功能不受影响；对应平台会返回明确的 extractor 缺失提示。可以通过 `ytDlpPath` 配置自定义路径。

开发环境如需启用这两个平台：

```bash
python3 -m pip install -U yt-dlp
yt-dlp --version
```

桌面发行版阶段会把 extractor 纳入应用运行时，不要求用户单独配置 Python。

平台能力和 extractor 状态可通过 `GET /api/platforms` 查看；任务状态通过 `/api/ws` 推送，浏览器断线时自动回退到快照轮询。

## 文档

- [PRD](./docs/PRD.md)：产品范围、用户流程和验收标准。
- [技术设计](./docs/TECH-DESIGN.md)：目标架构、技术栈、模块边界、数据模型和迁移策略。
- [风险与合规](./docs/RISK-CONTROL.md)：平台接入边界、凭据、版权和风控规则。
- [路线图](./docs/ROADMAP.md)：从当前 B 站适配器到三端桌面版本的交付顺序。

## 使用边界

mediaGrab 只用于下载用户有权访问和保存的内容。请遵守各平台服务条款、版权法规和内容授权要求。项目不提供账号池、共享 Cookie、付费内容绕过、去水印或 DRM 破解能力，也不建议把本地服务暴露到公网。
