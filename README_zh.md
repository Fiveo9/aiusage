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

可读取 Claude Code、Codex、OpenCode、Cursor、Copilot、Gemini CLI 等工具的记录。AIUsage 读取这些工具在本机留下的日志和数据库，可用历史取决于各工具保留的记录。仪表盘的数据源设置会显示检测到的来源、文件数量和路径。

下面按本地使用流程说明：安装依赖、启动服务、导入记录、查看用量。同步和桌面面板是后文介绍的可选功能。除特别说明外，所有命令均在仓库根目录执行，即包含本 README 和 `package.json` 的目录。

## 1. 首次安装

准备 Git、[Node.js](https://nodejs.org/) 20+ 和 pnpm 9.15.0。如果尚未安装 pnpm，先安装 Node.js，再执行：

```sh
npm install --global pnpm@9.15.0
```

确认终端能找到所需工具：

```sh
node --version
pnpm --version
```

获取源码并安装依赖：

```sh
git clone https://github.com/Fiveo9/aiusage.git
cd aiusage
pnpm install --frozen-lockfile
```

如果已经有本仓库，进入现有仓库根目录执行安装命令即可。首次安装，以及更新到依赖有变化的版本时，需要安装依赖；日常启动使用下一步的命令。

## 2. 启动仪表盘

在仓库根目录执行：

```sh
pnpm dev
```

命令会先构建共享核心和 Web 仪表盘，再启动本地 CLI/API 服务。等待终端打印监听地址，例如：

```text
aiusage serve listening on http://127.0.0.1:3847
```

在浏览器打开 **<http://127.0.0.1:3847>**。如果该端口被占用，服务会尝试后续端口，请使用终端实际打印的地址。

**使用仪表盘时，保持这个终端运行。** 按 `Ctrl+C` 可以停止服务；已经导入的记录会保留在本地数据库中，供下次启动使用。

## 3. 数据导入与确认

请在能够访问 AI 工具记录的机器和系统用户下运行 AIUsage。启动时，服务先接受浏览器连接，再在后台导入可用日志，因此网页能打开时，首次导入可能还没完成。

1. 等待启动终端中的 `[serve] parsing logs...` 后出现 `[serve] parsed ...`，并查看结果旁的警告或错误。
2. 打开仪表盘设置中的数据源页，查看各来源的状态、文件数量和路径。需要手动导入的来源，会在该页提供说明和导入操作。
3. 进入概览、Token、费用和活动页面，查看已经导入的记录。

需要手动导入并在终端确认时，先等待首次后台导入完成，再打开另一个终端，进入仓库根目录执行：

```sh
pnpm cli parse
pnpm cli status
pnpm cli summary
```

- `parse` 导入本地记录，支持增量更新；再次执行可补充新增或变化的记录。
- `status` 显示数据库路径、记录数量、大小、设备和同步状态。数据源检测结果在仪表盘设置中查看。
- `summary` 汇总已经导入 SQLite 的记录。

手动导入完成后刷新浏览器。希望服务运行期间定期导入新记录时，在设置的通用选项中保存刷新间隔。该值的单位为毫秒，例如 `30000` 表示 30 秒。

## 4. 日常使用

服务已经运行时，直接在浏览器打开其地址。停止服务后需要再次打开时，进入仓库根目录执行：

```sh
pnpm dev
```

先在概览中查看每日汇总，再按日期、工具、模型或设备筛选。Token 和费用页面用于比较用量，活动页面用于查看会话、项目和工具调用。需要更新统计时，手动导入新日志，或设置上文介绍的刷新间隔。

常用终端命令：

| 命令 | 用途 |
|---|---|
| `pnpm cli status` | 查看数据库、设备和同步状态 |
| `pnpm cli parse` | 导入或更新本地使用记录 |
| `pnpm cli summary` | 查看已导入用量的摘要 |
| `pnpm cli summary --month` | 查看本月用量摘要 |
| `pnpm cli export --format csv --range month --output ../../usage-month.csv` | 将本月用量保存为仓库根目录下的 `usage-month.csv` |
| `pnpm cli --help` | 查看完整命令列表 |

导出读取的是已导入的数据库。不传 `--output` 时，数据会打印到终端。源码入口会在 `packages/cli` 内执行 `pnpm cli`，相对输出路径以该目录为基准；`../../usage-month.csv` 表示写入仓库根目录，也可以指定绝对输出路径。

## 5. 常见问题

### 终端找不到 pnpm，或启动时出现 ELIFECYCLE

先检查 `node --version` 和 `pnpm --version`。如果缺少 pnpm，按第 1 步安装指定版本，并确认 `PATH` 中可以找到它；修改环境后重新打开终端。根目录的 `pnpm dev` 脚本内部还会调用 pnpm，因此只将外层命令改为 `pnpm.cmd dev`，子进程仍可能找不到命令。

`ELIFECYCLE` 表示某个脚本执行失败，具体原因需要看它前面的错误输出。

如果依赖已经安装（包括 `tsx`），且核心和 Web 仪表盘已经构建过，可以直接用 Node 启动现有仪表盘。在仓库根目录打开 PowerShell，执行：

```powershell
cd packages/cli
node --import tsx src/index.ts serve --host 127.0.0.1 --port 3847
```

这条命令使用现有依赖和构建产物启动服务。全新仓库仍需要先完成安装与构建步骤。保持终端运行，并使用打印出的地址；按 `Ctrl+C` 停止后，先执行 `cd ../..`，再运行其他仓库根目录命令。

### 浏览器无法访问仪表盘

确认服务终端仍在运行，并且已经打印监听地址。打开该地址对应的 `http://` 链接，使用实际端口。如果服务已停止，回到仓库根目录重新执行 `pnpm dev`。

`pnpm build` 和 `pnpm --filter @aiusage/web build` 会生成构建产物；在浏览器查看这些产物还需要启动服务。

### 网页能打开，但没有数据

1. 等待首次后台导入完成，并查看服务终端是否出现导入错误。
2. 在设置的数据源页查看检测到的文件和路径。可用记录取决于本机工具保留的日志；需要手动导入的来源，请按该页说明操作。
3. 在另一个位于仓库根目录的终端运行 `pnpm cli parse`，再用 `pnpm cli status` 和 `pnpm cli summary` 确认已导入的数据。
4. 如果数据库已有记录，扩大仪表盘的日期范围，检查工具和设备筛选条件，再刷新页面。

如果页面提示 API 请求错误，同时查看服务终端中对应的错误信息。

### 刚使用完 AI 工具，统计数字没有增加

统计来自已经导入数据库的记录。可以等待配置的刷新间隔，或在另一个位于仓库根目录的终端执行 `pnpm cli parse`，完成后刷新浏览器。如果仍没有导入新记录，检查对应工具的数据源状态。

### 更新源码后，网页仍是旧界面

本地服务提供的是已构建的 Web 仪表盘。按 `Ctrl+C` 停止服务，在仓库根目录重新执行 `pnpm dev` 完成构建和启动，然后强制刷新浏览器，例如在 Windows 中按 `Ctrl+F5`。

## 可选功能

### 桌面面板

保持 `pnpm dev` 运行，在另一个位于仓库根目录的终端执行：

```sh
pnpm dev:widget
```

命令会构建并启动 Electron 桌面面板。其原生 SQLite 依赖说明见下方开发部分。

### 多设备同步

同步可使用 GitHub 或 S3 兼容存储，包括 R2、MinIO。在各台设备上配置同一个由你控制的目标，导入各自的本地记录，再进行同步：

```sh
pnpm cli init
pnpm cli sync
```

`init` 引导配置同步目标，`sync` 使用已保存的配置执行同步。同步记录可能包含会话和项目元数据，请据此选择目标。

## 数据与访问

解析后的记录保存在 `~/.aiusage/cache.db`。费用依据可用定价与日志信息估算，更新定价或重新计算后可能变化。

仪表盘默认监听 `127.0.0.1`。在 shell 环境中配置 `AIUSAGE_DASHBOARD_PASSWORD` 后，详细数据与设置需要登录，首页合计仍保持公开。监听网络地址时必须配置非空值。

## 开发与维护

项目使用 pnpm workspace，开发命令在仓库根目录执行：

| 开发入口 | 用途 |
|---|---|
| `pnpm dev` | 本地仪表盘与 CLI 服务 |
| `pnpm dev:widget` | 可选 Electron 桌面面板 |
| `pnpm dev:site` | 可选账号与托管服务开发 |
| `pnpm test` | 各包的测试脚本 |

开发桌面面板时，保持 `pnpm dev` 运行，再在另一个终端执行 `pnpm dev:widget`。小组件依赖原生 SQLite 模块，优先使用本仓库已构建的 CLI，不再自动安装 CLI。独立发行包名为 `@fiveo9/aiusage` 和 `@fiveo9/aiusage-widget`；实际发布仍需维护者配置凭据并执行发行流程。

开发账号或托管服务时，在另一个终端启动站点（端口 `4000`），并在 CLI 进程环境中设置 `SITE_URL=http://localhost:4000`（也可使用 `AIUSAGE_SITE_URL`）。未设置时，相关集成仍默认连接继承的服务地址。独立部署需要配置自己的服务。

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

## 来源与许可

初始代码基于 [juliantanx/aiusage](https://github.com/juliantanx/aiusage)。本项目采用 [MIT 许可证](./LICENSE)，保留原版权及许可声明。早期源码历史保存在 [aiusage-history](https://github.com/Fiveo9/aiusage-history)。
