# 会话 240 审阅问题修复清单

来源：2026-11-19「README审阅与项目优化」（会话 240）。本次按用户授权初始化本地 Git，保留现有源码和重写后的 README，然后按以下顺序逐项实现、定向验证、只读审阅和独立提交。不自动推送或发布。

当前收尾状态（2026-11-19）：10 项源码修复已提交；本机五个包的分项生产构建、站点整体类型检查和隔离 Electron 运行验证已通过。本轮执行 39 项定向回归，零失败，并完成 Electron smoke 的 5 组断言。以下分项保留初次交付记录，后续补验结果见文末「收尾验证」。未执行远程 CI、独立 PostgreSQL 多实例锁竞争、完整测试套件及实际发布。

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| R01 | JSONL 未完成尾行导致增量解析漏计 | 完成；5/5 边界回归及真实解析/水位集成回归通过 |
| R02 | Docker 构建上下文未排除环境文件和备份 | 完成；排除规则和两个 COPY 入口静态核对通过 |
| R03 | 独立包名、发布目标和小组件启动仍依赖上游发行包 | 完成；3/3 定位回归，CLI/widget 类型检查通过 |
| R04 | 公开登录接口读取请求体无大小限制 | 完成；8/8 请求体回归及真实登录路由 413 验证通过 |
| R05 | Codex 模型状态在文件间继承 | 完成；2/2 文件边界回归、core 类型检查通过 |
| R06 | 登录 Cookie 缺少服务端有效期 | 完成；8/8 认证回归及真实路由旧会话拒绝验证通过 |
| R07 | 小组件手动刷新忽略已保存的统计范围 | 完成；类型检查及 Electron 实际设置/查询 IPC 通过 |
| R08 | 小组件日界计算未适配夏令时 | 完成；18/18 日期与数据回归、widget 类型检查通过 |
| R09 | 构建脚本依赖 Unix 命令，CI 缺少 Windows 覆盖 | 完成；五个包本机分项生产构建通过，远程 CI 未触发 |
| R10 | 站点初始化并发、失败处理及数据库迁移互斥 | 完成；12/12 初始化/迁移回归及站点整体类型检查通过；独立 PG 多实例未验证 |

## 验证约束

优先使用本机已有工具做定向回归。测试使用合成数据，不读取真实日志或凭据。重要源码修改前备份到 `backups/review-fixes-20261119/`。测试临时产物移入回收区，不物理删除。远程任务仅允许通过仓库 `scripts/remote-check.ps1`，如缺少脚手架则记录未验证范围。每项仅在完成实现和相应检查后提交；没有运行的构建、设备测试、数据库测试和实际发布不能记为通过。

## R01

游标取自实际读取到的完整 JSONL 边界，保留未完成尾行；合法但无换行的尾行仍可解析。覆盖补写重试、CRLF/中文字节偏移、UTF-8 字符分片、无换行完整记录和空行。执行 `pnpm --dir packages/cli exec vitest run --config vitest.review.config.ts tests/review/jsonl.test.ts`（5/5）及 `pnpm --dir packages/cli exec tsc --noEmit`，均退出 0。只读审阅确认通用 JSONL 分支使用新游标；未执行真实用户日志导入。

## R02

根 `.dockerignore` 统一排除所有层级的 `.env`、`.env.*`、备份、测试产物、运行数据、Git 元数据和依赖目录，覆盖 CLI 与站点使用仓库根作为构建上下文的入口。静态规则检查及 `git diff --check` 通过；未构建或发布镜像。

## R03

CLI/widget 包统一为 `@fiveo9/aiusage` / `@fiveo9/aiusage-widget`，同步 workspace 命令、npm 发布、Docker 目标、更新器、安装提示与发行链接。小组件优先解析本仓库构建或同作用域安装的 CLI，并使用系统 Node 运行，避免 Electron/Node 原生 SQLite ABI 混用；缺失或启动失败时提示操作，不自动安装包。`dev:widget` 先构建 CLI 所需模块。命名调整不改变 lockfile 的依赖图。

3/3 合成路径回归和 CLI/widget `tsc --noEmit` 通过；只读审阅已确认发布与启动目标不再指向上游。未访问注册表、未验证 `fiveo9` npm/Docker 发布权限、未发布包或镜像，未启动桌面 GUI。原始来源署名保留。

## R04

登录 JSON 上限 16 KiB，另外两个共用 JSON 读取入口上限 1 MiB；检查声明长度并按流式累计字节数限制内存，超限返回 413 并关闭连接。分片 UTF-8 在拼接后解码。8/8 回归覆盖边界、声明长度、chunked 超限、非法对象和真实本机 HTTP 413；CLI 类型检查与只读差异审阅通过。未启动业务服务或读取真实凭据。

