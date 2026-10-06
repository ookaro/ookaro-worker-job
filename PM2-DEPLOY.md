# PM2 Deploy Guide - ookaro-worker

Runs the background-jobs process on the Windows VPS under PM2. Process name: `ookaro-worker`.
Config file: `ecosystem.config.cjs` (in this folder). Run everything in PowerShell.

Keep it at ONE instance. Two copies would run every scheduled job twice (double notifications, double settlements).

## Part 1 - First-time setup (once)

### 1. Install PM2 (skip if already installed for the API)
```powershell
npm install -g pm2
pm2 -v
npm install -g pm2-windows-startup
pm2-startup install
```
- "pm2 is not recognized": open a new PowerShell.
- "running scripts is disabled": `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

### 2. Stop any worker running in a CMD window
Press `Ctrl+C` in that window.

### 3. Start
```powershell
cd "C:\path\to\ookaro-worker"
npm install
mkdir logs -ErrorAction SilentlyContinue
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
```
`pm2 save` makes it come back after a reboot. Status should show `online`.

## Part 2 - After you change code (every deploy)

You do NOT set PM2 up again. The worker has no build step:
```powershell
cd "C:\path\to\ookaro-worker"
git pull
npm install        # only if package.json changed
pm2 restart ookaro-worker
```

| What changed | What to do |
|---|---|
| Code | the 3 steps above |
| `.env.local` | `pm2 restart ookaro-worker --update-env` |
| `ecosystem.config.cjs` | `pm2 delete ookaro-worker`, `pm2 start ecosystem.config.cjs`, `pm2 save` |

## Daily commands
| Task | Command |
|---|---|
| Status | `pm2 status` |
| Live logs | `pm2 logs ookaro-worker` |
| Last 30 lines | `pm2 logs ookaro-worker --lines 30` |
| Restart | `pm2 restart ookaro-worker` |
| Stop | `pm2 stop ookaro-worker` |

Logs are written to `logs/worker-out.log` and `logs/worker-error.log` (git-ignored).

## Troubleshooting
- Status `errored` or stopped after repeated crashes: `pm2 logs ookaro-worker --lines 50`. After 10 fast failures pm2 gives up on purpose, so fix the cause first, then `pm2 restart ookaro-worker`.
- Env values not picked up: restart with `--update-env`.
- Worker needs the API running too (scheduled sends and auto settlements call the API), so keep `ookaro-api` online.

The API has its own guide: `../ookaro-api/PM2-DEPLOY.md`.
