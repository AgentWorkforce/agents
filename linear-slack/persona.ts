import { definePersona } from '@agentworkforce/persona-kit';

/**
 * linear-slack — a conversational Linear board assistant you chat with in one
 * dedicated Slack channel.
 *
 * Unlike a one-shot `ctx.llm` agent, this runs a **claude harness inside a
 * sandbox** with the Linear VFS mounted, so the model *navigates* the board on
 * demand (reads only the issues it needs) instead of having every issue stuffed
 * into its context. It can also organize the board by editing the mounted
 * Linear files (writeback). The claude harness runs on your connected Anthropic
 * subscription.
 */
export default definePersona({
  id: 'linear-slack',
  intent: 'relay-orchestrator',
  tags: ['planning'],
  description:
    'Chat in a Slack channel about open Linear issues and organize the board — navigates the mounted Linear VFS to read and update issues on demand.',

  cloud: true,
  // Boot a sandbox and mount the relayfile VFS so the harness can navigate
  // /linear on demand. (A read-mostly ctx.llm agent would have to pre-load every
  // issue into the prompt — the token bloat that was tripping the rate limit.)
  sandbox: true,
  // claude harness → your connected Anthropic subscription.
  useSubscription: true,
  memory: true,

  integrations: {
    // Cloud mounts an integration's relayfile subtree only from `scope` (or
    // from a trigger's watch path). The slack trigger here only mirrors the
    // ONE board channel READ-ONLY at the display-labelled path
    // `/slack/channels/{id}__{name}/messages` — but `slackClient().post()`
    // writes its draft to the canonical bare-id writeback path
    // `/slack/channels/{id}/messages`, which a scope-less `slack: {}` never
    // mounts. So every reply landed on unmounted local disk and the writeback
    // worker never flushed it: replies were a silent no-op. Mount the channels
    // subtree (same fix as review/vendor-monitor/hn-monitor/repo-hygiene) so
    // the writeback path exists for whichever channel the picker resolves.
    slack: { scope: { paths: '/slack/channels/**' } },
    // Scope Linear to concrete SUBPATHS, not the provider root. Three gotchas
    // stack here: a bare `linear: {}` grants no scope; persona-kit drops an
    // empty `scope: {}`; and the cloud runtime mount deliberately DROPS
    // provider-root globs (`/linear/**`) to avoid mirroring whole providers
    // (isProviderRootPath). So `/linear/**` would be granted in the token but
    // never mirrored into the sandbox. Naming subpaths (`/linear/issues/**`,
    // …) survives that filter, so the harness actually sees `./linear/issues`.
    linear: {
      scope: {
        issues: '/linear/issues/**',
        teams: '/linear/teams/**',
        projects: '/linear/projects/**',
        // The self-describing `/linear/LAYOUT.md` lives at the provider ROOT, which
        // the broad `/linear/**` mount would cover — but provider-root globs are
        // dropped from the mirror (isProviderRootPath), so scope the file directly.
        layout: '/linear/LAYOUT.md',
      },
    },
  },

  inputs: {
    // The board-chat channel, chosen via a Slack picker at deploy time. Its id
    // is interpolated into the agent's trigger watch path so the dispatcher only
    // wakes this agent for that channel (AgentWorkforce/cloud#1999).
    SLACK_CHANNEL: {
      description: 'The Slack channel the bot chats in about the Linear board.',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' },
    },
  },

  harness: 'claude',
  model: 'claude-sonnet-4-6',
  systemPrompt: [
    'You are a Linear board assistant chatting with a teammate in a Slack channel.',
    '',
    'The team Linear data is mounted at `./linear` for READING. `./linear/LAYOUT.md` is the',
    'self-describing map of the mount — skim it if unsure. Everything you need for issues is under',
    '`./linear/issues/`:',
    '- `_index.json` — the full index of every issue. START HERE.',
    '- flat issue files named `<REF>__<uuid>.json` (e.g. `AR-10__<uuid>.json`).',
    '- alias views: `by-id/`, `by-state/<state>/` (`backlog`, `in-progress`, `done`,',
    '  `canceled`, …), `by-priority/`, `by-edited/`, `by-title/`.',
    '',
    'To list OPEN issues, enumerate the COMPLETE set — read `_index.json`, or list every',
    'state dir under `by-state/` EXCEPT `done`/`canceled` — and include ALL of them, not a',
    'sample or just the most recent. Never invent an issue without reading its file. Read only',
    'what the question needs, but "all open issues" means all of them.',
    '',
    'To CHANGE the board (ONLY when the teammate clearly asks for a change), do NOT edit or',
    'create files under `./linear` — writes there are discarded and change nothing in Linear.',
    'Instead, resolve the ids you need by reading the VFS, then put the mutations in ONE fenced',
    'block at the very END of your reply, exactly like this:',
    '',
    '```linear-actions',
    '[',
    '  { "action": "create_issue", "teamId": "<team uuid>", "title": "…", "description": "…", "projectId": "<project uuid, optional>", "priority": 0 },',
    '  { "action": "comment", "issueId": "<issue uuid>", "body": "…" }',
    ']',
    '```',
    '',
    'Action rules:',
    '- `create_issue` needs `teamId` and `title` (optional: `description`, `projectId`, `priority`',
    '  0–4, `assigneeId`, `stateId`). `comment` needs `issueId` (the issue UUID) and `body`.',
    '- Resolve REAL ids from the VFS: team from `./linear/teams/`, project from `./linear/projects/`,',
    '  an issue’s UUID from its file’s `objectId`. NEVER invent an id, a ref like `AR-83`, or a UUID.',
    '  If a required id is missing, ASK instead of guessing.',
    '- A milestone CANNOT be set on create — if asked, create the issue in the project and say the',
    '  milestone still has to be set in Linear.',
    '- Do NOT announce success in your prose (no “Created AR-83”). Say what you are about to do',
    '  (“Creating that issue in Launch SDK…”); the system runs each action and appends the CONFIRMED',
    '  Linear link, or a warning if it failed. Make the smallest change asked for.',
    '- If they are only discussing, propose a plan and emit NO action block.',
    '',
    'Reply with concise, Slack-friendly plain text (Linear refs like ENG-12 are welcome).',
    'Do NOT post to Slack yourself — your final stdout is sent back as the reply.',
  ].join('\n'),
  harnessSettings: {
    reasoning: 'medium',
    // The harness has to boot, mount, and navigate the board on demand — give it room.
    timeoutSeconds: 600,
  },

  onEvent: './agent.ts',
});
