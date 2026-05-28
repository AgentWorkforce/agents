---
name: orchestrating-agent-relay
description: The canonical way to run agent-relay - self-bootstrap the broker and autonomously spawn, monitor, and coordinate a team of worker agents without human intervention. Covers infrastructure startup, agent spawning, lifecycle monitoring, CLI-first reading, and team coordination.
---

# Orchestrating Agent Relay

Self-bootstrap agent-relay infrastructure and manage a team of agents autonomously.

## Overview

A headless orchestrator is an agent that:

1. Starts the relay infrastructure itself (`agent-relay up`)
2. Spawns and manages worker agents
3. Monitors agent lifecycle events
4. Coordinates work without human intervention

The orchestrator drives the team **from outside** and is **not** a
registered relay agent, so it reads/sends/lists via the `agent-relay` CLI
(MCP `mcp__relaycast__message_*` tools require a registered identity). The
workers it spawns _are_ registered participants — their peer-messaging
reference is the **`using-agent-relay`** skill.

## When to Use

- Agent needs full control over its worker team
- No human available to run `agent-relay up` manually
- Agent should manage agent lifecycle autonomously
- Building self-contained multi-agent systems

## Quick Reference

| Step                               | Command/Tool                                            |
| ---------------------------------- | ------------------------------------------------------- |
| Verify installation                | `command -v agent-relay` or `npx agent-relay --version` |
| Verify Node runtime if shim fails  | `node --version` or fix mise/asdf first                 |
| Start infrastructure               | `agent-relay up --no-dashboard --verbose`               |
| Check status                       | `agent-relay status --wait-for=10`                      |
| Spawn worker                       | `agent-relay spawn Worker1 claude "task"`               |
| List workers                       | `agent-relay who`                                       |
| View worker logs                   | `agent-relay agents:logs Worker1`                       |
| Send DM to worker                  | `agent-relay send Worker1 "message"`                    |
| Post to channel                    | `agent-relay send '#general' "message"`                 |
| Read worker DM replies (full text) | `agent-relay replies Worker1` (add `--json` to parse)   |
| Read full DM conversation history  | `agent-relay history --to Worker1`                      |
| Release worker                     | `agent-relay release Worker1`                           |
| Stop infrastructure                | `agent-relay down`                                      |

## Bootstrap Flow

### Step 0: Verify Installation

```bash
# Check if agent-relay is available
command -v agent-relay || npx agent-relay --version

# If your shell reports a mise/asdf shim error, fix Node first
node --version
# e.g. for mise: mise use -g node@22.22.1

# If not installed, install globally
npm install -g agent-relay

# Or use npx (no global install)
npx agent-relay --version
```

### Step 1: Start Infrastructure

```bash
# Starts a detached broker in headless mode and returns after API readiness
agent-relay up --no-dashboard --verbose
```

Verify broker readiness before spawning any workers:

```bash
# Must show "RUNNING" before you spawn workers
agent-relay status --wait-for=10
```

When verifying from a source checkout or throwaway git worktree, run these
commands from the project/worktree root. The CLI writes runtime state to
`.agent-relay/` and may create `.mcp.json`; clean those files after validation
if the worktree should remain clean.

The broker:

- Auto-creates a Relaycast workspace if `RELAY_API_KEY` not set
- Removes `CLAUDECODE` env var when spawning (fixes nested session error)
- Persists state to `.agent-relay/`

### Step 2: Spawn Workers via MCP

```text
mcp__relaycast__agent_add(
  name: "Worker1",
  cli: "claude",
  task: "Implement the authentication module following the existing patterns"
)
```

CLI equivalent:

```bash
agent-relay spawn Worker1 claude "Implement the authentication module following the existing patterns"
```

> **Expect a 30–60s gap between spawn and the first ACK.** A worker shows
> `online` in `who --json` within ~5s (the process is up), but the underlying
> CLI (claude/codex) is still cold-starting and won't send its ACK DM until it
> finishes booting — typically 30–45s, occasionally longer, after `online`.
> `online` means "process alive," **not** "agent responsive." Don't treat
> ACK silence in the first minute as a stuck worker; size ACK-wait loops for
> at least 60s (e.g. a 30-iteration poll) before escalating to troubleshooting.

### Step 3: Monitor and Coordinate

