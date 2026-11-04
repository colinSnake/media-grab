# GitHub Actions 桌面构建

仓库提供 `.github/workflows/desktop-build.yml`，在对应系统的 GitHub runner 上构建桌面安装包，不需要在自己的电脑上安装 Windows 或 Linux。

## 触发构建

先把包含工作流和脚本的代码提交并推送到 GitHub 默认分支。然后打开仓库的 **Actions → Desktop builds → Run workflow**，选择要构建的分支并运行。

也可以通过 GitHub CLI 手动触发：

```bash
gh workflow run desktop-build.yml --ref main
gh run list --workflow desktop-build.yml
```

自动构建只在**推送分支时，推送后的最新一条提交信息包含 `build-ci-cd`** 才运行。示例：`git commit -m "build-ci-cd: 验证桌面安装包"`，再推送该分支。该标记只检查最新提交；一次推送多个提交时，请把标记放在最后一个。普通提交的工作流记录会显示为 skipped，不分配测试或打包 runner，也不会取消进行中的正式构建；这是 GitHub Actions 原生 `push` 不支持直接按提交信息过滤的限制。需要完全不产生普通推送的工作流记录时，只能采用纯手动触发等其他机制。

推送 `v*` 标签会自动构建并在四目标构建和安装后烟测全部通过后创建 Draft Release。版本标签必须与根目录 `package.json`、`apps/desktop/src-tauri/tauri.conf.json` 和 `apps/desktop/src-tauri/Cargo.toml` 的版本一致。例如，三个文件都是 `0.1.0` 时使用 `v0.1.0`。

分支构建只上传 Actions artifacts；标签构建额外创建 Draft Release，审核后再公开发布。无需配置个人访问令牌或额外 Secrets；发布作业使用 `GITHUB_TOKEN` 的 `contents: write` 和 `actions: read` 权限。

## 下载产物

构建完成后，进入该次运行页面，在 **Artifacts** 中下载需要的文件：

| Artifact 名称 | 运行环境 | 安装包 |
| --- | --- | --- |
| `MediaGrab-darwin-arm64` | macOS 15，Apple 芯片 | `.dmg` |
| `MediaGrab-darwin-x64` | macOS 15，Intel | `.dmg` |
| `MediaGrab-win32-x64` | Windows Server 2022 | NSIS `.exe` |
| `MediaGrab-linux-x64` | Ubuntu 22.04 | `.deb`、`.AppImage` |

每份安装包 artifact 还包含 `SHA256SUMS`、`build-info.json`、工具版本清单及许可证。对应的 `MediaGrab-<系统架构>-tool-sources` artifact 包含 FFmpeg/LAME 源码、构建日志和重新链接所需的构建目录。对外分发安装包时，同时保留并提供对应的工具源码和构建记录。

成功产物保留 30 天；失败诊断保留 7 天。需要长期保存时，请下载留存，或者在后续发行流程中上传到正式 Release。各平台互不取消，一组失败时其余组仍会继续。

## 发布既有成功构建

已有成功构建时，打开 **Actions → Publish existing desktop build → Run workflow**，选择 `main`，填写 `build_run_id` 和 `tag_name`。版本标签必须先存在，且指向该次构建的完整提交 SHA。

例如，`v0.1.0` 对应构建 `40686360439`、提交 `1bbee62f3956d595ca7831842d05809f085ce934`，其发布命令为：

```bash
gh workflow run publish-existing-build.yml --ref main \
  -f build_run_id=40686360439 \
  -f tag_name=v0.1.0
```

工作流会核对成功状态、源工作流名称、标签版本、构建 SHA 和四平台构建记录，检查原始 `SHA256SUMS`，再下载并上传产物。Release 只上传 4 个安装包：macOS arm64/x64 DMG、Windows x64 EXE 和 Linux x64 AppImage。Linux `.deb` 及媒体工具源码/构建记录不放入面向用户的 Release；工具源码和记录仍保留为 CI artifact。每个安装包的 SHA-256 由 GitHub Release 附件元数据提供。若同版本草稿已存在，可重跑补齐附件；已公开的 Release 不会被覆盖。历史 Actions artifacts 必须尚未过期。

执行成功后，在仓库 **Releases** 页面检查草稿与附件，再点击 **Publish release**；早期验收版本建议标记为预发布。后续新版本也可以直接推送匹配版本的 `v*` 标签，从检查和构建开始自动生成草稿。

## 构建过程

1. 在 Linux 上执行全工作区类型检查和测试，并检查版本号。
2. 各 runner 安装固定版本的 Node.js 和 pnpm，使用 lockfile 安装依赖。
3. 下载 `scripts/ci-media-tools.json` 中固定版本、SHA-256 的 yt-dlp、许可证，以及 FFmpeg/LAME 源码。
4. 使用 `scripts/build-release-ffmpeg.sh` 在当前系统编译精简 FFmpeg，保留视频/音频封装和 MP3 导出能力；不启用 GPL/nonfree 组件。
5. 准备随包 Node 服务、前端和媒体工具，再通过隔离目录中的实际服务启动与 API 请求检查资源是否完整。 pnpm 10 部署服务端依赖时显式使用 `deploy --legacy`，避免默认的 injected workspace packages 检查阻止独立 core 构建。
6. Tauri 构建原生安装包；Windows runner 静默安装 NSIS，Linux runner 安装 deb 并以 AppImage 的 extract-and-run 模式启动。烟测真实 GUI 应用能拉起本地 core，核对独立数据目录、随包 Node 与受保护的 loopback API（FFmpeg/yt-dlp 在安装前的隔离运行时步骤验证）；烟测结束由测试程序强制回收进程，不能替代应用正常退出生命周期验收；失败则本次构建失败。
7. 上传安装包、校验和与工具源码。

