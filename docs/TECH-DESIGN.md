# mediaGrab 技术设计

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.0 |
| 架构目标 | 跨平台桌面应用 + 可替换平台适配器 + 可恢复下载任务 |
| 当前实现 | Tauri 2 + React/Vite + Node/Fastify + SQLite |
| 桌面目标 | Tauri 管理桌面窗口与原生能力；Node/Fastify 继续提供本地业务 API |

## 1. 选型结论

### Tauri 2 作为桌面壳

Tauri 的职责只包括窗口生命周期、菜单、托盘、通知、文件选择、应用目录、系统权限和安装包。它不承载平台解析规则，也不让 React 直接操作任意文件路径。

### Node/Fastify 作为本地业务核心

Node/Fastify 统一负责 Web 与桌面版共用的解析、下载任务、平台适配、HTTP/WebSocket API 和 SQLite 数据访问。桌面发行版需要随应用提供 Node 运行时和服务端依赖，用户不应被要求另行安装 Node。Rust 仅用于 Tauri 桌面宿主及必要的原生系统集成；当前没有把业务核心迁移到 Rust 的计划。

### FFmpeg 作为外部媒体工具

合并和转码不在 UI 中实现。应用启动时探测内置或用户指定的 FFmpeg，任务执行使用参数数组和明确的工作目录，禁止 shell 拼接。

### yt-dlp 作为可选平台 extractor

抖音和小红书的网页结构、短链跳转和媒体格式经常变化，不把第三方站点的逆向细节复制到 mediaGrab 核心。adapter 通过 `yt-dlp --dump-single-json --no-playlist --skip-download` 获取统一媒体描述，再转换为 `MediaParseResult`。yt-dlp 只负责解析和给出用户有权访问的媒体地址，下载任务、文件安全、FFmpeg 和权限提示仍由 mediaGrab 控制。

## 2. 目标架构

```text
React UI
  -> local HTTP/WebSocket API
  -> Node.js + Fastify application core
     -> platform registry: Bilibili / Douyin / Xiaohongshu / future
     -> media normalizer and download orchestrator
     -> FFmpeg / yt-dlp processes
     -> task repository / event bus
  -> SQLite + platform HTTP/CDN

Tauri 2 + Rust desktop shell
  -> owns the app window and native desktop integrations
  -> starts and supervises the bundled local Node service in desktop builds
```

桌面壳负责窗口及原生系统集成；Node/Fastify 负责业务 API；UI 只消费统一领域模型；平台请求全部经过 adapter；下载器不认识具体平台字段。

## 3. 稳定的领域模型

UI 和平台代码之间只允许使用以下平台无关概念：

- `Platform`: `bilibili | douyin | xiaohongshu | unknown`。
- `MediaItem`: 标题、作者、封面、时长、分集、来源平台和规范化 ID。
- `StreamOption`: 视频/音频流、编码、分辨率、音质、容器、大小、权限状态和临时 URL 引用。
- `DownloadTask`: 输入、选项、阶段、累计字节、速度、目标路径、重试次数和错误。
- `TaskEvent`: `created | progress | phase-changed | completed | failed | cancelled | recoverable`。

平台适配器内部可以保留 B 站的 `bvid`、`cid`、WBI 和请求头，但这些字段不得泄露到 UI 的通用组件中。

## 4. 模块边界

```text
apps/web/src/
├─ app/                 路由、全局状态、命令客户端
├─ features/workbench/  输入与解析结果
├─ features/tasks/      任务队列与历史
├─ features/settings/   设置与诊断
└─ ui/                  无业务的布局、按钮、状态和表格

apps/server/src/        Node/Fastify 本地业务核心（Web 与桌面共用）
├─ bili/                B 站协议与请求实现
├─ platform/            平台 registry 与 extractor adapter
├─ download/            通用下载任务编排
├─ routes/              HTTP/WebSocket API
└─ store/               SQLite 持久化

apps/desktop/src-tauri/ Tauri/Rust 桌面宿主
├─ app lifecycle         窗口和应用生命周期
└─ native integrations  文件选择、通知、托盘等系统能力
```

