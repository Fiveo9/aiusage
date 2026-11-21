# 下一阶段开发计划

日期：2026-11-20。按用户授权依次实施以下三项，每项完成定向验证与只读 review 后单独提交，不自动推送或发布。

当前验收状态：三项功能已提交，并于 2026-11-20 补齐本机根构建、site 构建、Linux 六步构建及五包全量回归；最终 1,926 通过、0 失败、1 项 Windows 专属用例在 Linux 跳过。各阶段下方保留其当时验证边界，最新结果见文末「构建与 Linux 全量补验」。

## 执行约束

- 保留工作区现有会话标题改动，在其基础上收尾；重要文件修改前备份到 `backups/next-stage-20261120/`。
- 仅读取交付文件及直接依赖。测试使用合成数据，不读取真实使用记录或凭据。禁止物理删除，临时产物保留在证据目录或移入回收区。
- 本机轻量检查直接执行；耗时全量或 Linux 验证仅通过根目录 `scripts/remote-check.ps1`，明确 `-Task`、`-Target`，跟踪最终退出状态。远程受阻时如实记录，不擅自切换平台。
- 每项提交前更新本文件与中英文更新日志，记录实际命令、结果、review 和未验证边界。提交身份使用 Fiveonine。
- 下列本机 Vitest 命令在仓库根目录运行，均先设置 `$env:NODE_OPTIONS = '--require=C:/Repositories/aiusage/.artifacts/next-stage/recycle.cjs'`。该保护重定向测试 home/tmp，检查目标与链接后将 Node 文件清理转为可恢复移动；验证配置与保护脚本保留在证据目录。没有使用会物理删除夹具的默认 CLI setup。

## S1 会话标题收尾

范围：当前标题导入与回填、SQLite/站点迁移、文件与云同步、活动列表及详情展示。

验收：

- 标题只取来源保存的元数据；标题更新不依赖用量游标前进，不改变记录身份与 token/费用。
- 无标题显示“未命名会话”与短 ID；旧记录和旧同步载荷兼容。
- 检查标题的导入、重命名、迁移、同步和显示回归，完成相关类型检查与只读 review。

状态：已完成验证与只读 review，随本阶段提交。提交标题：`feat(sessions): 完成真实会话标题链路与兼容验收`。

本机验证（2026-11-20）：

- `node packages/cli/node_modules/vitest/vitest.mjs run --config .artifacts/next-stage/cli.config.ts tests/commands/session-titles.test.ts`：11/11，退出 0。
- `node packages/site/node_modules/vitest/vitest.mjs run --config .artifacts/next-stage/site.config.ts tests/cloud/session-title-pull.test.ts tests/cloud/sync-push.test.ts tests/db/schema-migrations.test.ts`：13/13，退出 0。
- `node packages/web/node_modules/vitest/vitest.mjs run --config .artifacts/next-stage/web.config.ts tests/session-title.test.ts`：4/4，退出 0。
- core、CLI、site 的 `tsc --noEmit -p packages/<包>/tsconfig.json` 均退出 0；`pnpm --filter @aiusage/core build` 退出 0；三个标题 Svelte 文件 DOM/SSR 编译均零警告。
- 首次临时配置使用包内部导出路径导致加载失败（退出 1），改为普通配置对象后通过；CLI 首次类型检查引用旧 core 产物（退出 2），重建后通过。全部过程日志保留在 `.artifacts/next-stage/s1-*`。
- 只读 review：确认只取保存的标题元数据，重命名推进同步版本，缺失字段保留已有标题，查询按设备隔离；标题加入同步同意字段。未发现需额外修改的阻断项。
- 边界：合成 SQLite/HTTP、模拟站点 SQL 与 Svelte 编译；未导入真实日志、执行真实 PostgreSQL 部署/云同步或人工浏览器验收。

## S2 会话搜索与排序

范围：会话列表、查询 API 与数据库查询，必要的共享 URL/界面文案。

验收：

- 按真实标题或会话 ID 搜索，匹配筛选范围内全部记录，搜索作用于分页前。
- 提供最近活动、费用最高、Token 最多排序；相同值有确定性次序。
- 保持日期、设备和工具筛选，搜索/排序变化重置分页；URL 保存搜索、排序和页码，支持刷新与浏览器返回。
- 参数校验、总数/分页一致性、跨设备隔离、无标题搜索、排序与迟到响应有定向回归。

状态：已完成验证与只读 review，随本阶段提交。提交标题：`feat(sessions): 新增会话搜索与稳定排序`。

本机验证：

