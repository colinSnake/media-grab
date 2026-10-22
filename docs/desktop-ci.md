# GitHub Actions 桌面构建

仓库提供 `.github/workflows/desktop-build.yml`，在对应系统的 GitHub runner 上构建桌面安装包，不需要在自己的电脑上安装 Windows 或 Linux。

## 触发构建

先把包含工作流和脚本的代码提交并推送到 GitHub 默认分支。然后打开仓库的 **Actions → Desktop builds → Run workflow**，选择要构建的分支并运行。

也可以通过 GitHub CLI 手动触发：

```bash
gh workflow run desktop-build.yml --ref main
gh run list --workflow desktop-build.yml
```

推送 `v*` 版本标签也会触发构建。标签必须与根目录 `package.json`、`apps/desktop/src-tauri/tauri.conf.json` 和 `apps/desktop/src-tauri/Cargo.toml` 的版本一致。例如，三个文件都是 `0.1.0` 时使用 `v0.1.0`。

工作流只生成并上传 Actions artifacts，不创建 GitHub Release，也不公开发布安装包。无需配置个人访问令牌或额外 Secrets；工作流的 `GITHUB_TOKEN` 只需要读取仓库权限。

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

## 构建过程

1. 在 Linux 上执行全工作区类型检查和测试，并检查版本号。
2. 各 runner 安装固定版本的 Node.js 和 pnpm，使用 lockfile 安装依赖。
3. 下载 `scripts/ci-media-tools.json` 中固定版本、SHA-256 的 yt-dlp、许可证，以及 FFmpeg/LAME 源码。
4. 使用 `scripts/build-release-ffmpeg.sh` 在当前系统编译精简 FFmpeg，保留视频/音频封装和 MP3 导出能力；不启用 GPL/nonfree 组件。
5. 准备随包 Node 服务、前端和媒体工具，再通过隔离目录中的实际服务启动与 API 请求检查资源是否完整。
6. Tauri 构建原生安装包，并上传安装包、校验和与工具源码。

媒体工具缓存按 runner、架构及准备脚本内容隔离。命中缓存后仍会校验输入哈希、实际工具版本和运行时；修改工具版本或构建脚本会自动更换缓存。首次运行需要从源码编译 FFmpeg，通常会明显慢于缓存命中的后续运行，实际耗时取决于 runner 和下载速度。

现有本地 `pnpm run build:desktop:release` 保持可用；本地 `.release-tools` 不会被提交，CI 会自行生成对应目录。

## 更新工具版本

编辑 `scripts/ci-media-tools.json`，同时更新版本号、下载地址及 SHA-256。yt-dlp 的三种可执行文件需要分别校验，两个 macOS 架构共用官方通用二进制；许可证也按版本固定并校验。FFmpeg 和 LAME 使用源码档案的哈希；各系统编译出的 FFmpeg 哈希会在构建时记录到工具清单。

更新 Node 或 pnpm 时，修改 workflow 顶部的 `NODE_VERSION`、`PNPM_VERSION`。应用版本更新需要同步修改上述三个版本文件。

## 当前范围

目前生成未经发行证书签名、未经 Apple 公证的测试安装包。macOS 或 Windows 可能显示系统安全提示；正式公开发行需要另外接入证书签名和公证。

当前包含 Windows/Linux x64 和 macOS 两种架构，不包含 Windows/Linux ARM64。Linux 产物以 Ubuntu 22.04 的构建环境为基线，仍需在计划支持的发行版上验证安装和运行。各系统的真实下载与安装验收需要在对应系统完成。
