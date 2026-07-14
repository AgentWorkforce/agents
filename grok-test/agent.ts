import { defineAgent } from '@agentworkforce/runtime';

/**
 * grok-test — no-op handler. This persona is a throwaway for manually
 * verifying the Grok/xAI browser connect flow in the deploy wizard; it is
 * never actually deployed/run, so no triggers are declared.
 */
export default defineAgent({
  handler: async () => {
    return;
  }
});
