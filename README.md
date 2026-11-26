# AIUsage

A local workspace for your AI usage.

[中文](./README_zh.md) · [Repository](https://github.com/Fiveo9/aiusage) · [Issues](https://github.com/Fiveo9/aiusage/issues)

AIUsage brings usage records from your AI coding tools into one dashboard. Browse token consumption and estimated costs by date, tool, model, session, project, or device. Records are stored in SQLite on your machine, and the local dashboard needs no account.

Independently developed and maintained by [Fiveonine](https://github.com/Fiveo9). This repository is the home for ongoing development, issue tracking, and future release records. Run from source to use the code maintained here.

## Working with your usage

- Review daily usage and how it changes over time.
- Compare tools and models by token consumption and estimated cost.
- Explore sessions, projects, and tool calls behind the totals.
- Combine usage from your devices through optional, configured sync.
- Check available quotas and use an optional desktop panel for a quick glance.

Data sources include Claude Code, Codex, OpenCode, Cursor, Copilot, Gemini CLI, and more. AIUsage reads the logs and databases these tools leave on your machine. Available history depends on the records each tool retains. The dashboard's source settings show detected sources, file counts, and paths.

The steps below cover local use: install dependencies, start the server, import records, and browse your usage. Sync and the desktop panel are optional additions described later. Unless a step says otherwise, run commands from the repository root, the folder containing this README and `package.json`.

## 1. First-time setup

Prepare Git, [Node.js](https://nodejs.org/) 20+, and pnpm 9.15.0. If pnpm is not installed, install it after Node.js:

```sh
npm install --global pnpm@9.15.0
```

Check that your terminal can find the tools:

```sh
node --version
pnpm --version
```

Get the source and install its dependencies:

```sh
git clone https://github.com/Fiveo9/aiusage.git
cd aiusage
pnpm install --frozen-lockfile
```

If you already have this repository, enter its existing root directory and run the install command there. Install dependencies on first setup and after updates that change dependencies; everyday startup uses the next step.

## 2. Start the dashboard

From the repository root, run:

```sh
pnpm dev
```

This builds the shared core and Web dashboard, then starts the local CLI/API server. Wait for the terminal to print a listening address such as:

```text
aiusage serve listening on http://127.0.0.1:3847
```

Open **<http://127.0.0.1:3847>** in your browser. If that port is occupied, the server tries subsequent ports; use the actual address printed in the terminal.

**Keep this terminal running while using the dashboard.** Press `Ctrl+C` to stop the server. Imported records remain in the local database for the next startup.

## 3. Import and check your data

Run AIUsage on a machine and under a user account that can access your AI tools' records. On startup, the server accepts browser connections first, then imports available logs in the background. A working page can therefore appear before the initial import finishes.

1. Wait for the startup terminal's `[serve] parsing logs...` message to be followed by `[serve] parsed ...`. Check any warnings or errors printed alongside the result.
2. Open the sources page in the dashboard's settings. Check each source's status, file count, and paths. Sources that require manual import provide instructions and an import action on that page.
3. Browse the overview, tokens, costs, and activity pages to inspect the imported records.

For an explicit import and a terminal check, wait for the initial background import to finish, then open another terminal at the repository root:

```sh
pnpm cli parse
pnpm cli status
pnpm cli summary
```

- `parse` imports local records and supports incremental updates. Run it again to pick up new or changed records.
- `status` shows the database path, record count, size, device, and sync status. Check source detection in the dashboard's settings.
- `summary` summarizes records already imported into SQLite.

Refresh the browser after a manual import. To import new records periodically while the server runs, save a refresh interval in the general settings. The value is in milliseconds: `30000`, for example, means 30 seconds.

## 4. Everyday use

If the server is already running, open its address in your browser. To start it again after stopping it, enter the repository root and run:

```sh
pnpm dev
```

Start with the overview for daily totals, then filter by date, tool, model, or device. Use the tokens and costs pages to compare usage, and the activity pages to explore sessions, projects, and tool calls. Import new logs manually or configure the refresh interval described above when you want updated totals.

Common terminal commands:

| Command | Purpose |
|---|---|
| `pnpm cli status` | Inspect database, device, and sync status |
| `pnpm cli parse` | Import or update local usage records |
| `pnpm cli summary` | View a summary of imported usage |
| `pnpm cli summary --month` | View this month's summary |
| `pnpm cli export --format csv --range month --output ../../usage-month.csv` | Save this month's usage as `usage-month.csv` in the repository root |
| `pnpm cli --help` | Browse the full command list |

Export reads the imported database. Without `--output`, it prints the data to the terminal. The source wrapper runs `pnpm cli` inside `packages/cli`, so relative output paths are resolved there; `../../usage-month.csv` writes to the repository root. You can also pass an absolute output path.

## 5. Common questions

### The terminal cannot find pnpm, or startup ends with ELIFECYCLE

Check `node --version` and `pnpm --version`. If pnpm is missing, install the version in step 1 and ensure it is available on `PATH`; reopen the terminal after changing the environment. The root `pnpm dev` script also invokes pnpm internally, so changing only the outer command to `pnpm.cmd dev` may still leave child processes unable to find it.

`ELIFECYCLE` means a script failed. Read the error above it to identify the cause.

If dependencies (including `tsx`) are already installed and the core and Web dashboard have already been built, you can start the existing dashboard directly with Node. From the repository root, run this in PowerShell:

```powershell
cd packages/cli
node --import tsx src/index.ts serve --host 127.0.0.1 --port 3847
```

This starts the server using existing dependencies and build output. A fresh checkout still needs the installation and build steps. Keep the terminal running and use the printed address. After stopping it with `Ctrl+C`, run `cd ../..` before using other repository-root commands.

### The browser cannot reach the dashboard

Check that the server terminal is still running and has printed a listening address. Open that exact `http://` address, including its actual port. If the server stopped, run `pnpm dev` from the repository root again.

`pnpm build` and `pnpm --filter @aiusage/web build` generate build output; viewing it in the browser also requires a running server.

### The page opens, but there is no data

1. Wait for the initial background import to finish and check the server terminal for import errors.
2. Check the sources page in settings for detected files and paths. Available records depend on the logs retained by the tools on this machine; follow the page's instructions for sources requiring manual import.
3. Run `pnpm cli parse`, then `pnpm cli status` and `pnpm cli summary` in another terminal at the repository root to check what was imported.
4. If the database contains records, widen the dashboard's date range and check its tool and device filters, then refresh the page.

If the page reports API request errors, check the server terminal for those errors as well.

### I just used an AI tool, but the totals have not changed

Totals reflect the records imported into the database. Wait for the configured refresh interval, or run `pnpm cli parse` in another terminal at the repository root and refresh the browser after it finishes. Check the tool's source status if the import still finds no new records.

### The dashboard still shows the old interface after a source update

The local server serves the built Web dashboard. Stop it with `Ctrl+C`, run `pnpm dev` from the repository root to rebuild and start it, then hard-refresh the browser, for example with `Ctrl+F5` on Windows.

## Optional features

### Desktop panel

Keep `pnpm dev` running. In another terminal at the repository root, run:

```sh
pnpm dev:widget
```

This builds and starts the Electron desktop panel. See the development notes below for its native SQLite dependency.

### Sync between your devices

Sync supports GitHub and S3-compatible storage, including R2 and MinIO. Configure each device with the same destination you control, import its local records, and sync:

```sh
pnpm cli init
pnpm cli sync
```

`init` guides you through destination configuration; `sync` uses the saved configuration. Synced records can include session and project metadata, so choose the destination accordingly.

## Data and access

Parsed usage is stored in `~/.aiusage/cache.db`. Costs are estimates based on available pricing and log metadata, and can change after pricing updates or recalculation.

The dashboard listens on `127.0.0.1` by default. Configure `AIUSAGE_DASHBOARD_PASSWORD` in the shell environment to protect detailed views and settings; home-page aggregate totals remain public. Listening on a network interface requires a non-empty value.

## Development

The project uses a pnpm workspace. Run development commands from the repository root:

| Entry point | Purpose |
|---|---|
| `pnpm dev` | Local dashboard and CLI server |
| `pnpm dev:widget` | Optional Electron desktop panel |
| `pnpm dev:site` | Optional account and hosted-service development |
| `pnpm test` | Package test scripts |

For widget development, keep `pnpm dev` running and start `pnpm dev:widget` in another terminal. The widget uses a native SQLite module and resolves this checkout's built CLI first. It never installs a CLI automatically. Independent package targets are `@fiveo9/aiusage` and `@fiveo9/aiusage-widget`; registry publication still requires maintainer credentials and a release.

For account or hosted-service development, run the site separately on port `4000` and set `SITE_URL=http://localhost:4000` in the CLI process environment (or use `AIUSAGE_SITE_URL`). Hosted integrations currently fall back to the inherited service address when this setting is absent. An independent deployment needs its own service configuration.

| Directory | Responsibility |
|---|---|
| `packages/core` | Record types, parsing, pricing, and shared calculations |
| `packages/cli` | Import commands, SQLite storage, local API, and sync |
| `packages/web` | Browser dashboard |
| `packages/widget` | Desktop panel and tray integration |
| `packages/site` | Optional website, accounts, and hosted APIs |

Submit bugs, questions, and proposed changes to [this repository's issues](https://github.com/Fiveo9/aiusage/issues). Include the affected tool, operating system, expected behavior, and a reproducible example when possible. Report sensitive security details through the channels described in [SECURITY.md](./SECURITY.md).

## Project notes

- [Change history](./CHANGELOG.md)

## Origin and license

The initial code was based on [juliantanx/aiusage](https://github.com/juliantanx/aiusage). AIUsage uses the [MIT license](./LICENSE), with the original copyright and permission notice retained. Earlier source history is preserved in [aiusage-history](https://github.com/Fiveo9/aiusage-history).
