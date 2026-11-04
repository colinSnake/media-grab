# 仓库协作规范

## 本地构建存储

- 每次执行桌面安装包构建（`pnpm build:desktop` 或 `pnpm build:desktop:release`）前，先移除 `apps/desktop/src-tauri/target/release/bundle/` 中上一次生成的安装包，避免将旧安装包误认为本次构建产物。
- 常规构建时保留 Rust/Tauri 编译缓存。不要为了替换安装包而清空整个 `target/` 目录，以免触发耗时的完整重编译。
- 开始大型构建前，检查 `apps/desktop/src-tauri/target/`、`.release-tools/`、`artifacts/`、依赖和构建输出目录（`node_modules/`、`**/dist/`）中是否有超过 30 天且不再需要的本地构建缓存。保留近期或仍在使用的内容；任何可能删除用户需要的安装包或发布产物的清理，都必须先说明。
- 将 `data/`、`download/`、`apps/server/download/`、凭据、数据库，以及 `apps/desktop/src-tauri/resources/core/` 和 `apps/desktop/src-tauri/resources/media-tools/` 中暂存的运行时资源视为用户数据或必需的运行输入，不得作为日常构建清理对象删除。
- 如系统提供废纸篓或回收站，清理时优先使用。避免宽泛的破坏性清理命令；只操作明确需要清理的路径。

## Git 提交

- 提交标题必须使用格式：`<type>(<scope>): <中文祈使说明>`。`type` 和 `scope` 使用英文；说明使用中文祈使句，明确表达本次提交要完成的动作。
- 提交正文使用中文。需要补充背景、实现要点或验证信息时写在正文中；不需要补充时可以省略正文。
- 每次提交只包含一个逻辑目的。若改动涉及多个彼此独立的目的，应拆分为多个提交，避免把无关改动混在一起。
- 验证结果必须如实报告，只能写实际执行并观察到的结果。没有运行的测试或检查不得声称通过；遇到失败、跳过或环境限制时，应明确说明。
