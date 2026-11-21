# 远程 Linux 验证

从仓库根目录运行统一入口。脚本只使用现有 Instabox 实例，不创建、销毁或关闭机器，不发布包、镜像或端口。

```powershell
pwsh -NoProfile -File ./scripts/remote-check.ps1 -Task test -Target linux -Scope linux-resources -Machine linux-01
pwsh -NoProfile -File ./scripts/remote-check.ps1 -Task test -Target linux -Scope review -Machine linux-01
pwsh -NoProfile -File ./scripts/remote-check.ps1 -Task build -Target linux -Machine linux-01
```

挂起实例必须显式添加 `-ResumeMachine`。省略 `-Machine` 时仅在名称可识别的 Linux 实例恰好为一个时自动选择；否则列出最小实例元数据并停止。认证失败、实例离线或工具缺失不会切换平台。项目没有 Android APK，因此 `-Target android14` 和 `-Task install` 会明确拒绝。

## CLI 与认证

优先使用 PATH 中的 `instabox.exe`，也可指定 `-CliPath`。当前 Windows 项目内 CLI 默认位置为 `.artifacts/tools/instabox/0.8.309/package/cli/instabox-windows-amd64.exe`。这是官方 npm `instabox@0.8.309` 归档内的原生 CLI；本次引导下载按 npm 元数据 SHA512 校验，未全局安装、未执行 npm 生命周期脚本。

CLI 自行读取 `INSTABOX_API_KEY` 或已有登录会话。脚本不读取配置文件、不打印密钥、不在参数中传递密钥，也不会把本地环境变量复制到远程。远程任务使用明确列出的隔离环境启动。

## 范围

- `-Task test -Scope review`（默认）：core 的 Codex 回归、CLI 专用修复回归及认证、widget 日期/统计、site 初始化/迁移与 PGlite 回滚验证。
- `-Task test -Scope full`：各包完整测试套件；CLI 采用其原配置，但 Node 文件系统清理由隔离回收拦截器处理。测试仍可能有既有失败，不预先宣称通过。
- `-Task build`：core、Web、CLI、site 生产构建，以及 widget renderer 和类型检查。Linux 构建不等同于 Electron GUI 或 Electron 原生 ABI 验证。
- `-Scope linux-resources`：仅确认 Linux、工具链、内存、磁盘及 inode 情况，不上传源码。

源码来源是 Git 跟踪文件及未忽略的新文件，经额外 allowlist/denylist 筛选。环境文件（包括 `.env.example`）、认证配置、私钥、数据库、备份、依赖、编译产物和 Vite 临时文件不上传。链接和硬链接未经审查不打包。每个源码文件记录 SHA256，源归档也计算 SHA256；远程先验证归档再逐文件验证 manifest。

每次运行位于 `/data/home/aiusage-check/<runId>/`，先检查目录所有权和链接。依赖采用锁文件与 pnpm 9.15.0，禁止安装生命周期脚本，使用独立 store/cache/home/tmp。Node SQLite 使用匹配远程 Node ABI 的官方预编译绑定，不在安卓环境编译源码。构建/测试产生的 Node 文件清理改为运行目录内的回收移动；遇到外部目录或链接清理会失败。不会清理其他任务数据。

首次安装前要求持久目录至少有 5 GiB 可用空间，复用已有依赖前要求至少有 256 MiB。不足时在上传前失败，不自动清理或扩容。pnpm 归档校验固定 SHA512；下载归档解包前检查路径和链接，SQLite 归档记录 SHA256。

## 后台任务与证据

执行器使用 `exec --background`，每 20 秒等待一次，直到最终退出。默认总等待 30 分钟，可用 `-TimeoutMinutes` 调整。等待超时返回 124，保留远程任务和 jobId；不会自动重新下发写入任务。续跑时参数必须与原任务一致：

```powershell
pwsh -NoProfile -File ./scripts/remote-check.ps1 -Task test -Target linux -Scope review -ResumeRunId <runId>
```

