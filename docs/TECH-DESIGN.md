# mediaGrab 技术设计

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.0 |
| 架构目标 | 跨平台桌面应用 + 可替换平台适配器 + 可恢复下载任务 |
| 当前过渡实现 | React/Vite + Node/Fastify + SQLite |
| 目标实现 | Tauri 2 + React/Vite + Rust core + SQLite |

## 1. 选型结论

### Tauri 2 作为桌面壳

Tauri 的职责只包括窗口生命周期、菜单、托盘、通知、文件选择、应用目录、系统权限和安装包。它不承载平台解析规则，也不让 React 直接操作任意文件路径。

### Rust core 作为长期运行时

下载器需要高并发 I/O、取消、断点、子进程、文件锁和跨平台发布。Rust core 将这些能力集中起来，并向 UI 暴露稳定的命令和事件。平台适配器是 trait/接口实现，新增平台不需要改 UI。

### 当前 Node 服务作为迁移层

仓库已有 B 站 WBI、设备指纹、请求限速、解析和 SQLite 测试。先把它包装成 `BilibiliAdapter`，让 UI 通过通用 media API 消费；Rust core 完成后再迁移下载编排和平台请求，避免同时重写所有已验证逻辑。

### FFmpeg 作为外部媒体工具

合并和转码不在 UI 中实现。应用启动时探测内置或用户指定的 FFmpeg，任务执行使用参数数组和明确的工作目录，禁止 shell 拼接。

### yt-dlp 作为可选平台 extractor

抖音和小红书的网页结构、短链跳转和媒体格式经常变化，不把第三方站点的逆向细节复制到 mediaGrab 核心。adapter 通过 `yt-dlp --dump-single-json --no-playlist --skip-download` 获取统一媒体描述，再转换为 `MediaParseResult`。yt-dlp 只负责解析和给出用户有权访问的媒体地址，下载任务、文件安全、FFmpeg 和权限提示仍由 mediaGrab 控制。

## 2. 目标架构

```text
React UI
  -> Tauri bridge / app commands
  -> Rust application core
     -> platform registry: Bilibili / Douyin / Xiaohongshu / future
     -> media normalizer
     -> download orchestrator
     -> ffmpeg runner
     -> task repository / event bus
  -> SQLite + platform HTTP/CDN
```

桌面壳负责窗口、文件系统、通知、托盘和更新；UI 只消费领域模型；平台请求全部经过 adapter；下载器不认识具体平台字段。

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

apps/server/src/        过渡期 Node runtime
├─ platform/bilibili/   由当前 bili/ 迁移而来
├─ application/         通用解析、任务与错误编排
├─ routes/              HTTP 兼容层
└─ store/               SQLite 持久化

apps/desktop/src-tauri/ 目标桌面 runtime
├─ commands/             UI 命令边界
├─ core/                 任务、解析、下载和事件
├─ adapters/             平台实现
└─ system/               文件、通知、托盘、更新
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

过渡期 HTTP API 与目标 Tauri command 使用同一份 shared schema：

| 能力 | 过渡期 | 目标 |
| --- | --- | --- |
| 健康检查 | `GET /api/health` | `get_runtime_status` |
| 解析链接 | `POST /api/parse` | `resolve_media` |
| 读取流选项 | `POST /api/playurl` | `get_stream_options` |
| 创建任务 | `POST /api/tasks` | `create_download_task` |
| 任务快照 | `GET /api/tasks` | `list_tasks` |
| 取消/重试 | `/api/tasks/:id/*` | `cancel_task` / `retry_task` |
| 实时事件 | WebSocket `/api/ws` | Tauri event channel |
| 配置 | `GET/PATCH /api/config` | `get_settings` / `update_settings` |
| 平台能力 | `GET /api/platforms` | `get_platform_status` |

## 7. 数据模型

SQLite 至少包含 `settings`、`platform_state`、`tasks` 和 `history` 四类数据。媒体文件不进数据库。

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
| 桌面壳 | Tauri 2 | 三端、原生能力、较小运行时、Rust core 复用 |
| UI | React + Vite | 现有代码可延续，适合工作台型界面 |
| 核心 | Rust workspace | 下载、文件、子进程和跨平台分发需要强边界 |
| 存储 | SQLite | 单机任务可靠、查询简单、无需服务端 |
| 实时通信 | WebSocket / Tauri event | 任务状态天然是事件，UI 断线时回退快照轮询 |
| 兼容层 | Node/Fastify 保留至 D3 | 保护当前 B 站验证成果，降低一次性重写风险 |
| 抖音/小红书 extractor | yt-dlp bridge | 平台变动集中在成熟 extractor，产品核心保持稳定 |

## 10. 迁移规则

1. 先统一 UI 领域模型和 API 命名，再迁移实现；不让新功能继续调用 `bili/*` 专用类型。
2. 每接入一个平台，必须提供 URL 识别、详情、资源选项、权限错误和最小 fixture 测试。
3. Rust core 接管任务后，Node 只作为开发期 adapter host；桌面发行版不依赖用户安装 Node。
4. 迁移完成后移除 Fastify 静态托管和 B 站专用产品文案，但保留平台适配器的测试与风控规则。