```bash
# Read Worker1's DM replies (chronological, full text, untruncated)
agent-relay replies Worker1

# Machine-readable: full text + direction, safe to parse in a loop
agent-relay replies Worker1 --json

# Send a targeted DM to a specific worker
agent-relay send Worker1 "Also add unit tests"

# Broadcast to all agents on a channel
agent-relay send '#general' "All workers: wrap up current task"

# List active workers (structured status for polling)
agent-relay who --json
```

> **The spawning orchestrator is not a registered relaycast agent.**
> The `mcp__relaycast__message_*` / `agent_list` MCP tools require a
> registered identity and fail for you with the error
> `Not registered. Call agent.register first.`
> Use the `agent-relay` CLI for all reading, sending, and listing, and add
> `--json` to any read command (`replies`, `history`, `who`) when you need
> full, untruncated, parseable output.

### Step 4: Release Workers

```text
mcp__relaycast__agent_remove(name: "Worker1")
```

### Step 5: Shutdown (optional)

```bash
agent-relay down
```

## CLI Commands for Orchestration

**Use the `agent-relay` CLI extensively for monitoring and managing workers.** The CLI provides essential visibility into agent activity.

### Channel vs DM — When to Use Each

**DM** — targeted, private, for responses you need to read back:

- `agent-relay send Worker1 "message"` — sends a DM to Worker1
- `mcp__relaycast__message_dm_send(to: "Worker1", text: "...")` — same via MCP
- Worker replies arrive as DMs back to the sender

**Channel post** — broadcast, visible to all agents on that channel:

- `agent-relay send '#general' "message"` — posts to #general (`#` prefix required)
- `mcp__relaycast__message_post(channel: "general", text: "...")` — same via MCP
- Use for coordination messages, status updates, announcements

**`agent-relay replies <agent>` is the canonical command for reading worker
DM replies** — it returns full text, sender-attributed, in chronological
order, with no truncation. Add `--json` for machine-readable output.

`inbox --agent <name>` is legacy unread-only behavior; once read, entries
disappear. Prefer `replies` for a persistent, complete view.

#### `replies --json` schema (read this before writing a monitor)

Verified against the agent-relay CLI source (`replies` command). When there
**is** a conversation, `--json` prints a JSON array of message objects:

```json
[
  {
    "id": "01J...",
    "from": "Implementer",
    "to": "orchestrator",
    "text": "ACK — starting on the auth module",
    "createdAt": "2026-05-19T14:02:11.000Z",
    "direction": "inbound"
  }
]
```

`unread` (boolean) and/or `unread_state: "unknown"` may also be present
depending on read-state availability. Footguns that will silently break a
naive monitor:

- **The timestamp field is `createdAt`, not `ts`/`timestamp`.** It is an
  ISO-8601 string.
- **In `replies --json`, `direction` is always the literal `"inbound"`** — it
  is hard-coded, because `replies` only ever returns messages _from_ the
  named agent. It is never `"incoming"`, `"from"`, `"in"`, nor `"outbound"`.
  Filtering on `direction == "inbound"` is harmless but redundant; filtering
  on any other literal yields a monitor that runs forever and never sees the
  ACK or DONE. (`"outbound"` only appears in `history --to <agent> --json`,
  which includes messages you sent — see below.)
- **The empty state is a plain string, not `[]`.** When there is _no
  conversation at all_, the command prints the literal line
  `No DM conversation with <Name>.` (exit 0) — not JSON. (If a conversation
  exists but no messages match the filters, `--json` does emit a valid `[]`.)
  Piping the no-conversation case straight into `jq` errors out. Guard for it:

  ```bash
  out=$(agent-relay replies Implementer --json)
  case "$out" in
    "No DM conversation with"*|"") echo "no replies yet" ;;
    *) echo "$out" | jq -r '.[] | "\(.createdAt) \(.direction) \(.text)"' ;;
  esac
  ```

- **Build monitors defensively: emit-all, then eyeball.** Print every entry
  with its `direction` and `createdAt` rather than hard-filtering inside
  `jq`. A monitor that shows everything beats one that silently drops the
  message you were waiting for because an assumption about the schema was
  wrong.

`history --to <agent> --json` uses the same object shape (`id`, `from`, `to`,
`text`, `createdAt`, `direction`) but `direction` is computed:
`"outbound"` for messages you (the reader identity) sent, `"inbound"` for the
agent's. Use it when you need both sides of the thread, not just the agent's
replies.

