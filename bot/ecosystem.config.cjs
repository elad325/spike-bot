module.exports = {
  apps: [
    {
      name: 'spike-bot',
      script: './update-and-start.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s',
    },
  ],
};
