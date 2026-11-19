# AIUsage

你的本地 AI 用量工作台。

[English](./README.md) · [项目仓库](https://github.com/Fiveo9/aiusage) · [问题反馈](https://github.com/Fiveo9/aiusage/issues)

AIUsage 把不同 AI 编程工具的使用记录整理到同一个仪表盘中，方便按日期、工具、模型、会话、项目和设备查看 token 消耗与估算费用。数据保存在本机的 SQLite 数据库，使用本地仪表盘无需注册账号。

本项目由 [Fiveonine](https://github.com/Fiveo9) 独立开发和维护，后续开发、问题反馈及发布记录以当前仓库为准。运行这里维护的版本，请使用源码启动方式。

## 用它整理日常使用

- 查看每天的用量及其变化趋势。
- 按工具和模型比较 token 消耗与估算费用。
- 从汇总数据进入具体会话、项目和工具调用。
- 配置可选同步，汇总自己不同设备上的使用记录。
- 查看可获取的配额信息，通过可选桌面面板快速查看用量。

可读取 Claude Code、Codex、OpenCode、Cursor、Copilot、Gemini CLI 等工具的记录。在仪表盘的数据源设置中，或通过 `pnpm cli status`，查看本机实际检测到的来源。可用历史取决于各工具保留的日志和数据库。

## 从源码启动

环境要求：Node.js 20+、pnpm 9.15.0。

在终端中执行：

```bash
git clone https://github.com/Fiveo9/aiusage.git
cd aiusage
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:3847`。命令会构建共享核心与仪表盘，启动本地服务，并在后台导入可用的使用记录。如果默认端口被占用，以终端输出的地址为准。使用 `Ctrl+C` 停止服务。

## 日常命令

以下命令均在仓库根目录执行：

| 命令 | 用途 |
|---|---|
| `pnpm cli status` | 查看检测到的数据源和数据库状态 |
| `pnpm cli parse` | 从本地来源导入使用记录 |
| `pnpm cli summary` | 在终端查看用量摘要 |
| `pnpm cli export --format csv --range month` | 导出本月用量 |
| `pnpm cli init` | 配置可选同步 |
| `pnpm cli sync` | 与已配置的目标同步 |
| `pnpm cli --help` | 查看完整命令列表 |

同步可使用 GitHub 或 S3 兼容存储，包括 R2、MinIO。使用前先配置自己的目标；同步记录可能包含会话和项目元数据。详见[同步配置](./docs/github-sync.md)和[同步模型](./docs/sync-namespaces.md)。

## 数据与访问

解析后的记录保存在 `~/.aiusage/cache.db`。费用依据可用定价与日志信息估算，更新定价或重新计算后可能变化。

仪表盘默认监听 `127.0.0.1`。在 shell 环境中配置 `AIUSAGE_DASHBOARD_PASSWORD` 后，详细数据与设置需要登录，首页合计仍保持公开。监听网络地址时必须配置非空值。详见[仪表盘访问与安全说明](./docs/dashboard-security.md)。

## 开发与维护

项目使用 pnpm workspace，开发命令在仓库根目录执行：

| 开发入口 | 用途 |
|---|---|
| `pnpm dev` | 本地仪表盘与 CLI 服务 |
| `pnpm dev:widget` | 可选 Electron 桌面面板 |
| `pnpm dev:site` | 可选账号与托管服务开发 |
| `pnpm test` | 各包的测试脚本 |

开发桌面面板时，保持 `pnpm dev` 运行，再在另一个终端执行 `pnpm dev:widget`。小组件依赖原生 SQLite 模块，优先使用本仓库已构建的 CLI，不再自动安装 CLI。独立发行包名为 `@fiveo9/aiusage` 和 `@fiveo9/aiusage-widget`；实际发布仍需维护者配置凭据并执行发行流程。

开发账号或托管服务时，在另一个终端启动站点（端口 `4000`），并在 `packages/cli/.env` 中设置 `SITE_URL=http://localhost:4000`。未设置时，相关集成仍默认连接继承的服务地址。独立部署需要配置自己的服务。

| 目录 | 职责 |
|---|---|
| `packages/core` | 记录类型、解析、定价与共享计算 |
| `packages/cli` | 导入命令、SQLite 存储、本地 API 与同步 |
| `packages/web` | 浏览器仪表盘 |
| `packages/widget` | 桌面面板与系统托盘集成 |
| `packages/site` | 可选站点、账号与托管 API |

Bug、使用问题和改动建议提交到[当前仓库的 Issues](https://github.com/Fiveo9/aiusage/issues)。尽量附上涉及的工具、操作系统、预期行为和可复现示例。敏感安全信息请通过 [SECURITY.md](./SECURITY.md) 中说明的渠道报告。

## 项目记录

- [更新记录](./CHANGELOG.zh-CN.md)
- [同步修复说明](./docs/sync-repair.md)

## 来源与许可

初始代码基于 [juliantanx/aiusage](https://github.com/juliantanx/aiusage)。本项目采用 [MIT 许可证](./LICENSE)，保留原版权及许可声明。早期源码历史保存在 [aiusage-history](https://github.com/Fiveo9/aiusage-history)。