```bash
# WRONG — history (no flags) will not show DM replies from workers
agent-relay history

# RIGHT — read a worker's DM replies (full text, chronological)
agent-relay replies Worker1

# Machine-readable: full text + direction, safe to parse in a loop
agent-relay replies Worker1 --json

# Full DM conversation history with a worker (read + unread)
agent-relay history --to Worker1

# Channel evidence (diffs, grep counts, GO/NO-GO) — full text,
# untruncated, chronological; add --json to parse it programmatically
agent-relay history --to '#general' --json
```

(Reading via MCP `message_*` tools fails for you — see the "not a registered
relaycast agent" callout under Bootstrap Step 3.)

### Monitoring Workers (Essential)

Spawn/send/release commands are in the Quick Reference and Bootstrap Step 3 —
not repeated here. For monitoring specifically: poll `agent-relay who --json`
for structured liveness (pid, uptimeSecs, status) instead of scraping the
worker TTY, and use `agent-relay agents:logs <name>` to watch real-time output
when debugging.

> **Harness note: don't poll with a bare foreground `sleep`.** Many harnesses
> (Claude Code included) block a foreground `sleep` used to wait for ACK/DONE
> — e.g. `sleep 25; agent-relay replies ...` is rejected with a directive to
> use a backgrounded loop or a Monitor/until-loop instead. The inline
> `sleep`-based snippets shown elsewhere in this skill are illustrative of the
> *logic*; in a harnessed environment, run the wait loop with
> `run_in_background` (or the harness's Monitor + until-loop), polling
> `agent-relay replies <name> --json` and `agent-relay who --json` from inside
> the backgrounded loop rather than blocking the foreground on `sleep`.

### Troubleshooting

```bash
# Kill unresponsive worker
agent-relay agents:kill Worker1

# Re-check broker status
agent-relay status

# If a worker looks stuck, inspect its logs first
agent-relay agents:logs Worker1
```

**Tip:** Run `agent-relay agents:logs <name>` frequently to monitor worker progress and catch errors early.

## Orchestrator Instructions Template

Give your lead agent these instructions. The bootstrap/spawn/monitor commands
are in the Bootstrap Flow and Quick Reference above — the paste-worthy part is
the **Protocol**, the ruleset a lead agent can't infer from the command list:

```text
You are an autonomous orchestrator. Bootstrap the relay infrastructure
(Bootstrap Flow Steps 0–2), then spawn and manage workers per the
Quick Reference. Then enforce this protocol:

## Protocol
- Workers will ACK when they receive tasks — but expect a 30–60s cold-start
  gap after spawn: `who --json` shows `online` (~5s) well before the CLI is
  booted enough to send its first ACK. Don't troubleshoot a "stuck" fresh
  worker until at least 60s has passed
- Workers will send DONE when complete
- In a harnessed environment, never wait with a bare foreground `sleep`
  (it is blocked) — run ACK/DONE poll loops with run_in_background or a
  Monitor/until-loop, polling `replies --json` and `who --json` from inside it
- **ACK/DONE target: `orchestrator` (the auto-registered spawning identity) or
  the `#general` channel — NEVER `broker`.** `broker` is the broker's internal
  routing self-name, not a spawnable/DM-able agent: a worker DM to `broker` (and
  `agent-relay send broker`) fails with `Agent "broker" not found`. Write the
  worker task prompt to DM `orchestrator` (or post `#general`) — never "DM the
  broker"
- Tell every worker explicitly: do NOT self-remove/release after DONE — stay
  alive and idle so you can DM them review findings to fix
- After DONE, run a reviewer; on NO-GO, DM the findings back to the SAME
  worker. If the worker is gone, spawn a fresh one and re-inject branch +
  commit SHA + the full verdict
- Parse `replies --json` defensively: `direction` is always `"inbound"`,
  timestamp is `createdAt` (not `ts`), and the no-conversation state is a
  plain string, not `[]`
- Poll `agent-relay who --json` for worker liveness; set a wall-clock fallback
  so a silently-dead worker can't hang the loop
- Read worker DM replies with `agent-relay replies <name>` (`--json` to parse);
  plain `agent-relay history` shows channel posts only, never DM replies. See
  the "Channel vs DM" section for the full reading model
```

## Multi-Round Review Loops (DONE → NO-GO → fix → re-review)

Spawning, monitoring, and releasing a worker is the easy path. The hard part
the basic flow does **not** cover: a worker reports DONE, a reviewer comes
back NO-GO, and now the work has to go back. Plan for this topology before you
spawn anything.

### Workers must not self-remove until you tell them

A worker's natural hygiene instinct is to call `agent.remove` on itself right
after reporting DONE. That **kills the review→fix→re-review loop**: when the
reviewer returns NO-GO there is no agent left to send the findings to, so you
are forced to spawn a fresh worker and re-inject the entire context (branch,
commit, full verdict) instead of just DMing the existing one.

**Put this in every implementer/worker task prompt explicitly:**

```text
Do NOT call agent.remove / agent-relay release on yourself. Report DONE and
stay alive and idle. The orchestrator will send you review findings to fix,
or release you when the work is fully accepted. Self-removing before then
breaks the fix loop.
```

The "release when done" guidance elsewhere in this skill applies to the
**orchestrator** releasing workers — never to a worker releasing itself
mid-loop.

### The respawn-with-full-context fallback

If a worker did self-remove (or died), you cannot just DM it. Spawn a fresh
worker and re-inject everything it needs to act with no prior memory:

```bash
agent-relay spawn Implementer2 codex "Continuation of prior work. \
Branch: feature/auth. Last commit: <sha>. \
The reviewer returned NO-GO with these findings: <full verdict text>. \
Check out the branch, address every finding, re-run tests, report DONE. \
Do NOT self-remove — stay alive for re-review."
```

Always pass branch + commit SHA + the **complete** reviewer verdict. A fresh
worker has none of the loop's history; a summarized verdict loses the
specifics it needs to fix.

### Detecting a silently-dead worker

Monitors fire on **DMs only**. A worker that exits or self-removes produces no
DM, so the monitor just goes quiet — indistinguishable from a worker still
thinking. Defenses:

- Poll `agent-relay who --json` for liveness instead of inferring it from DM
  silence. A worker that vanishes from `who` is gone.
- `agent-relay agents:logs <name>` will show a self-issued `agent.remove` /
  release call — but it is noisy TTY scraping, a last resort, not a signal.
- Always set a wall-clock fallback (e.g. a ScheduleWakeup ~30 min out) so a
  silently-dead worker can't hang the loop forever waiting on a DM that will
  never arrive.

## Lifecycle Events

The broker emits these events (available via SDK subscriptions):

| Event                    | When                        |
| ------------------------ | --------------------------- |
| `agent_spawned`          | Worker process started      |
| `worker_ready`           | Worker connected to relay   |
| `agent_idle`             | Worker waiting for messages |
| `agent_exited`           | Worker process ended        |
| `agent_permanently_dead` | Worker failed after retries |

## Common Mistakes

| Mistake                                                  | Fix                                                                                                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-relay: command not found` or mise/asdf shim error | Ensure Node is available first (`node --version`); if a shim is broken, fix the runtime manager, then install/use `agent-relay`                                                                |
| "Nested session" error                                   | Broker handles this automatically; if running manually, unset `CLAUDECODE` env var                                                                                                             |
| Broker not starting                                      | Try `agent-relay down` first, then `agent-relay up --no-dashboard --verbose` and `agent-relay status --wait-for=10`                                                                            |
| Broker shows STARTING after `status --wait-for`          | The process is alive but the broker API is not ready; inspect logs, retry readiness, or restart with `agent-relay down --force` if it remains stuck                                            |
| Broker shows STOPPED immediately after start             | Check `ps aux \| grep agent-relay-broker` and `.agent-relay/connection.json`; if the process is alive but status is STOPPED, rerun status from the project root or pass `--state-dir`          |
| Half-started broker: process alive but `status` says STOPPED and `Failed to read broker connection metadata` | `up` spawned a broker that never finished writing connection metadata (readiness timed out) and was not cleaned up. Do NOT just retry `up` — it won't reap the orphan. `pkill -f agent-relay-broker` (or `agent-relay down --force`), delete `.agent-relay/`, then `agent-relay up` clean and `agent-relay status --wait-for=30`. `agent-relay doctor` flags this orphaned/half-started state |
| Worktree verification leaves git status dirty            | Run `agent-relay down --force`, then remove generated `.agent-relay/` and `.mcp.json` from throwaway validation worktrees before committing                                                    |
| Spawn fails with `internal reply dropped`                | Broker likely is not fully ready yet; wait for readiness, then spawn one worker first                                                                                                          |
| Workers not connecting                                   | Ensure broker started; check `agent-relay who` and worker logs                                                                                                                                 |
| Not monitoring workers                                   | Use `agent-relay agents:logs <name>` frequently to track progress                                                                                                                              |
| Workers seem stuck                                       | Check logs with `agent-relay agents:logs <name>` for errors                                                                                                                                    |
| Messages not delivered                                   | Check `agent-relay history --to '#general' --json` for channel messages; use `agent-relay replies <name> --json` for DMs                                                                       |
| Worker replies not showing in history                    | Expected — plain `history` only shows channel posts. Use `agent-relay replies <name>` (full text, chronological) or `agent-relay history --to <name>` (full thread) to read DM replies         |
| Need to see unread DM content                            | `inbox_check` / `inbox --agent` only return counts or clear on read, and the MCP `message_dm_list` tool requires a registered identity you don't have. Use `agent-relay replies <name> --json` |
| Re-reading already-read replies                          | `agent-relay replies <name>` is a persistent view (not unread-only); use `--since <time>` to narrow, or `agent-relay history --to <name>` for the full thread                                  |
| Sent to wrong destination                                | `agent-relay send Worker1 "..."` = DM; `agent-relay send '#general' "..."` = channel broadcast. The `#` prefix is required for channels                                                        |
| Worker DM to `broker` fails with `Agent "broker" not found` | Expected — `broker` is the broker's internal routing self-name, not a DM-able agent. Workers must ACK/DONE to `orchestrator` or `#general`. Fix the worker task prompt; never instruct "DM the broker" |
| `status` says `RUNNING`/`Agents: N` but `who --json`/`send`/`replies`/`history` return `[]` or `Failed to query broker session` / `typo in the url or port?` | `status` reads the persisted state file; the others do a live RPC. The CLI is dialing a **stale/wrong broker** — leftover `.agent-relay/connection.json` from a prior run on an old port, or a second broker process. `ps aux \| grep -c '[a]gent-relay-broker'` (>1 ⇒ kill extras), compare `.agent-relay/connection.json` to the actual listening port, then `agent-relay down --force`, delete `.agent-relay/`, `agent-relay up` clean. `agent-relay doctor` diagnoses this |
| `Invalid agent token` from the orchestrator CLI while broker + workers keep working | The orchestrator shell has an **unresolved `${RELAY_API_KEY}`-style template** being used as a literal key (broker/workers hold real tokens). Ensure `RELAY_API_KEY` is actually resolved in the orchestrator env; `agent-relay doctor` reports broker auth state |
| Monitor never sees ACK/DONE                              | In `replies --json`, `direction` is always the literal `"inbound"` (never `"incoming"`/`"from"`/`"outbound"`); timestamp field is `createdAt`, not `ts`. See the `replies --json` schema section |
| `jq` errors on empty `replies --json`                    | Empty state is the plain string `No DM conversation with <Name>.`, not `[]`. Guard before piping to `jq`                                                                                      |
| Worker self-removed; can't send review fixes             | Instruct workers not to self-remove until told. If already gone, spawn a fresh worker and re-inject branch + commit SHA + full verdict (see Multi-Round Review Loops)                          |
| Worker died silently; loop hangs                         | DM monitors fire on DMs only. Poll `agent-relay who --json` for liveness and set a wall-clock fallback (~30 min ScheduleWakeup)                                                                |
| New worker `online` but no ACK yet; assumed stuck        | Expected — `online` means process up (~5s); the CLI cold-starts for another 30–45s before its first ACK DM. Wait ≥60s before troubleshooting a fresh worker                                    |
| Harness blocks `sleep 25; agent-relay replies ...`       | Bare foreground `sleep` wait loops are disallowed in harnessed environments. Run the poll loop with `run_in_background` (or Monitor + until-loop); the inline `sleep` snippets show logic only  |

## Prerequisites

1. **agent-relay CLI installed** (required)

   ```bash
   npm install -g agent-relay
   # Or use npx without installing: npx agent-relay <command>
   ```

2. **For spawning Claude agents**: Valid Anthropic credentials
   - Set `ANTHROPIC_API_KEY` or authenticate via `claude auth login`

3. **For MCP tools** (optional): Relaycast MCP server configured in Claude's MCP settings