媒体工具缓存按 runner、架构及准备脚本内容隔离。命中缓存后仍会校验输入哈希、实际工具版本和运行时；修改工具版本或构建脚本会自动更换缓存。首次运行需要从源码编译 FFmpeg，通常会明显慢于缓存命中的后续运行，实际耗时取决于 runner 和下载速度。

现有本地 `pnpm run build:desktop:release` 保持可用；本地 `.release-tools` 不会被提交，CI 会自行生成对应目录。

## 更新工具版本

编辑 `scripts/ci-media-tools.json`，同时更新版本号、下载地址及 SHA-256。yt-dlp 的三种可执行文件需要分别校验，两个 macOS 架构共用官方通用二进制；许可证也按版本固定并校验。FFmpeg 和 LAME 使用源码档案的哈希；各系统编译出的 FFmpeg 哈希会在构建时记录到工具清单。

更新 Node 或 pnpm 时，修改 workflow 顶部的 `NODE_VERSION`、`PNPM_VERSION`。应用版本更新需要同步修改上述三个版本文件。

## 当前范围

目前生成未经发行证书签名、未经 Apple 公证的测试安装包。macOS 或 Windows 可能显示系统安全提示；正式公开发行需要另外接入证书签名和公证。

当前包含 Windows/Linux x64 和 macOS 两种架构，不包含 Windows/Linux ARM64。Linux 产物以 Ubuntu 22.04 的构建环境为基线，仍需在计划支持的发行版上验证安装和运行。各系统的真实下载与安装验收需要在对应系统完成。

> 安装后烟测仅证明相应 CI runner 上的打包程序可以启动，不等同于 Windows/Linux 多发行版、多桌面环境的人工验收；AppImage 烟测使用 extract-and-run，不覆盖 FUSE 挂载路径。首次启用需要实际运行 workflow 并检查失败日志，不应仅凭脚本合入标记安装验收完成。

## 视频超分资源（2026-11-03 增量）

超分源码不依赖另一项目的绝对路径；开发工具只能显式配置 `MEDIAGRAB_UPSCALE_DIR`。发行资源定位到现有 `resources/media-tools/<target>/upscale/`，沿用现有 Tauri 资源目录，不增加独立 App。`pnpm build:server` 同时复制 `dist/upscale/supervise.mjs`；生产依赖准备必须保留该文件和内置 Node，它用于父核心异常退出后的工具进程回收。

- `pnpm prepare:upscale-tools --development`：仅复制显式指定的本机工具/模型到被忽略的 `.release-tools/upscale-dev/`，不下载；该 manifest 标记 `developmentOnly`，不可用于发行。
- 发行准备需显式 `UPSCALER_SOURCE_DIR`、`UPSCALER_FFMPEG`、`UPSCALER_FFPROBE`、`UPSCALER_LICENSE_DIR`、`UPSCALER_REVIEW_MANIFEST`，可设 `UPSCALER_SIGN_IDENTITY` 对复制品签名。来源审查清单须给出引擎/权重/FFmpeg/FFprobe 来源、全部输入 SHA-256 和 `redistributionReviewed: true`；不能只把本项目 MIT 当作依赖许可。脚本拒绝覆盖已有 manifest。
- 必备声明文件：`Real-ESRGAN-LICENSE.txt`、`Real-ESRGAN-ncnn-vulkan-LICENSE.txt`、`FFmpeg-LICENSE.txt`、`THIRD_PARTY_NOTICES.txt`。后者必须包含实际构建涉及的 ncnn、Vulkan/MoltenVK、编解码库等许可和来源，而非空模板。FFmpeg 若启用 libx264，必须按该实际构建的许可及对应源码义务处理；不要沿用旧“仅音频 FFmpeg”的声明推定完整视频构建可分发。
- `pnpm verify:upscale-tools` 对未准备资源仅报告不可用，不伪装为验证成功。`build:desktop:release` 在 macOS arm64 上要求完整资源、已审查 provenance、架构/哈希/版本/编码能力和可执行程序签名；缺少则失败。其它平台明确不支持超分，而不阻断现有下载包。
- `pnpm verify:upscale-tools --app /绝对路径/MediaGrab.app --require-signatures` 可对实际 `.app` 使用其内置 Node/核心验证嵌套资源、能力和签名，不启动 GUI 或推理；只有布局单测不等于真实安装包验证。开发人工验收使用 `pnpm verify:upscale-dev` 后由测试者手动执行 `pnpm dev:desktop:upscale`，该入口隔离数据库/设置、拒绝占用端口且不清理其它进程。步骤见 [视频超分开发版测试指南](./视频超分测试指南.md)。
- 普通 `build:desktop` 可构建无超分资源的受限包，但页面会报不可用；不能在发布说明称已具备超分。构建安装器前仍须先按根 AGENTS.md 把旧安装器移到废纸篓；保留 Rust 缓存。

本轮仅源码/原生编译与隔离引擎测试；没有执行安装包、安装、启动、重启或签名后离线 GUI 测试。再分发工具链尚未准备完整，严格发行检查应失败，而不是跳过后声称完成。