## R05

Codex `finalize()` 在无孤立工具调用的提前返回之前也重置模型。2/2 纯内存回归确认同文件模型继承正常、下个文件为 unknown、孤立工具调用只输出一次；core `tsc --noEmit` 通过。只读审阅确认 runParse 正常结束和异常路径均调用 finalize。

## R06

Cookie 改为签发时间、随机值及 HMAC 签名；服务端拒绝超过或恰好七天、未来签发、篡改、旧固定摘要以及密码已变的 Cookie。保留原 HttpOnly/SameSite/Secure 策略。升级后旧会话需重新登录。

最终通过专用无清理钩子的配置执行 8/8 认证回归，CLI 类型检查通过。首次误用原配置，其公共 afterAll 删除了空的合成测试主目录，违反本轮仅回收规则；已记录并切换入口。没有读取或操作真实用户主目录、日志或凭据。

## R07

手动 `widget:get-data` 与定时刷新都传递 `settings.rangeDays`；保存设置后的立即刷新不再回落到默认 30 天。定向静态核对和 widget 类型检查通过；未执行 Electron GUI 验证。

## R08

今日、明日及范围起点使用本地日历日界；历史 SQL 使用同一组 JavaScript 日界区间，避免固定 24 小时和 SQLite/JS 时区差异。18/18 回归通过，包含纽约 23/25 小时日、深夜记录归属、次日零点排除、连续日期和原有数据统计。widget 类型检查通过；只读审阅确认所有统计入口使用一致边界。

## R09

CLI prepack 改用 Node 复制；widget 构建的 renderer 清理改为经边界、符号链接和硬链接检查后移入 `backups/build-recycle/`。原生绑定恢复通过包管理器 JS 入口执行，避免 Windows `.cmd` 的 execFile 问题。CI 的 core/native 添加 Windows matrix 并增加构建/prepack 检查。

1/1 回收回归、三个 Node 脚本语法检查、实际 Windows prepack 和内容哈希比对均通过；测试目录与生成 README 已移入回收区，可恢复。仓库没有 `scripts/remote-check.ps1`，未发起远程任务；完整构建还包含既有工具链清理及原生重编译，未执行，新增 CI 也未触发。只读审阅范围为本项构建入口及直接调用脚本。

2026-11-19 收尾更新：core/CLI 构建现先回收旧 dist 并禁用 tsup 删除式清理；CLI 复制 Web 产物时也回收旧目录。core、web、CLI、site、widget 的本机分项生产构建均退出 0，CLI 中 Web 入口与本次 Web 构建的哈希一致，构建出的 CLI `--version` 返回 1.5.28。Web/site 构建通过本次临时 preload 将 SvelteKit/adapter 的清理转换为仅针对明确输出路径的回收移动，原构建命令本身仍有工具链清理行为。没有运行根级 `pnpm build` 或远程 CI。

widget 使用官方 better-sqlite3 12.10.0、Electron ABI 130、win32-x64 预编译绑定，安装在 `dist/native/`，未改动 CLI 的 Node 绑定；完整 widget 构建通过且 native 步骤命中已准备绑定，未验证从零原生编译。原生归档 SHA256：`0BCDEFFC09E0C5D6864313EA4CFA3544E3C3F56C553B39B61F56B2A3EA310948`。构建日志保留在 `.artifacts/closeout-20261119/`；临时脚本、下载包、旧输出和 Vite 临时配置均移入 `backups/build-recycle/`。

## R10

并发首请求共享初始化 Promise，迁移成功后只启动一次清理调度；失败返回 503/Retry-After 并阻止认证和业务查询，后续请求可重试。迁移在同一事务连接上先取得事务级 advisory lock，再创建/读取版本表，执行迁移并写入版本，提交或回滚时自动释放锁。初始化默认定价也在同一事务内完成。

8/8 定向回归通过，包括并发请求、失败重试、CORS/preflight、事务锁顺序、失败传播及原有迁移断言。只读 diff 审阅和交付源码/新增测试的定向 TypeScript 检查通过。站点整体 `tsc --noEmit` 失败：本机缺少已声明的 `@electric-sql/pglite`，既有 `tests/helpers/pglite-sql.ts` 报 TS2307 和两个连带 TS7006；没有扩大到安装依赖或修改无关测试。临时类型配置已移入 `backups/build-recycle/`。没有连接真实 PostgreSQL，也没有执行实际多实例锁竞争或完整站点构建。

## 收尾验证

