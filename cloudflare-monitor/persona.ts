import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'cloudflare-monitor',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'Watches the relayfile-cloud Cloudflare infrastructure spend and usage — D1 rows read/written, R2 storage costs, queuing throughput, and Worker error rates — via the relayfile VFS usage feeds and posts a Slack alert when thresholds are exceeded. Can also answer questions about current Cloudflare resource usage via relay inbox.',
  cloud: true,

  harness: 'opencode',
  // This persona answers through ctx.llm. While an Anthropic credential backs
  // ctx.llm this pin is not used: resolveModel() gates on credential family, and
  // credentialMatchesPersonaFamily('anthropic', 'opencode') is false, so it falls
  // through to the default Anthropic model. Cloud refuses to back ctx.llm with an
  // opencode subscription ("harness-only") and stamps Anthropic instead.
  //
  // Corrected anyway, because the pin becomes live the moment either an
  // opencode-family credential is present or something here calls
  // ctx.harness.run(). `deepseek-v4-flash-free` is on the `opencode` provider,
  // which this workspace's OpenCode Go key does not authorize, and it fails with
  // an opaque `UnknownError: Unexpected server error` naming neither the model
  // nor the credential.
  model: 'opencode-go/mimo-v2.5',
  systemPrompt:
    'You are a Cloudflare spend and usage monitor for the relayfile-cloud service. Answer questions about current Cloudflare resource usage (D1 query volume, R2 storage, queue throughput, Worker metrics) concisely using Slack markdown. When no question is asked, summarize any active alerts.',

  useSubscription: true,

  integrations: {
    cloudflare: {
      scope: {
        d1: '/cloudflare/d1/**',
        'd1-usage': '/cloudflare/d1/usage/**',
        r2: '/cloudflare/r2/**',
        'r2-usage': '/cloudflare/r2/usage/**',
        queues: '/cloudflare/queues/**',
        'queues-usage': '/cloudflare/queues/usage/**',
        workers: '/cloudflare/workers/**',
      }
    },
    slack: { scope: { paths: '/slack/channels/**' } }
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'Team Slack channel id to post alerts to.',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' }
    },
    D1_ROWS_READ_THRESHOLD: {
      description: 'Alert when a D1 database exceeds this many rows read in a 24h window.',
      env: 'D1_ROWS_READ_THRESHOLD',
      default: '1000000'
    },
    D1_ROWS_WRITTEN_THRESHOLD: {
      description: 'Alert when a D1 database exceeds this many rows written in a 24h window.',
      env: 'D1_ROWS_WRITTEN_THRESHOLD',
      default: '100000'
    },
    R2_STORAGE_GB_THRESHOLD: {
      description: 'Alert when an R2 bucket exceeds this many GB of storage.',
      env: 'R2_STORAGE_GB_THRESHOLD',
      default: '100'
    },
    QUEUE_UNACKED_THRESHOLD: {
      description: 'Alert when a queue has more than this many unacknowledged messages.',
      env: 'QUEUE_UNACKED_THRESHOLD',
      default: '1000'
    }
  },

  harnessSettings: { reasoning: 'medium', timeoutSeconds: 120 },
  relay: { inbox: ['@self'] },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 90 },

  onEvent: './agent.ts'
});
