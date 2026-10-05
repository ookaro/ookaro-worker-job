/**
 * pm2 process definition for the VPS. Start with:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup          (so it comes back after a reboot)
 * Logs go to ./logs (not in git). `pm2 logs ookaro-worker` tails them live.
 *
 * max_restarts + min_uptime stop a job that crashes on boot from spinning forever - after
 * repeated fast failures pm2 gives up and leaves it stopped, visible in `pm2 status`.
 */
module.exports = {
  apps: [
    {
      name: "ookaro-worker",
      script: "src/index.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,            // one scheduler only - more copies would double-send everything
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 5000,
      max_memory_restart: "300M",
      error_file: "./logs/worker-error.log",
      out_file: "./logs/worker-out.log",
      merge_logs: true,
      time: true,              // timestamp every log line
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
