import { defineAgent } from '@agentworkforce/runtime';
import { handleHnMonitorEvent } from '../hn-monitor/agent.js';

export default defineAgent({
  schedules: [{ name: 'scan', cron: '0 9,17 * * *', tz: 'America/New_York' }],
  triggers: {
    telegram: [{ on: 'message' }]
  },
  handler: handleHnMonitorEvent
});
