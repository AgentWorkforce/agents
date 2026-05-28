---
name: orchestrating-agent-relay
description: The canonical way to run agent-relay - self-bootstrap the broker and autonomously spawn, monitor, and coordinate a team of worker agents without human intervention. Covers infrastructure startup, agent spawning, lifecycle monitoring, CLI-first reading, and team coordination.
---

### Overview

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

### When to Use

- Agent needs full control over its worker team
- No human available to run `agent-relay up` manually
- Agent should manage agent lifecycle autonomously
- Building self-contained multi-agent systems

### Quick Reference

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

### Bootstrap Flow

#### Step 0: Verify Installation

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

#### Step 1: Start Infrastructure

```bash
# Starts a detached broker in headless mode and returns after API readiness
agent-relay up --no-dashboard --verbose
```

#### Step 2: Spawn Workers via MCP

```text
mcp__relaycast__agent_add(
  name: "Worker1",
  cli: "claude",
  task: "Implement the authentication module following the existing patterns"
)
```

#### Step 3: Monitor and Coordinate

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

#### Step 4: Release Workers

```text
mcp__relaycast__agent_remove(name: "Worker1")
```

#### Step 5: Shutdown (optional)

```bash
agent-relay down
```


### CLI Commands for Orchestration

#### `replies --json` schema (read this before writing a monitor)

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

#### Troubleshooting

```bash
# Kill unresponsive worker
agent-relay agents:kill Worker1

# Re-check broker status
agent-relay status

# If a worker looks stuck, inspect its logs first
agent-relay agents:logs Worker1
```


### Orchestrator Instructions Template

#### Give your lead agent these instructions. The bootstrap/spawn/monitor commands

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


### Multi-Round Review Loops (DONE → NO-GO → fix → re-review)

#### Workers must not self-remove until you tell them

```text
Do NOT call agent.remove / agent-relay release on yourself. Report DONE and
stay alive and idle. The orchestrator will send you review findings to fix,
or release you when the work is fully accepted. Self-removing before then
breaks the fix loop.
```

#### The respawn-with-full-context fallback

```bash
agent-relay spawn Implementer2 codex "Continuation of prior work. \
Branch: feature/auth. Last commit: <sha>. \
The reviewer returned NO-GO with these findings: <full verdict text>. \
Check out the branch, address every finding, re-run tests, report DONE. \
Do NOT self-remove — stay alive for re-review."
```


### Lifecycle Events

The broker emits these events (available via SDK subscriptions):

| Event                    | When                        |
| ------------------------ | --------------------------- |
| `agent_spawned`          | Worker process started      |
| `worker_ready`           | Worker connected to relay   |
| `agent_idle`             | Worker waiting for messages |
| `agent_exited`           | Worker process ended        |
| `agent_permanently_dead` | Worker failed after retries |

### Common Mistakes

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

### Overview

Self-bootstrap agent-relay infrastructure and manage a team of agents autonomously.

### Prerequisites

#### 1. **agent-relay CLI installed** (required)

```bash
npm install -g agent-relay
   # Or use npx without installing: npx agent-relay <command>
```
