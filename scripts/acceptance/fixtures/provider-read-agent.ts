import { slackClient } from '@relayfile/relay-helpers';
import { defineAgent } from '@agentworkforce/runtime';

export default defineAgent({
  schedules: [{ name: 'scan', cron: '0 9 * * *', tz: 'UTC' }],
  handler: async () => {
    await slackClient().messages.list({ channelId: 'C123' });
  },
});
