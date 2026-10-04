module.exports = {
  apps: [{
    name: 'prepmyjob',
    script: 'server/server.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    max_memory_restart: '200M',
    env: { NODE_ENV: 'production' },
  }],
};
