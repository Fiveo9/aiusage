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

Data sources include Claude Code, Codex, OpenCode, Cursor, Copilot, Gemini CLI, and more. Use the dashboard's source settings or `pnpm cli status` to see what is detected on your machine. Available history depends on the records each tool retains.

## Run from source

Requirements: Node.js 20+ and pnpm 9.15.0.

Run these commands in a terminal:

```bash
git clone https://github.com/Fiveo9/aiusage.git
cd aiusage
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:3847`. The command builds the shared core and dashboard, starts the local server, and imports available usage records in the background. If the default port is occupied, use the address printed in the terminal. Press `Ctrl+C` to stop.

## Everyday commands

Run commands from the repository root:

| Command | Purpose |
|---|---|
| `pnpm cli status` | Inspect detected sources and database status |
| `pnpm cli parse` | Import usage from local sources |
| `pnpm cli summary` | View a terminal summary |
| `pnpm cli export --format csv --range month` | Export this month's usage |
| `pnpm cli init` | Configure optional sync |
| `pnpm cli sync` | Sync with the configured destination |
| `pnpm cli --help` | Browse the full command list |

Sync supports GitHub and S3-compatible storage, including R2 and MinIO. Configure your destination before using it; synced records can include session and project metadata. See the [sync configuration](./docs/github-sync.md) and [sync model](./docs/sync-namespaces.md).

## Data and access

Parsed usage is stored in `~/.aiusage/cache.db`. Costs are estimates based on available pricing and log metadata, and can change after pricing updates or recalculation.

The dashboard listens on `127.0.0.1` by default. Configure `AIUSAGE_DASHBOARD_PASSWORD` in the shell environment to protect detailed views and settings; home-page aggregate totals remain public. Listening on a network interface requires a non-empty value. See [dashboard access and security](./docs/dashboard-security.md).

## Development

The project uses a pnpm workspace. Run development commands from the repository root:

| Entry point | Purpose |
|---|---|
| `pnpm dev` | Local dashboard and CLI server |
| `pnpm dev:widget` | Optional Electron desktop panel |
| `pnpm dev:site` | Optional account and hosted-service development |
| `pnpm test` | Package test scripts |

For widget development, keep `pnpm dev` running and start `pnpm dev:widget` in another terminal. The widget uses a native SQLite module and resolves this checkout's built CLI first. It never installs a CLI automatically. Independent package targets are `@fiveo9/aiusage` and `@fiveo9/aiusage-widget`; registry publication still requires maintainer credentials and a release.

For account or hosted-service development, run the site separately on port `4000` and set `SITE_URL=http://localhost:4000` in `packages/cli/.env`. Hosted integrations currently fall back to the inherited service address when this setting is absent. An independent deployment needs its own service configuration.

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
- [Sync repair guide](./docs/sync-repair.md)

## Origin and license

The initial code was based on [juliantanx/aiusage](https://github.com/juliantanx/aiusage). AIUsage uses the [MIT license](./LICENSE), with the original copyright and permission notice retained. Earlier source history is preserved in [aiusage-history](https://github.com/Fiveo9/aiusage-history).
