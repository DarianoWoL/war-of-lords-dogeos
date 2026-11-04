// pm2: wersja demo dla jury (osobna od produkcyjnej war-of-lords). Uruchamiane z katalogu /home/deploy/wol-dogeos.
module.exports = {
  apps: [
    { name: 'wol-dogeos', script: 'src/server.js', cwd: __dirname + '/../..', max_memory_restart: '600M', env: { NODE_ENV: 'production', DEMO_FILL: 'on' } },
    { name: 'wol-dogeos-bots', script: 'chain/scripts/demo-players.js', args: '"Mini Tournament · 30 min" 9', cwd: __dirname + '/../..', env: { BASE: 'http://127.0.0.1:3300', ONDEMAND: '1', NAME_OFFSET: '0' } },
    { name: 'wol-dogeos-bots2', script: 'chain/scripts/demo-players.js', args: '"Mini Tournament · 1 hour" 9', cwd: __dirname + '/../..', env: { BASE: 'http://127.0.0.1:3300', ONDEMAND: '1', NAME_OFFSET: '9' } }
  ]
};
