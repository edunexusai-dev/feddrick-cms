const cronTasks = require('./cron-tasks');

module.exports = ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  proxy: env.bool('PROXY_ENABLED', false),
  // Public origin behind the reverse proxy (absolute admin and media URLs), e.g. https://cms.example.edu
  url: env('PUBLIC_URL', ''),
  app: {
    keys: env.array('APP_KEYS'),
  },
  // Scheduled publishing runs inside the CMS (config/cron-tasks.js).
  cron: {
    enabled: env.bool('CRON_ENABLED', true),
    tasks: cronTasks,
  },
  webhooks: {
    populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
  },
});
