module.exports = {
  apps: [
    {
      name: "ipmr-telemetry-worker",
      script: "./index.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "1G",
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
