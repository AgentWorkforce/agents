/**
 * Slack chat transport for inbox-buddy.
 *
 * The canonical implementations live in `shared/slack.ts` (agents repo stopgap)
 * and will move to `@agentworkforce/delivery` once that package is bumped.
 * This file is a re-export shim so inbox-buddy's internal imports don't break.
 */
export {
  type SlackMessage,
  type SlackPoster,
  defaultSlack,
  readSlackMessage,
  stripLeadingMention,
  bareChannelId,
  conversationKeyForSlack,
  skipReason,
  postReply
} from '../../shared/slack.js';