## 5. 下载任务设计

下载采用临时目录和最终原子移动：

```text
<data>/tasks/<task-id>/
├─ manifest.json          输入、选项、流引用、重试和阶段
├─ video.part             可续传视频流
├─ audio.part             可续传音频流
├─ output.tmp             合并或转码中的文件
└─ task.log               脱敏诊断日志
```

任务状态：`queued -> resolving -> downloading -> processing -> completed`，异常路径为 `paused | failed | cancelled`。数据库写入状态先于 UI 事件广播；事件丢失时 UI 可通过查询恢复。

视频+音频、仅视频、仅音频共享同一下载器，只在流选择和后处理阶段分叉：

| 产物 | 处理 |
| --- | --- |
| 视频+音频 | 下载两条流，FFmpeg `-c copy` 合并并 `faststart` |
| 仅视频 | 下载视频流，remux 到目标容器 |
| 仅音频 m4a | 下载音频流，零转码落盘 |
| 仅音频 mp3 | 下载音频流，FFmpeg 转码 |

## 6. API / 命令契约

Web 与桌面 UI 使用同一套本地 HTTP API 和 shared schema。Tauri command 仅用于需要原生桌面能力的操作，不复制业务 API：

| 能力 | 业务 API |
| --- | --- |
| 健康检查 | `GET /api/health` |
| 解析链接 | `POST /api/parse`、`POST /api/media/parse` |
| 创建/管理任务 | `/api/tasks` 及对应操作路由 |
| 实时事件 | WebSocket `/api/ws` |
| 配置与平台能力 | `/api/config`、`/api/platforms` |

## 7. 数据模型

SQLite 至少包含 `settings`、`platform_state`、`tasks` 三类数据。下载队列和历史记录不是两份任务数据：`tasks` 中的快照按 `status` 区分进行中任务和终态任务，媒体文件不进数据库。具体规则见 [项目结构与开发规范](./project-structure-and-conventions.md)。

数据库位置必须使用系统应用数据目录：macOS `Application Support`、Windows `AppData/Local`、Linux `XDG_DATA_HOME`，不再默认写入仓库目录。

## 8. 测试与可观测性

- shared：schema、平台识别、任务状态机、文件名清理、错误分类。
- adapter：每个平台使用录制 fixture / Mock HTTP，不在 CI 访问真实平台。
- downloader：断点、取消、重试、临时文件清理、原子移动、FFmpeg 失败。
- UI：解析成功、空状态、失败、长标题、窄窗口和深色模式。
- E2E：三端分别验证文件对话框、通知、托盘和安装包启动。

日志默认只保留本地诊断所需的最小信息；Cookie、签名参数、完整 URL 查询串和令牌必须脱敏。

## 9. 架构决策

| 决策 | 结论 | 原因 |
| --- | --- | --- |
| 桌面壳 | Tauri 2 | 三端桌面窗口与原生系统集成 |
| UI | React + Vite | 现有代码可延续，适合工作台型界面 |
| 业务核心 | Node.js + Fastify | Web 与桌面共用实现，复用现有平台和任务能力 |
| 存储 | SQLite | 单机任务可靠、查询简单、无需服务端 |
| 实时通信 | WebSocket | Web 与桌面共用事件契约，断线时回退快照轮询 |
| 抖音/小红书 extractor | yt-dlp bridge | 平台变动集中在成熟 extractor，产品核心保持稳定 |

## 10. 桌面运行规则

1. Web 与桌面继续共用 Node/Fastify 业务核心和领域模型。
2. 桌面发行包提供匹配目标平台的 Node 运行时及服务端生产依赖；不要求用户自行安装 Node。
3. Tauri/Rust 负责宿主生命周期和原生系统操作，不复制解析、任务、平台 adapter 或数据库业务逻辑。
4. 每接入一个平台，必须提供 URL 识别、详情、资源选项、权限错误和最小 fixture 测试。
