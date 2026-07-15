import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Hacker News Monitor — scans Front Page, Show HN, and New HN a few times a
 * day for agent-infrastructure signals and posts a digest to Slack, Telegram,
 * or both. Configuration-driven:
 * set SLACK_CHANNEL, TELEGRAM_CHAT, or both — the handler delivers to
 * whichever targets are configured.
 *
 * Retains ~30 days of digests; @mention it in Slack, DM it over the relay, or
 * message it on Telegram to discuss findings. Post-specific questions hydrate
 * the current HN story plus its top comments before answering.
 */
export default definePersona({
  id: 'hn-monitor',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'Scans Front Page, Show HN, and New HN for high-signal agent infrastructure, orchestration, coding-agent, and developer-tooling stories; posts a rich threaded digest to Slack or Telegram and answers follow-up questions with live HN details and top comments.',
  cloud: true,

  // Optional integrations (workforce#252): each transport is `optional` and gated
  // by `enabledByInput`, so its provider connection + trigger registration happen
  // ONLY when the matching id input is set. Set SLACK_CHANNEL, TELEGRAM_CHAT, or
  // both — a Slack-only deploy never has to wire up a Telegram bot, and vice
  // versa. The handler delivers to whichever targets are configured.
  integrations: {
    slack: {
      optional: true,
      enabledByInput: 'SLACK_CHANNEL',
      scope: { paths: '/slack/channels/**' }
    },
    telegram: {
      optional: true,
      enabledByInput: 'TELEGRAM_CHAT',
      scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' }
    }
  },

  inputs: {
    TOPICS: {
      description: 'Comma-separated interests added to the built-in agentic relevance profile. Broad terms only count when the title also has agent/software context.',
      env: 'TOPICS',
      default: 'AI agents,coding agents,multi-agent,agent orchestration,agent workflows,agent runtime,agent memory,MCP,Claude Code,Codex,Cursor,software factory,developer tooling'
    },
    LOOKBACK_HOURS: {
      description: 'How far back New HN and Show HN scans should look. The default overlaps the twice-daily cadence so overnight stories are not missed.',
      env: 'LOOKBACK_HOURS',
      default: '24'
    },
    MAX_STORIES: {
      description: 'Maximum number of fresh, relevance-ranked stories in one digest.',
      env: 'MAX_STORIES',
      default: '8'
    },
    SLACK_CHANNEL: {
      description: 'Slack channel id to post the digest to. Leave empty to skip Slack delivery.',
      env: 'SLACK_CHANNEL',
      optional: true,
      picker: { provider: 'slack', resource: 'channels' }
    },
    TELEGRAM_CHAT: {
      description: 'Telegram chat id to post the digest to (and answer Q&A in). Leave empty to skip Telegram delivery.',
      env: 'TELEGRAM_CHAT',
      optional: true
    }
  },

  useSubscription: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: [
    'You are the Hacker News radar for the Agent Relay team.',
    'The team builds agent messaging and coordination, multi-agent orchestration, cloud agent runtimes, sandboxes, coding-agent workflows, memory/context infrastructure, and open-source developer tools.',
    'Be selective and concrete: explain why a story matters to builders in that space, avoid generic AI hype, and never invent details beyond the supplied HN metadata or live comments.',
    'For chat, distinguish article claims from HN community reactions and link back to the article and HN discussion.'
  ].join(' '),
  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },

  relay: { inbox: ['@self'] },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  capabilities: {
    httpRead: {
      allow: [
        { method: 'GET', urlGlob: 'https://hn.algolia.com/api/v1/search*' },
        { method: 'GET', urlGlob: 'https://hn.algolia.com/api/v1/search_by_date*' },
        { method: 'GET', urlGlob: 'https://hn.algolia.com/api/v1/items/*' },
      ],
    },
  },

  onEvent: './agent.ts'
});
