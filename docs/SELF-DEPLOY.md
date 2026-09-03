# Deploy these agents to your own workspace

Every agent listed in [`scripts/deploy/agents.json`](../scripts/deploy/agents.json)
can be deployed through this path — today that is every folder in the repo with a
`persona.ts`, and a test keeps the two in step. This guide takes you from a fork
to a running agent in **your** Agent Workforce workspace, without an interactive
login and without a terminal if you don't want one.

You need two secrets. The rest is a form in the Actions tab.

- [1. What you need first](#1-what-you-need-first)
- [2. Get the two secrets](#2-get-the-two-secrets)
- [3. Put them in GitHub](#3-put-them-in-github)
- [4. Deploy from the Actions tab](#4-deploy-from-the-actions-tab)
- [5. Give the agent its inputs](#5-give-the-agent-its-inputs)
- [6. Deploy from your own shell instead](#6-deploy-from-your-own-shell-instead)
- [7. When it fails](#7-when-it-fails)
- [8. Adding your own agent](#8-adding-your-own-agent)

---

## 1. What you need first

**An Agent Workforce workspace.** If you don't have one, create it at
<https://agentrelay.com/cloud>. A workspace is where deployed agents live, where
their integrations (Slack, Linear, GitHub, Gmail…) are connected, and what the
two secrets below identify.

**The integrations your chosen agent needs, already connected in that
workspace.** CI deploys with `--no-connect`, which reuses connections that
already exist and refuses to start an OAuth flow — a browser consent screen is
not something a CI job can complete. [Section 7](#7-when-it-fails) covers what
that failure looks like and how to fix it once.

**Node 22+ and this repo**, if you want the local path in
[section 6](#6-deploy-from-your-own-shell-instead). The Actions path needs
neither.

---

## 2. Get the two values

| Name | What it is | Where it goes |
| --- | --- | --- |
| `WORKFORCE_WORKSPACE_ID` | Which workspace to deploy into (a UUID; not sensitive) | Environment **variable** |
| `WORKFORCE_WORKSPACE_TOKEN` | The token that authorises deploys into it (grants write; sensitive) | Environment **secret** |

These are the deploy CLI's documented headless-auth pair: when both are set, the
CLI skips the browser session entirely. That is the whole reason this works in
CI.

Both come from one login on your own machine:

```sh
npm install                 # the agentworkforce CLI is a devDependency of this repo
npx agentworkforce login    # opens your browser, then asks which workspace
```

`login` writes the workspace and its token to **`~/.agentworkforce/relay/workspaces.json`**
(created `0600`, readable only by you). The file looks like this:

```json
{
  "active": "your-workspace-name",
  "workspaces": {
    "your-workspace-name": { "key": "rk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
  }
}
```

Read the two values back out of it:

```sh
# WORKFORCE_WORKSPACE_ID
jq -r '.active' ~/.agentworkforce/relay/workspaces.json

# WORKFORCE_WORKSPACE_TOKEN  — prints a live credential, so don't do this on a shared screen
jq -r '.workspaces[.active].key' ~/.agentworkforce/relay/workspaces.json
```

If you have several workspaces, replace `.active` with the one you want:
`jq -r '.workspaces["other-workspace"].key' …`.

> **If `login` can't list your workspaces** (some accounts get a 403 on the
> workspace list), pass the workspace explicitly and it will skip the listing
> step: `npx agentworkforce login --workspace <id-or-slug>`.

Treat the token like a password. It authorises deploys into your workspace;
anyone holding it can deploy agents there. Nothing in this repo ever prints it —
the deploy script reports the *names* of missing secrets and the *names* of the
inputs it resolved, never their values.

---

## 3. Put them in GitHub

In **your fork**, go to **Settings → Environments → New environment**, name it
exactly:

```
workforce
```

Then add:

- `WORKFORCE_WORKSPACE_ID` under **Environment variables** (the workspace UUID
  is not sensitive; leaving it in variables keeps it visible in the run summary
  for debugging).
- `WORKFORCE_WORKSPACE_TOKEN` under **Environment secrets** (the token is
  sensitive and must never appear in logs).

The name `workforce` matters: the deploy job declares `environment: workforce`,
and that declaration is what makes both the variable and the secret resolve.
Get the name wrong and the job runs with *empty strings* rather than failing to
start — which is why the workflow checks for empty values in a dedicated step
and tells you exactly this.

An environment also gets you the optional extras: required reviewers before a
deploy runs, and a branch rule limiting which refs can deploy.

> **Repository secrets work too.** A job that references an environment can still
> read repository secrets, so you may put the two secrets at the repository level
> and leave the workflow alone; an environment secret of the same name simply
> takes precedence. Keep the `environment: workforce` line either way — deleting
> it also gives up the required-reviewer and branch protections above.

---

## 4. Deploy from the Actions tab

**Actions → Deploy agent → Run workflow.**

| Field | What to put |
| --- | --- |
| **agent** | The agent's name, exactly as listed in [`scripts/deploy/agents.json`](../scripts/deploy/agents.json) — e.g. `hn-monitor` |
| **agent-inputs** | Optional `KEY=VALUE` lines — see [section 5](#5-give-the-agent-its-inputs) |
| **dry-run** | Tick it for a rehearsal: compiles, resolves inputs, prints the deploy, and stops |

The run installs dependencies, runs the test suite and the typechecker, compiles
the persona, and deploys. Deploys are idempotent — dispatching the same agent
again updates the existing one rather than failing on the name it already took,
so re-running after a config change is the normal way to change an agent.

Start with **dry-run ticked**. It needs no secrets and no integrations, it
prints the exact command the real run will make, and because it compiles the
persona first it will also tell you if a required input is unset — before you
have wired up any secrets at all.

### Why dispatch-only

This repo is public, so anyone can open a pull request against it from a fork.
The deploy workflow therefore runs **only** on `workflow_dispatch`, which only
someone with write access to the repo can start.

Do not add `pull_request_target` — and do not add any trigger that runs a fork's
code with these secrets in scope. A fork PR can change the deploy script, or any
file the job executes, and a job holding `WORKFORCE_WORKSPACE_TOKEN` when it does
so hands over your workspace. There is a comment saying this at the top of the
workflow, and a test in `tests/deploy-agents.test.mjs` that fails if the trigger
ever appears.

If you fork this and want deploy-on-merge, add `push:` on **your own** default
branch. That runs your code, not a stranger's.

---

## 5. Give the agent its inputs

Agents are configured with **inputs** — a Slack channel to post in, a threshold
to alert on, a list of topics to watch. Every persona declares its own, so the
authoritative list for any agent is the `inputs` block in its `persona.ts`. Each
one gives you a description, the environment variable name it reads, whether it
has a default, and whether it is `optional`.

For example, [`vendor-monitor/persona.ts`](../vendor-monitor/persona.ts)
declares `VENDORS` (defaulted) and `SLACK_CHANNEL` (required, no default).

Rules the deploy script applies:

- An input with a **default** and no value set uses its default.
- An input marked **`optional`** and left unset is simply not passed. This is
  usually a feature switch: no `SLACK_CHANNEL`, no Slack delivery.
- Any **other** unset input fails the deploy *before* anything is deployed,
  naming the input, its description, and the environment variable to set.
- **Empty is unset.** A secret that exists but holds `""` counts as missing, so
  a mis-pasted secret fails loudly instead of deploying a misconfigured agent.

### Inputs that identify *you*, not a setting

A few agents watch a specific account: `daytona-monitor` (`DAYTONA_ORG_ID`),
`gcp-watcher` (`GCP_PROJECT_ID`), `neon-monitor` (`NEON_ORG_ID`), and
`pr-shepherd` (`ORG`). Their personas ship a default for these — and that
default is **this repo's owner's** org, project, or account, not yours.

Inheriting it would point your agent at someone else's infrastructure: at best
an authorisation error, at worst a monitor reporting on a tenant that isn't
yours. So `scripts/deploy/agents.json` lists those input names under
`requireExplicit`, and the deploy refuses to fall back to the persona default
for them:

```
✗ gcp-watcher: 1 required input(s) unresolved:
  GCP_PROJECT_ID — GCP project id to monitor.
    set env GCP_PROJECT_ID=<value>, or pass --input GCP_PROJECT_ID=<value>
    (this one identifies YOUR account or project. Its persona default points at
     someone else's, so this deploy will not inherit it.)
```

Set your own value and it deploys. If you add an agent whose persona defaults to
an org, project, or account id, add that input name to `requireExplicit` too — a
test fails if you don't.

Every input the deploy resolves is printed with **where it came from**
(`--input`, `AGENT_INPUTS`, `env NAME`, or `persona default`), so you can see at
a glance in a dry run whether anything is being inherited that shouldn't be.

### Three places to put them

They stack in this order, each overriding the one before:

1. **Repository variable `AGENT_INPUTS`** — Settings → Secrets and variables →
   Actions → Variables. Your standing defaults for every deploy.
2. **Secret `AGENT_INPUTS`** — same page, Secrets tab. For values that must stay
   masked in the run log, like an API token.
3. **The `agent-inputs` box on the dispatch form** — a one-off override for this
   run.

All three take the same format, one `KEY=VALUE` per line (`#` comments and blank
lines are ignored):

```
SLACK_CHANNEL=C0123ABCD
TOPICS=agent runtimes, evals
# lines below override lines above
```

**Anything you type into the dispatch form is visible in the run log.** A
channel id is fine there; a token is not — put that in the `AGENT_INPUTS`
secret, where GitHub masks it.

---

## 6. Deploy from your own shell instead

Same script, same flags, same result:

```sh
npm install

# See what is deployable.
node scripts/deploy/deploy-agents.mjs --list

# Rehearse: compiles, resolves inputs, prints the deploy. No secrets needed,
# nothing is deployed. (Compiling writes gitignored persona.json/agent-card.json.)
node scripts/deploy/deploy-agents.mjs --agent hn-monitor --dry-run

# Deploy for real.
export WORKFORCE_WORKSPACE_ID="$(jq -r '.active' ~/.agentworkforce/relay/workspaces.json)"
export WORKFORCE_WORKSPACE_TOKEN="$(jq -r '.workspaces[.active].key' ~/.agentworkforce/relay/workspaces.json)"
export SLACK_CHANNEL=C0123ABCD          # or: --input SLACK_CHANNEL=C0123ABCD
node scripts/deploy/deploy-agents.mjs --agent hn-monitor
```

Inputs resolve from the environment under the name each persona declares, so
`export SLACK_CHANNEL=…` is all a local deploy usually needs. `--input K=V`
overrides that for a single run, and `--all` deploys every agent in the registry.

There is also `npm run deploy -- --agent hn-monitor` if you prefer.

---

## 7. When it fails

**`missing headless auth: WORKFORCE_WORKSPACE_TOKEN`**
The secret is empty or absent. In Actions this nearly always means the
environment is named something other than `workforce`, or the secret was added
as a *repository* secret while the job asks for an *environment* one. Locally it
means the variable isn't exported.

**`hn-monitor: 1 required input(s) unresolved`**
An input the persona requires has no value anywhere. The message names the input
and the environment variable to set; see [section 5](#5-give-the-agent-its-inputs).
Nothing was deployed.

**`integrations.slack: not connected, and --no-prompt was passed. Connect it
before deploying or run without --no-prompt.`**
This is the one that catches people out. The agent needs an integration your
workspace hasn't connected, and CI cannot complete an OAuth consent screen.

Connect it once from your own machine by deploying that agent **interactively**
— without the headless flags, so the CLI can walk you through the browser flow:

```sh
npx agentworkforce persona compile ./hn-monitor/persona.ts
npx agentworkforce deploy ./hn-monitor/persona.json --mode cloud
```

Then check what your workspace has, and re-dispatch the workflow:

```sh
npx agentworkforce integrations --all
```

**`persona requires a subscription provider connection, but --no-prompt was
passed.`**
Same shape of problem, for the LLM credential rather than an integration: that
persona sets `useSubscription: true` and your workspace has no provider
connected. Fix it the same way — one interactive deploy, then re-dispatch.

**`skipping slack channels picker for input SLACK_CHANNEL because --no-prompt is
set`**
A warning, not an error. Interactively the CLI would have shown you a channel
picker; headlessly you supply the value yourself. If the deploy then fails on an
unresolved input, that's the one to set.

---

## 8. Adding your own agent

1. Create `<your-agent>/persona.ts` and `<your-agent>/agent.ts`, following any
   existing folder.
2. Add it to [`scripts/deploy/agents.json`](../scripts/deploy/agents.json):

   ```json
   { "name": "your-agent", "persona": "your-agent/persona.ts" }
   ```

3. `npm test` — a test fails if an agent on disk is missing from that registry,
   so you'll be told if you skip step 2.

Declare inputs in your `persona.ts`, not in the registry. The deploy script
reads them from the compiled persona, so a new input needs no change here — and
no channel id, org id, or token ever has to be committed to a public repo.
