# 下一阶段开发计划

日期：2026-11-20。按用户授权依次实施以下三项，每项完成定向验证与只读 review 后单独提交，不自动推送或发布。

## 执行约束

- 保留工作区现有会话标题改动，在其基础上收尾；重要文件修改前备份到 `backups/next-stage-20261120/`。
- 仅读取交付文件及直接依赖。测试使用合成数据，不读取真实使用记录或凭据。禁止物理删除，临时产物保留在证据目录或移入回收区。
- 本机轻量检查直接执行；耗时全量或 Linux 验证仅通过根目录 `scripts/remote-check.ps1`，明确 `-Task`、`-Target`，跟踪最终退出状态。远程受阻时如实记录，不擅自切换平台。
- 每项提交前更新本文件与中英文更新日志，记录实际命令、结果、review 和未验证边界。提交身份使用 Fiveonine。

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

状态：待实施。提交：待记录。

## S3 费用来源与未计价提示

范围：费用汇总 API/查询与费用页，复用现有价格管理入口。

验收：

- 展示日志记录费用、定价估算和未知价格的记录数量与费用来源，不把日志费用称为实际账单。
- 显示已计价记录覆盖率及未计价模型清单/数量；已知零费用与未计价明确区分。
- 汇总与日期/工具/设备筛选一致，未知价格不影响既有费用求和；模型合并展示不改变原始价格身份。
- 提供价格管理入口，并覆盖混合来源、零费用、空数据与筛选回归，完成只读 review。

状态：待实施。提交：待记录。

## 交付记录

计划已先于本轮实现写入。各阶段的实际验证、review 和提交记录在完成时追加。