已按锁文件 SHA512 校验官方 PGlite 0.5.8 归档并补齐本机缺失依赖，未更改 manifest/lockfile，未执行安装生命周期脚本。站点整体 `tsc --noEmit` 现已通过，前述依赖缺失阻断已解除。实际 PostgreSQL SQL 引擎测试使用内存 PGlite，不使用个人或生产数据库。

| 实际命令 / 检查 | 结果 | 本地证据（相对 `.artifacts/closeout-20261119/`） |
| --- | --- | --- |
| `pnpm --dir packages/core run build` | exit 0；ESM 和类型声明成功 | `core-build.log` |
| `pnpm --dir packages/web run build`，带临时回收 preload | exit 0；生产 SPA 成功 | `web-build.log` |
| `pnpm --dir packages/cli run build` | exit 0；包含本次 Web 输出 | `cli-build.log` |
| CLI/Web `index.html` SHA256 比对；`node packages/cli/dist/index.js --version` | 相同；exit 0，1.5.28 | 本轮命令输出 |
| `pnpm --dir packages/site run build`，带临时回收 preload | exit 0；adapter-node 成功 | `site-build.log` |
| `pnpm --dir packages/widget run build` | exit 0；renderer、TypeScript、已准备 native 绑定通过 | `widget-build.log` |
| `pnpm --dir packages/site exec tsc --noEmit` | exit 0，完整站点类型检查通过 | `site-typecheck.log`（无错误输出） |
| `pnpm --dir packages/cli exec tsc --noEmit` | exit 0，含新增回归 | 本轮命令输出 |
| `pnpm --dir packages/site exec vitest run tests/db/entry-hidden-migration.pg.test.ts tests/initialization.test.ts tests/db/migration-lock.test.ts tests/db/schema-migrations.test.ts` | exit 0，11/11 | 本轮命令输出 |
| `pnpm --dir packages/site exec vitest run tests/db/migration-atomicity.pg.test.ts` | exit 0，1/1 | `site-atomicity.log` |
| `pnpm --dir packages/core exec vitest run tests/codex.test.ts tests/codex-reasoning.test.ts tests/codex-file-boundary.test.ts` | exit 0，21/21 | `core-codex.log` |
| `pnpm --dir packages/cli exec vitest run --config vitest.review.config.ts tests/review/parse-boundary.test.ts` | exit 0，2/2 | `parse-boundary.log` |
| `pnpm --dir packages/cli exec vitest run --config vitest.review.config.ts tests/review/login-api.test.ts` | exit 0，4/4 | `login-api.log` |
| 实际 Electron 33.4.11 隐藏窗口 smoke（合成主目录、禁止网络） | exit 0，5 组断言；renderer 无错误，进程已退出 | `widget-smoke.json`、`widget-smoke.log` |

新增回归覆盖实际 `runParse → SQLite → watermark`：未完成尾行补全后入库一次、CRLF/中文字节游标准确、跨文件模型为 unknown；实际 HTTP 登录接口对声明长度和 chunked 超限均返回 413、非法 JSON 返回 400、新会话有效、八天旧会话被拒绝。新增 PGlite 事务测试确认迁移后启动失败会同时回滚 schema 和版本表，后续重试及再次初始化成功。

Electron smoke 实际加载构建后的 main/preload/renderer 和 ABI 130 SQLite 绑定，验证 30 天初始总量、保存后立即切换 7 天/14 天范围、页面内容存在、无 renderer 错误及正常退出。它是隐藏窗口功能回归，不代表人工托盘交互、界面观感或其他操作系统的验收。

交付源码与新增测试已完成只读 review。临时 smoke/preload、下载归档、合成数据库及 Vite 临时文件均移入 `backups/build-recycle/`，可恢复；最终构建产物保留在对应 `dist/` 和 `build/`，日志保留在 `.artifacts/closeout-20261119/`。本轮没有物理删除操作。

最终构建依赖复核发现 site Docker 的定向 COPY 未包含新增的根回收脚本，已补上且静态确认位于 core 构建之前；同一 Dockerfile 的镜像来源/vendor 标签已改为独立项目，原许可证及作者归属保留。该修正提交为 `9fe1055`，未执行容器构建。core/CLI 构建清理修正和本机构建验证记录提交为 `095be15`。

剩余边界：仓库无 `scripts/remote-check.ps1`，因此没有执行远程 Linux/CI 或独立 PostgreSQL 多实例锁竞争；PGlite 不能替代多进程数据库锁验证。未从零重编译 Electron 原生模块，未运行完整测试套件、根级 `pnpm build`、容器构建或干净机器依赖安装。npm/Docker 命名空间权限、发布及推送未执行。上述未执行项不标为通过。