- `node packages/cli/node_modules/vitest/vitest.mjs run --config .artifacts/next-stage/cli.config.ts tests/api/session-search.test.ts tests/api/sessions-endpoints.test.ts tests/commands/session-titles.test.ts`：49/49，退出 0。
- `node packages/web/node_modules/vitest/vitest.mjs run --config .artifacts/next-stage/web.config.ts tests/sessions-page-reset.test.ts tests/sessions-paging.test.ts tests/session-title.test.ts tests/api.test.ts`：25/25，退出 0。
- CLI `tsc --noEmit` 退出 0；两个会话 Svelte 页面 DOM/SSR 编译零警告；`git diff --check` 通过。日志：`.artifacts/next-stage/s2-*`。
- 只读 review：搜索为绑定参数的字面子串匹配，作用于会话聚合后、分页前；最新非空标题与显示一致，不因日期窗口而丢失。费用和 Token 汇总保留全部符合筛选的记录；Token 排序按项目既有存储口径包含独立的 thinking。最近活动按最后记录时间排序，所有排序均以会话 ID/设备 ID 打破平局。URL 保存筛选、搜索、排序、页码，返回链接限于会话列表；迟到响应与卸载后的响应不会写入页面状态。
- S3 衔接检查发现初版 S2 Token 排序漏加独立存储的 thinking 字段；对照既有 token-composition 回归确认后补齐，并增加仅 reasoning 用量改变排序的用例。9 项搜索回归重新通过，修订本轮未推送的 S2 提交。
- 边界：已覆盖实际 SQLite/HTTP 及页面脚本导航回调，未进行人工浏览器验收；搜索支持中文原文及 ASCII 大小写折叠，不宣称任意语言的大小写归一化。

## S3 费用来源与未计价提示

范围：费用汇总 API/查询与费用页，复用现有价格管理入口。

验收：

- 展示日志记录费用、定价估算和未知价格的记录数量与费用来源，不把日志费用称为实际账单。
- 显示已计价记录覆盖率及未计价模型清单/数量；已知零费用与未计价明确区分。
- 汇总与日期/工具/设备筛选一致，未知价格不影响既有费用求和；模型合并展示不改变原始价格身份。
- 提供价格管理入口，并覆盖混合来源、零费用、空数据与筛选回归，完成只读 review。

状态：已完成验证与只读 review，随本阶段提交。提交标题：`feat(cost): 展示费用来源与未计价模型提示`。

本机验证：

- `node packages/cli/node_modules/vitest/vitest.mjs run --config .artifacts/next-stage/cli.config.ts tests/api/cost-provenance.test.ts tests/api/session-search.test.ts`：14/14，退出 0。
- `node packages/cli/node_modules/vitest/vitest.mjs run --config .artifacts/next-stage/cli.config.ts tests/api/server.test.ts -t 'cost '`：4 项通过、39 项因名称筛选未运行，退出 0。
- `node packages/web/node_modules/vitest/vitest.mjs run --config .artifacts/next-stage/web.config.ts tests/cost-provenance.test.ts tests/model-display.test.ts`：12/12，退出 0。
- CLI `tsc --noEmit` 退出 0；费用页和费用来源组件 DOM/SSR 编译零警告；`git diff --check` 通过。日志：`.artifacts/next-stage/s3-*`。
- 首轮组件测试错误要求 Svelte 同时转义文本中的 `<` 与 `>`，实际已安全转义 `<`；将断言修正为保留原始模型名且不生成原始标签后通过。滚动区域的键盘焦点按既有活动页约定添加说明，编译警告消除。失败日志保留。
- 只读 review：来源统计复用费用接口各设备分支的记录集合，过滤/同步去重口径与原总额一致；覆盖率是已知费用记录占比，零费用计入，空集合返回 null。未知价格不改写存储费用，不宣称免费或账单准确性；未计价清单保留完整模型名并链接现有定价页。新 Token 清单包含独立 thinking。费用页保留最新响应并在卸载时使请求失效。未发现剩余阻断项。
- 边界：实际 SQLite/HTTP、组件 SSR 输出和页面脚本回调已验证；未执行整仓构建、远程全量套件或人工浏览器验收。仅 core 构建产物已更新，Web/CLI 发行产物应通过项目启动/构建命令生成。

## 交付记录

计划已先于本轮实现写入。各阶段的实际验证、review 和提交记录在完成时追加。

- S1 提交：`e6d4d50`。
- S2 提交：`9b7e28e`。
- S3 提交：`a0a62ec`。
- 本轮源码备份：`backups/next-stage-20261120/`。合成标题夹具、隔离 home/tmp、测试回收内容、未使用临时脚本与暂存补丁均经路径/链接审查移入 `backups/build-recycle/`，可恢复；没有物理删除。
- 三项均在各自验证与只读 review 后提交；未推送或发布，未更改真实使用数据或本机同步同意状态。

## 构建与 Linux 全量补验（2026-11-20）

用户授权继续构建、远程 Linux 全量回归、修复实际失败并提交；不推送或发布。

