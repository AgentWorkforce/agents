import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Repo Hygiene Agent — watches PRs for duplicated/dead code, divergent paths,
 * stale skills/rules/docs, and code smells. It journals each run to Notion and
 * leaves a concise PR comment with findings.
 */
export default definePersona({
  id: 'repo-hygiene',
  intent: 'review',
  tags: ['review', 'discovery', 'documentation'],
  description: 'Reviews opened and updated PRs for duplicated/dead code, divergent implementation paths, stale skills/rules/docs, and code smells; posts concise findings and journals the run to Notion.',
  cloud: true,
  useSubscription: true,

  integrations: {
    github: {},
    // github above is mounted via the agent's triggers; notion and slack
    // have no triggers, so `scope` is the only thing that mounts them —
    // without it the Notion journal write and the Slack summary post are
    // silent no-ops. The database is picked at deploy (NOTION_DATABASE_ID),
    // so scope the databases subtree.
    notion: { scope: { paths: '/notion/databases/**' } },
    slack: { scope: { paths: '/slack/channels/**' } }
  },

  inputs: {
    NOTION_DATABASE_ID: {
      description: 'Notion database id where repo hygiene run journals are created.',
      env: 'NOTION_DATABASE_ID'
    },
    SLACK_CHANNEL: {
      description: 'Optional Slack channel id for high-level hygiene updates.',
      env: 'SLACK_CHANNEL',
      optional: true,
      picker: { provider: 'slack', resource: 'channels' }
    },
    MAX_DIFF_CHARS: {
      description: 'Maximum PR diff characters included in the diagnostic prompt.',
      env: 'MAX_DIFF_CHARS',
      default: '40000'
    }
  },

  harness: 'codex',
  model: 'gpt-5.5',
  systemPrompt: [
    'You are a senior codebase hygiene reviewer.',
    'Focus on duplicated or dead code, divergent paths that should be consolidated, stale skills/rules/docs, and concrete code smells.',
    'Prefer high-signal findings with evidence over broad style feedback.',
    'Do not edit files unless a future handler explicitly asks for fix mode.'
  ].join(' '),
  harnessSettings: {
    reasoning: 'high',
    timeoutSeconds: 1800,
    sandboxMode: 'read-only',
    workspaceWriteNetworkAccess: false
  },

  memory: { enabled: true, scopes: ['workspace'], ttlDays: 180 },

  onEvent: './agent.ts'
});
