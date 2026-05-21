// PM2 ecosystem config for the Mac Mini.
//
// Install:
//   cd workers/social-asset-transfer
//   npm install
//   cp .env.example .env   # then fill in
//   pm2 start ecosystem.config.cjs
//   pm2 save                # so it restarts on Mac Mini reboot
//   pm2 startup             # follow the printed instructions
//
// Tail logs:    pm2 logs social-asset-transfer
// Restart:      pm2 restart social-asset-transfer
// Stop:         pm2 stop social-asset-transfer

module.exports = {
  apps: [
    {
      name: "social-asset-transfer",
      script: "./index.js",
      cwd: __dirname,
      interpreter: "node",
      // Single instance — see comment in index.js about why we don't
      // parallelise. Run multiple instances by copying this block with
      // a different name + WORKER_ID env if throughput ever requires.
      instances: 1,
      exec_mode: "fork",
      // Load .env so we don't have to inject vars into PM2 separately.
      // node --env-file= is Node 20.6+; pin engines.node accordingly.
      node_args: ["--env-file=.env"],
      // PM2 sends SIGTERM then waits this long before SIGKILL.
      kill_timeout: 30000,
      // Restart on crash, but back off so a broken state doesn't spin
      // forever burning Slack credits.
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // Rotate logs out so /var/log doesn't fill on a long-running mini.
      max_memory_restart: "1500M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