需要修改源码后重新验证时，可对已结束、依赖安装成功且锁文件未变的任务使用 `-ReuseRunId <runId>`。它与 `-ResumeRunId` 不同：前者提交新任务并使用新 runId，后者只等待/回收原任务。复用时先校验源清单和锁文件，把原源码移动到远程 `previous-<newRunId>/`，保留 node_modules，报告写到独立 `attempts/<newRunId>/`。同一远程运行目录使用排他锁；不允许同时复用。

每次运行的本地证据位于 `.artifacts/remote-check/<runId>/`：

- `summary.json`：本地状态、命令参数、jobId、最终远程退出码、失败阶段、测试统计。
- `source-manifest.json`、`source.tar.gz`：本次实际上传输入及哈希。
- `resources.json`：资源探测结果。
- `remote-summary.json`、`remote.log`：远程步骤和整体结果。
- `<step>.log`、`<package>-tests.json`：分项日志与测试报告。

成功要求远程进程退出 0、远程 summary 明确 passed，测试报告完整且存在测试。仅成功提交后台任务不算通过。源码打包、传输/网络、依赖准备、远程构建、单测失败和等待超时分别记录。报告逐文件下载，不使用 CLI 的大目录临时打包/删除流程。

实例继续使用其已有的自动挂起策略。失败运行和回收文件保留，不执行任何实例删除、关机或物理文件清理命令；后续空间不足需单独处理这些已明确的运行目录。

## 2026-11-19 实际验收

环境：现有 `linux-01`，Linux x86_64，Node 22.23.3，约 8 GiB 内存。脚手架通过 `-ResumeMachine` 恢复了原挂起实例，没有创建机器；所有远程调用均经本入口。

| 命令 | 最终结果 | 本地证据目录 |
| --- | --- | --- |
| `pwsh -NoProfile -File ./scripts/remote-check.ps1 -Task test -Target linux -Scope review -Machine linux-01 -ReuseRunId 20261119T130504Z-9651806a` | 本地/远程 exit 0；82/82，失败 0，跳过 0 | `.artifacts/remote-check/20261119T131143Z-e39885dc/` |
| `pwsh -NoProfile -File ./scripts/remote-check.ps1 -Task build -Target linux -Scope review -Machine linux-01 -ReuseRunId 20261119T131143Z-e39885dc` | 本地/远程 exit 0；6 个构建步骤通过；此命令不运行测试 | `.artifacts/remote-check/20261119T131513Z-82c2f8c5/` |
| `node --test scripts/remote-check-package.test.mjs` | exit 0；5/5 | 本轮本机命令输出 |

82 项包含 core 21、CLI 31、widget 18、site 12。构建步骤为 core、Web、CLI、site 生产构建、widget renderer 构建及 TypeScript 检查。源码清单逐文件哈希验证成功，后台任务最终退出、JSON 测试报告及逐项日志均已回收。首次完整依赖安装成功收据位于 `20261119T125425Z-fb590d8d`，后续重试校验锁文件和 Node 版本后复用依赖。

调试过程中保留了真实失败证据：最初 `/data` 根目录无写入权限，已改为当前用户拥有的持久目录；一次 `/tmp` 安装因 4 GiB tmpfs 耗尽返回 `ERR_PNPM_ENOSPC`（`20261119T124920Z-7651a0e6/install.log`）；widget 首次因 Vitest 2 的 worker 默认配置未收集测试，显式设置 `--minWorkers=1 --maxWorkers=2` 后通过。失败任务未被标为通过；没有物理删除失败目录。该 `/tmp/aiusage-check/20261119T124920Z-7651a0e6` 仍保留，后续任务使用独立持久 tmp，不使用已满的系统 tmpfs。

只读 review 已覆盖打包、实例选择、运行目录、依赖引导、续跑/复用、结果判定和回收边界，并补齐排他锁、归档检查、未知任务状态保护与磁盘前置检查。本次未运行 `-Scope full`，未执行 GitHub Actions、容器发布、Linux Electron GUI 或独立 PostgreSQL 多实例锁竞争；site 的数据库回归为 PGlite SQL 引擎及初始化并发 mock，不能替代多实例 PostgreSQL 服务测试。