### 本机构建与定向修复验证

仓库根目录设置既有回收保护后执行：

```powershell
$env:NODE_OPTIONS = '--require=C:/Repositories/aiusage/.artifacts/next-stage/recycle.cjs'
pnpm build
pnpm build:site
```

两条命令均退出 0。根构建包括 core、Web、CLI（内嵌最新 Web）和 widget；site 单独生产构建通过。widget 的 native 步骤命中已有绑定，没有从零编译原生模块。本机 CLI、Web、site、widget 产物已生成，日志位于 `.artifacts/next-stage-build-20261120/build.log` 和 `site-build.log`。

首轮 Linux 全量回归在五个测试文件中出现 6 项失败：旧迁移夹具回退版本账本却保留 v19 标题列，4 项报 `SqliteError: duplicate column name: session_title`；CLI 状态仍断言 schema 18，实际为 19；站点迁移原子性断言缺少新增版本 18。修复在重放迁移前恢复夹具的旧标题 schema，并更新版本/视图数量断言；站点另确认重试后标题列真实存在。生产迁移和业务实现未修改，重复打开、Token/费用一致性、回滚和重试断言继续保留。

本机复验命令（沿用上述 NODE_OPTIONS）：

```powershell
node packages/cli/node_modules/vitest/vitest.mjs run --config .artifacts/next-stage/cli.config.ts --maxWorkers=1 --minWorkers=1 tests/db/migration-v15.test.ts tests/db/migration-v16.test.ts tests/commands/parse-codex-reasoning.test.ts tests/commands/status.test.ts
node packages/site/node_modules/vitest/vitest.mjs run --config .artifacts/next-stage/site.config.ts tests/db/migration-atomicity.pg.test.ts
```

分别 33/33、1/1，通过且退出 0；日志为同目录 `migration-cli.log`、`migration-site.log`。

### 远程结果

所有命令均从仓库根目录通过统一脚手架运行，使用现有 `linux-01`、Node 22.23.3，校验锁文件及 610 个源码文件后复用隔离依赖。

| 命令 | 最终结果 | 本地证据目录 |
| --- | --- | --- |
| `pwsh -NoProfile -File ./scripts/remote-check.ps1 -Task test -Target linux -Scope full -Machine linux-01 -ResumeMachine -ReuseRunId 20261119T141038Z-65bd95bf` | 首轮本地/远程 exit 1；1,920 通过、6 失败、1 跳过；分类为单元测试失败 | `.artifacts/remote-check/20261120T013538Z-c8fb722b/` |
| `pwsh -NoProfile -File ./scripts/remote-check.ps1 -Task build -Target linux -Scope review -Machine linux-01 -ReuseRunId 20261120T013538Z-c8fb722b` | 本地/远程 exit 0；core、Web、CLI、site 生产构建，widget renderer 和类型检查，6 步通过；此命令不运行测试 | `.artifacts/remote-check/20261120T014107Z-58f78b6c/` |
| `pwsh -NoProfile -File ./scripts/remote-check.ps1 -Task test -Target linux -Scope full -Machine linux-01 -ReuseRunId 20261120T014107Z-58f78b6c` | 最终本地/远程 exit 0；1,926 通过、0 失败、1 跳过，共 1,927 项 | `.artifacts/remote-check/20261120T014318Z-07e05b2c/` |

最终分包统计：core 137/137、CLI 1,513/1,514（1 项平台跳过）、widget 34/34、site 160/160、Web 82/82。跳过项为 Windows 文件被其他进程占用时的损坏数据库恢复测试。没有扩大跳过范围，也未修改测试运行配置以绕过失败。

最终源码归档 SHA256：`7a4eb133c4722a09e40e4800df03b0adf3562be39b03eba80d39bf946b77de12`。已确认五个修正文件与本次上传 manifest 的哈希一致。各运行的 summary、分包 JSON 报告与日志均已回收；首轮失败证据保留。

只读 review 已检查五个测试文件及直接迁移依赖：schema 回退只发生于内存合成夹具，数据断言未弱化；生产 v19 仍由迁移账本和事务保证只执行一次；站点验证保留实际 PGlite SQL 回滚/重试。`git diff --check` 通过。

备份位于 `backups/next-stage-full-20261120/`。本机隔离 home/tmp、回收内容及旧构建产物经路径/链接检查移入 `backups/build-recycle/`，可恢复。远程实例和失败运行保留，依赖实例自动挂起；没有物理删除、销毁实例、推送或发布。

剩余边界：本轮没有人工浏览器/Electron GUI 验收、Linux Electron 原生模块重编译、真实用户日志导入/云同步、独立 PostgreSQL 服务或 Docker 镜像重验。站点迁移测试使用 PGlite，不表述为独立 PostgreSQL 部署验收。
