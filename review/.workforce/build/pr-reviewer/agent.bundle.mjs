// review/agent.ts
import {
  defineAgent,
  encodeSegment as encodeSegment2,
  readJsonFile as readJsonFile2,
  resolveMountRoot as resolveMountRoot2
} from "@agentworkforce/runtime";

// node_modules/@relayfile/adapter-core/dist/src/vfs-client/index.js
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
var RelayfileWritebackError = class extends Error {
  provider;
  operation;
  cause;
  retryable;
  constructor(options) {
    super(`${options.provider}.${options.operation} failed${options.cause instanceof Error ? `: ${options.cause.message}` : ""}`);
    this.name = "RelayfileWritebackError";
    this.provider = options.provider;
    this.operation = options.operation;
    if (options.cause !== void 0)
      this.cause = options.cause;
    this.retryable = options.retryable ?? false;
  }
};
var DEFAULT_WRITEBACK_TIMEOUT_MS = 3e3;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function draftFile(prefix) {
  return `${prefix} ${randomUUID()}.json`;
}
function resolveMountRoot(client) {
  return path.resolve(client.relayfileMountRoot ?? client.relayfileRoot ?? client.mountRoot ?? process.env.RELAYFILE_MOUNT_ROOT ?? process.env.RELAYFILE_ROOT ?? client.workspaceCwd ?? process.cwd());
}
function toAbsolutePath(client, relayPath) {
  const root = resolveMountRoot(client);
  const normalized = relayPath.startsWith("/") ? relayPath.slice(1) : relayPath;
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Relayfile path escapes mount root: ${relayPath}`);
  }
  return absolute;
}
async function readJsonFile(client, provider, operation, relayPath) {
  try {
    const absolutePath = toAbsolutePath(client, relayPath);
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (cause) {
    throw new RelayfileWritebackError({ provider, operation, cause, retryable: false });
  }
}
async function listJsonFiles(client, provider, operation, relayDir) {
  try {
    const absoluteDir = toAbsolutePath(client, relayDir);
    const entries = await readdirIfPresent(absoluteDir);
    const out = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json"))
        continue;
      const relayPath = `${relayDir.replace(/\/+$/, "")}/${entry}`;
      const value = JSON.parse(await readFile(path.join(absoluteDir, entry), "utf8"));
      out.push({ path: relayPath, value });
    }
    return out;
  } catch (cause) {
    throw new RelayfileWritebackError({ provider, operation, cause, retryable: false });
  }
}
async function readdirIfPresent(absoluteDir) {
  try {
    return await readdir(absoluteDir);
  } catch (error) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
}
function isNoEntryError(error) {
  return isRecord(error) && error.code === "ENOENT";
}
async function writeJsonFile(client, provider, operation, relayPath, body) {
  try {
    const absolutePath = toAbsolutePath(client, relayPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const tempPath = `${absolutePath}.tmp-${randomUUID()}`;
    await writeFile(tempPath, `${JSON.stringify(body, null, 2)}
`, "utf8");
    await rename(tempPath, absolutePath);
    const receipt = await waitForReceipt(absolutePath, client, body);
    return { path: relayPath, absolutePath, ...receipt ? { receipt } : {} };
  } catch (cause) {
    throw new RelayfileWritebackError({ provider, operation, cause, retryable: false });
  }
}
async function waitForReceipt(absolutePath, client, draft) {
  const timeoutMs = client.writebackTimeoutMs ?? DEFAULT_WRITEBACK_TIMEOUT_MS;
  if (timeoutMs <= 0)
    return void 0;
  const draftJson = JSON.stringify(draft);
  const deadline = Date.now() + timeoutMs;
  do {
    const parsed = await readCurrentJson(absolutePath);
    if (parsed !== void 0 && JSON.stringify(parsed) !== draftJson && isRecord(parsed) && (typeof parsed.created === "string" || typeof parsed.path === "string" || typeof parsed.id === "string" || typeof parsed.externalId === "string" || typeof parsed.merged === "boolean" || typeof parsed.merged === "string")) {
      return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, client.writebackPollMs ?? 250));
  } while (Date.now() < deadline);
  return void 0;
}
async function readCurrentJson(absolutePath) {
  try {
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch {
    return void 0;
  }
}

// node_modules/@relayfile/adapter-core/dist/src/writeback-paths/catalog.generated.js
var WRITEBACK_PATH_CATALOG = {
  "asana": {
    "projects": [
      {
        "path": "/asana/projects",
        "params": []
      }
    ],
    "sections": [
      {
        "path": "/asana/projects/{projectId}/sections",
        "params": [
          "projectId"
        ]
      },
      {
        "path": "/asana/sections",
        "params": []
      }
    ],
    "tasks": [
      {
        "path": "/asana/tasks",
        "params": []
      }
    ]
  },
  "azure-blob": {
    "blobs": [
      {
        "path": "/azure-blob/blobs",
        "params": []
      }
    ],
    "event-subscriptions": [
      {
        "path": "/azure-blob/event-subscriptions",
        "params": []
      }
    ]
  },
  "box": {
    "files": [
      {
        "path": "/box/files",
        "params": []
      }
    ],
    "webhooks": [
      {
        "path": "/box/webhooks",
        "params": []
      }
    ]
  },
  "clickup": {
    "comments": [
      {
        "path": "/clickup/tasks/{taskId}/comments",
        "params": [
          "taskId"
        ]
      }
    ],
    "folders": [
      {
        "path": "/clickup/spaces/{spaceId}/folders",
        "params": [
          "spaceId"
        ]
      }
    ],
    "lists": [
      {
        "path": "/clickup/folders/{folderId}/lists",
        "params": [
          "folderId"
        ]
      },
      {
        "path": "/clickup/spaces/{spaceId}/lists",
        "params": [
          "spaceId"
        ]
      }
    ],
    "tasks": [
      {
        "path": "/clickup/lists/{listId}/tasks",
        "params": [
          "listId"
        ]
      }
    ]
  },
  "confluence": {
    "pages": [
      {
        "path": "/confluence/pages",
        "params": []
      },
      {
        "path": "/confluence/spaces/{spaceIdOrKey}/pages",
        "params": [
          "spaceIdOrKey"
        ]
      }
    ]
  },
  "dropbox": {
    "files": [
      {
        "path": "/dropbox/files",
        "params": []
      }
    ],
    "folders": [
      {
        "path": "/dropbox/folders",
        "params": []
      }
    ],
    "shared-folders": [
      {
        "path": "/dropbox/shared-folders",
        "params": []
      }
    ],
    "shared-links": [
      {
        "path": "/dropbox/shared-links",
        "params": []
      }
    ]
  },
  "gcs": {
    "notifications": [
      {
        "path": "/gcs/notifications",
        "params": []
      }
    ],
    "objects": [
      {
        "path": "/gcs/objects",
        "params": []
      }
    ]
  },
  "github": {
    "issue-comments": [
      {
        "path": "/github/repos/{owner}/{repo}/issues/{issueNumber}/comments",
        "params": [
          "owner",
          "repo",
          "issueNumber"
        ]
      }
    ],
    "issues": [
      {
        "path": "/github/repos/{owner}/{repo}/issues",
        "params": [
          "owner",
          "repo"
        ]
      }
    ],
    "merge": [
      {
        "path": "/github/repos/{owner}/{repo}/pulls/{pullNumber}/merge.json",
        "params": [
          "owner",
          "repo",
          "pullNumber"
        ]
      }
    ],
    "reviews": [
      {
        "path": "/github/repos/{owner}/{repo}/pulls/{pullNumber}/reviews",
        "params": [
          "owner",
          "repo",
          "pullNumber"
        ]
      }
    ]
  },
  "gitlab": {
    "comments": [
      {
        "path": "/gitlab/projects/{projectPath}/issues/{issueIid}__{slug}/comments",
        "params": [
          "projectPath",
          "issueIid",
          "slug"
        ]
      }
    ],
    "discussions": [
      {
        "path": "/gitlab/projects/{projectPath}/merge_requests/{mergeRequestIid}__{slug}/discussions",
        "params": [
          "projectPath",
          "mergeRequestIid",
          "slug"
        ]
      }
    ]
  },
  "gmail": {
    "drafts": [
      {
        "path": "/gmail/drafts",
        "params": []
      }
    ],
    "threads": [
      {
        "path": "/gmail/threads",
        "params": []
      }
    ],
    "watches": [
      {
        "path": "/gmail/watches",
        "params": []
      }
    ]
  },
  "google-calendar": {
    "events": [
      {
        "path": "/google-calendar/calendars/{calendarId}/events",
        "params": [
          "calendarId"
        ]
      }
    ]
  },
  "google-drive": {
    "channels": [
      {
        "path": "/google-drive/channels",
        "params": []
      }
    ],
    "files": [
      {
        "path": "/google-drive/files",
        "params": []
      }
    ]
  },
  "granola": {
    "folders": [
      {
        "path": "/granola/folders",
        "params": []
      }
    ],
    "notes": [
      {
        "path": "/granola/notes",
        "params": []
      }
    ]
  },
  "hubspot": {
    "companies": [
      {
        "path": "/hubspot/companies",
        "params": []
      }
    ],
    "contacts": [
      {
        "path": "/hubspot/contacts",
        "params": []
      }
    ],
    "deals": [
      {
        "path": "/hubspot/deals",
        "params": []
      }
    ],
    "tickets": [
      {
        "path": "/hubspot/tickets",
        "params": []
      }
    ]
  },
  "intercom": {
    "companies": [
      {
        "path": "/intercom/companies",
        "params": []
      }
    ],
    "contacts": [
      {
        "path": "/intercom/contacts",
        "params": []
      }
    ],
    "conversations": [
      {
        "path": "/intercom/conversations",
        "params": []
      }
    ]
  },
  "jira": {
    "comments": [
      {
        "path": "/jira/issues/{issueIdOrKey}/comments",
        "params": [
          "issueIdOrKey"
        ]
      }
    ],
    "issues": [
      {
        "path": "/jira/issues",
        "params": []
      }
    ],
    "projects": [
      {
        "path": "/jira/projects",
        "params": []
      }
    ],
    "transitions": [
      {
        "path": "/jira/issues/{issueIdOrKey}/transitions",
        "params": [
          "issueIdOrKey"
        ]
      }
    ]
  },
  "linear": {
    "comments": [
      {
        "path": "/linear/issues/{issueId}/comments",
        "params": [
          "issueId"
        ]
      }
    ],
    "issues": [
      {
        "path": "/linear/issues",
        "params": []
      }
    ]
  },
  "notion": {
    "comments": [
      {
        "path": "/notion/databases/{databaseId}/pages/{pageId}/comments.json",
        "params": [
          "databaseId",
          "pageId"
        ]
      },
      {
        "path": "/notion/pages/{pageId}/comments.json",
        "params": [
          "pageId"
        ]
      }
    ],
    "content": [
      {
        "path": "/notion/databases/{databaseId}/pages/{pageId}/content.md",
        "params": [
          "databaseId",
          "pageId"
        ]
      },
      {
        "path": "/notion/pages/{pageId}/content.md",
        "params": [
          "pageId"
        ]
      }
    ],
    "pages": [
      {
        "path": "/notion/databases/{databaseId}/pages",
        "params": [
          "databaseId"
        ]
      },
      {
        "path": "/notion/databases/{databaseId}/pages/{pageId}.json",
        "params": [
          "databaseId",
          "pageId"
        ]
      },
      {
        "path": "/notion/pages/{pageId}.json",
        "params": [
          "pageId"
        ]
      }
    ],
    "properties": [
      {
        "path": "/notion/databases/{databaseId}/pages/{pageId}/properties.json",
        "params": [
          "databaseId",
          "pageId"
        ]
      },
      {
        "path": "/notion/pages/{pageId}/properties.json",
        "params": [
          "pageId"
        ]
      }
    ]
  },
  "onedrive": {
    "items": [
      {
        "path": "/onedrive/items",
        "params": []
      }
    ],
    "subscriptions": [
      {
        "path": "/onedrive/subscriptions",
        "params": []
      }
    ]
  },
  "pipedrive": {
    "activities": [
      {
        "path": "/pipedrive/activities",
        "params": []
      }
    ],
    "deals": [
      {
        "path": "/pipedrive/deals",
        "params": []
      }
    ],
    "organizations": [
      {
        "path": "/pipedrive/organizations",
        "params": []
      }
    ],
    "persons": [
      {
        "path": "/pipedrive/persons",
        "params": []
      }
    ]
  },
  "postgres": {
    "listeners": [
      {
        "path": "/postgres/listeners",
        "params": []
      }
    ],
    "rows": [
      {
        "path": "/postgres/rows",
        "params": []
      }
    ]
  },
  "reddit": {
    "posts": [
      {
        "path": "/reddit/subreddits/{subreddit}/posts",
        "params": [
          "subreddit"
        ]
      }
    ],
    "subreddits": [
      {
        "path": "/reddit/subreddits",
        "params": []
      }
    ]
  },
  "redis": {
    "keys": [
      {
        "path": "/redis/keys",
        "params": []
      }
    ],
    "listeners": [
      {
        "path": "/redis/listeners",
        "params": []
      }
    ]
  },
  "s3": {
    "objects": [
      {
        "path": "/s3/objects",
        "params": []
      }
    ],
    "queues": [
      {
        "path": "/s3/queues",
        "params": []
      }
    ]
  },
  "salesforce": {
    "accounts": [
      {
        "path": "/salesforce/accounts",
        "params": []
      }
    ],
    "cases": [
      {
        "path": "/salesforce/cases",
        "params": []
      }
    ],
    "contacts": [
      {
        "path": "/salesforce/contacts",
        "params": []
      }
    ],
    "leads": [
      {
        "path": "/salesforce/leads",
        "params": []
      }
    ],
    "opportunities": [
      {
        "path": "/salesforce/opportunities",
        "params": []
      }
    ]
  },
  "sharepoint": {
    "items": [
      {
        "path": "/sharepoint/items",
        "params": []
      }
    ],
    "subscriptions": [
      {
        "path": "/sharepoint/subscriptions",
        "params": []
      }
    ]
  },
  "slack": {
    "direct-messages": [
      {
        "path": "/slack/users/{userId}/messages",
        "params": [
          "userId"
        ]
      }
    ],
    "messages": [
      {
        "path": "/slack/channels/{channelId}/messages",
        "params": [
          "channelId"
        ]
      }
    ],
    "reactions": [
      {
        "path": "/slack/channels/{channelId}/messages/{messageTs}/reactions",
        "params": [
          "channelId",
          "messageTs"
        ]
      }
    ],
    "replies": [
      {
        "path": "/slack/channels/{channelId}/messages/{messageTs}/replies",
        "params": [
          "channelId",
          "messageTs"
        ]
      }
    ]
  },
  "teams": {
    "messages": [
      {
        "path": "/teams/{teamId}/channels/{channelId}/messages",
        "params": [
          "teamId",
          "channelId"
        ]
      },
      {
        "path": "/teams/chats/{chatId}/messages",
        "params": [
          "chatId"
        ]
      }
    ],
    "replies": [
      {
        "path": "/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies",
        "params": [
          "teamId",
          "channelId",
          "messageId"
        ]
      }
    ]
  },
  "zendesk": {
    "comments": [
      {
        "path": "/zendesk/tickets/{ticketId}/comments",
        "params": [
          "ticketId"
        ]
      }
    ],
    "tickets": [
      {
        "path": "/zendesk/tickets",
        "params": []
      }
    ],
    "users": [
      {
        "path": "/zendesk/users",
        "params": []
      }
    ]
  }
};

// node_modules/@relayfile/adapter-core/dist/src/writeback-paths/resolver.js
var WritebackPathError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "WritebackPathError";
  }
};
function writebackPath(provider, resource, params = {}) {
  const catalog = WRITEBACK_PATH_CATALOG;
  if (!Object.hasOwn(catalog, provider)) {
    throw new WritebackPathError(`Unknown writeback provider "${provider}". Known providers: ${Object.keys(catalog).join(", ")}`);
  }
  const providerEntry = catalog[provider];
  if (!Object.hasOwn(providerEntry, resource)) {
    throw new WritebackPathError(`Unknown writeback resource "${resource}" for provider "${provider}". Known resources: ${Object.keys(providerEntry).join(", ")}`);
  }
  const variant = selectVariant(provider, resource, providerEntry[resource], params);
  return variant.path.replace(/\{([^}]+)\}/gu, (_match, name) => {
    const value = Object.hasOwn(params, name) ? params[name] : void 0;
    if (value === void 0 || value === null || value === "") {
      throw new WritebackPathError(`Missing path parameter "${name}" for ${provider}/${resource} (template "${variant.path}")`);
    }
    return encodeURIComponent(String(value));
  });
}
function selectVariant(provider, resource, variants, params) {
  if (variants.length === 1) {
    return variants[0];
  }
  const providedKeys = new Set(Object.keys(params));
  const matches = variants.filter((variant) => variant.params.length === providedKeys.size && variant.params.every((name) => providedKeys.has(name)));
  if (matches.length === 1) {
    return matches[0];
  }
  const templates = variants.map((variant) => `"${variant.path}" (params: ${variant.params.join(", ") || "none"})`).join("; ");
  throw new WritebackPathError(`Ambiguous writeback resource "${resource}" for provider "${provider}": params {${[...providedKeys].join(", ") || "none"}} ${matches.length === 0 ? "match no" : "match multiple"} of its ${variants.length} templates. Candidates: ${templates}`);
}

// node_modules/@relayfile/relay-helpers/dist/generic.js
function isItemPath(path2) {
  return path2.endsWith(".json");
}
function relayClient(provider, opts = {}) {
  const knownResources = () => Object.keys(WRITEBACK_PATH_CATALOG[provider] ?? {}).join(", ");
  return {
    provider,
    path(resource, params = {}) {
      return writebackPath(provider, resource, params);
    },
    async write(resource, params, body) {
      const base = writebackPath(provider, resource, params);
      const target = isItemPath(base) ? base : `${base}/${draftFile(String(resource))}`;
      return writeJsonFile(opts, provider, `write.${String(resource)}`, target, body);
    },
    async read(resource, params = {}) {
      const path2 = writebackPath(provider, resource, params);
      if (!isItemPath(path2)) {
        throw new Error(`read("${String(resource)}") resolves to collection "${path2}"; read a specific item path or use list(). Known resources for ${provider}: ${knownResources()}`);
      }
      return readJsonFile(opts, provider, `read.${String(resource)}`, path2);
    },
    async list(resource, params = {}) {
      const path2 = writebackPath(provider, resource, params);
      if (isItemPath(path2)) {
        throw new Error(`list("${String(resource)}") resolves to item "${path2}"; use read() instead. Known resources for ${provider}: ${knownResources()}`);
      }
      const files = await listJsonFiles(opts, provider, `list.${String(resource)}`, path2);
      return files.map((file) => file.value);
    }
  };
}

// node_modules/@relayfile/relay-helpers/dist/provider-client.js
function providerClient(provider, opts = {}) {
  const relay = relayClient(provider, opts);
  const out = {};
  const resources = WRITEBACK_PATH_CATALOG[provider];
  if (!resources) {
    throw new Error(`Unknown writeback provider "${provider}". Known providers: ${Object.keys(WRITEBACK_PATH_CATALOG).join(", ")}`);
  }
  for (const resource of Object.keys(resources)) {
    const r = resource;
    out[resource] = {
      path: (params) => relay.path(r, params),
      write: (params, body) => relay.write(r, params, body),
      read: (params) => relay.read(r, params),
      list: (params) => relay.list(r, params)
    };
  }
  return out;
}

// node_modules/@relayfile/relay-helpers/dist/receipt.js
function created(result) {
  return {
    id: result.receipt?.created ?? result.receipt?.id ?? result.path,
    url: result.receipt?.url ?? result.path
  };
}

// node_modules/@relayfile/relay-helpers/dist/github.js
function githubClient(opts = {}) {
  const base = providerClient("github", opts);
  return Object.assign(base, {
    async comment(target, body) {
      return created(await base["issue-comments"].write({ owner: target.owner, repo: target.repo, issueNumber: target.number }, { body }));
    },
    async createIssue(args) {
      return created(await base.issues.write({ owner: args.owner, repo: args.repo }, { title: args.title, body: args.body, ...args.labels ? { labels: args.labels } : {} }));
    },
    async mergePullRequest(args) {
      const result = await base.merge.write({ owner: args.owner, repo: args.repo, pullNumber: args.number }, {
        ...args.method !== void 0 ? { merge_method: args.method } : {},
        ...args.commitTitle !== void 0 ? { commit_title: args.commitTitle } : {},
        ...args.commitMessage !== void 0 ? { commit_message: args.commitMessage } : {},
        ...args.sha !== void 0 ? { sha: args.sha } : {}
      });
      const sha = typeof result.receipt?.sha === "string" ? result.receipt.sha : typeof result.receipt?.id === "string" ? result.receipt.id : void 0;
      const merged = result.receipt?.merged;
      return {
        merged: merged === true || merged === "true" || merged === void 0 && Boolean(sha),
        ...sha ? { sha } : {}
      };
    },
    async review(target, args) {
      await base.reviews.write({ owner: target.owner, repo: target.repo, pullNumber: target.number }, { ...args, comments: args.comments ?? [] });
    }
  });
}

// node_modules/@relayfile/relay-helpers/dist/slack.js
function tsParam(ts) {
  return ts.replace(/\./g, "_");
}
function slackClient(opts = {}) {
  const base = providerClient("slack", opts);
  return Object.assign(base, {
    async post(channel, text) {
      const result = await base.messages.write({ channelId: channel }, { text });
      return { channel, ts: result.receipt?.created ?? result.receipt?.id ?? "" };
    },
    async dm(user, text) {
      const result = await base["direct-messages"].write({ userId: user }, { text });
      return { user, ts: result.receipt?.created ?? result.receipt?.id ?? "" };
    },
    async reply(channel, threadTs, text) {
      const result = await base.replies.write({ channelId: channel, messageTs: tsParam(threadTs) }, { text });
      return { channel, ts: result.receipt?.created ?? result.receipt?.id ?? "" };
    },
    async react(channel, messageTs, emoji) {
      await base.reactions.write({ channelId: channel, messageTs: tsParam(messageTs) }, { emoji });
    }
  });
}

// review/agent.ts
var DEFAULT_SKIP_LABEL = "no-agent-relay-review";
function vfsClient() {
  return { relayfileMountRoot: resolveMountRoot2({}) };
}
var agent_default = defineAgent({
  // Re-review on every PR change (open, new commits, review comments, finished
  // CI), and merge when you approve. Every `on` value autocompletes from
  // github's catalog (see relayfile-adapters DEFAULT_SUPPORTED_EVENTS).
  triggers: {
    github: [
      { on: "pull_request.opened" },
      { on: "pull_request_review.submitted" },
      { on: "pull_request_review_comment.created" },
      { on: "check_run.completed" },
      { on: "pull_request.synchronize" }
    ]
  },
  handler: async (ctx, event) => {
    if (event.source !== "github") return;
    if (event.type === "pull_request_review.submitted" && isApproval(event.payload) && isAuthorizedApprover(ctx, event.payload)) {
      const pr2 = readPr(event.payload);
      if (pr2) await mergePr(ctx, pr2);
      return;
    }
    if (event.type === "check_run.completed" && !ciFailed(event.payload)) return;
    const pr = readPr(event.payload);
    if (pr) {
      const skip = await shouldSkipReview(ctx, pr);
      if (skip) {
        ctx.log?.("info", "pr-reviewer skipped", { owner: pr.owner, repo: pr.repo, number: pr.number, reason: skip.reason });
        if (skip.notify) await notifySkip(ctx, pr, skip.reason);
        return;
      }
      await reviewAndFix(ctx, pr);
    } else if (event.type === "check_run.completed") {
      ctx.log?.("info", "check_run.completed with no associated PR; skipping", { eventId: event.id });
    }
  }
});
async function shouldSkipReview(ctx, pr) {
  const meta = await loadPrMeta(pr);
  const state = (meta?.state ?? pr.state ?? "").trim().toLowerCase();
  if (meta?.merged === true || pr.merged === true || state === "closed") {
    return { reason: "PR is already merged/closed", notify: true };
  }
  const skipLabels = skipLabelSet(ctx);
  const prLabels = labelNames(Array.isArray(meta?.labels) ? meta.labels : pr.labels);
  const hit = prLabels.find((name) => skipLabels.has(name));
  if (hit) {
    return { reason: `PR carries the "${hit}" label` };
  }
  const allow = reviewAuthorAllowlist(ctx);
  const author = resolveAuthorLogin(meta, pr);
  const allowlistSkip = reviewAuthorAllowlistDecision(allow, author);
  if (allowlistSkip) {
    return allowlistSkip;
  }
  return null;
}
function resolveAuthorLogin(meta, pr) {
  const fromMeta = typeof meta?.author === "string" ? meta.author : meta?.author?.login;
  return (fromMeta ?? pr.author ?? "").trim().toLowerCase();
}
async function loadPrMeta(pr) {
  try {
    return await readJsonFile2(
      vfsClient(),
      "github",
      "getPr",
      `/github/repos/${encodeSegment2(pr.owner)}/${encodeSegment2(pr.repo)}/pulls/${pr.number}/meta.json`
    );
  } catch {
    return void 0;
  }
}
function skipLabelSet(ctx) {
  const raw = input(ctx, "SKIP_LABELS") ?? DEFAULT_SKIP_LABEL;
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}
function reviewAuthorAllowlist(ctx) {
  const raw = input(ctx, "REVIEW_AUTHORS") ?? "";
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}
function reviewAuthorAllowlistDecision(allow, author) {
  if (allow.size === 0) {
    return null;
  }
  if (!author || author === "unknown") {
    return { reason: "REVIEW_AUTHORS is set but the PR author could not be resolved" };
  }
  if (!allow.has(author)) {
    return { reason: `author @${author} is not in REVIEW_AUTHORS` };
  }
  return null;
}
function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.map((l) => l && typeof l.name === "string" ? l.name.trim().toLowerCase() : "").filter(Boolean);
}
async function notifySkip(ctx, pr, reason) {
  const channel = input(ctx, "SLACK_CHANNEL");
  if (!channel) return;
  await slackClient().post(
    channel,
    `:information_source: pr-reviewer skipped PR #${pr.number} in *${pr.owner}/${pr.repo}* \u2014 ${reason}: ${pr.url}`
  );
}
async function reviewAndFix(ctx, pr) {
  const run = await ctx.harness.run({
    cwd: ctx.sandbox.cwd,
    prompt: [
      `Review pull request #${pr.number} in ${pr.owner}/${pr.repo}. The PR code is checked out in the current directory.`,
      `Focus on the actual PR changes: read .workforce/pr.diff first, then .workforce/changed-files.txt and .workforce/context.json.`,
      `Use the checked-out repo to trace the impact of this diff across callers, types, tests, config, and related files.`,
      `Flag and fix breakage even when the affected file is outside the changed-file set, but do not do an unrelated full-repo audit.`,
      `Then proactively FIX everything that needs changing \u2014 your own findings and any other bot reviews on the PR \u2014`,
      `and resolve failing CI checks and merge conflicts by editing the code. Don't use git or the gh CLI; cloud commits`,
      `and pushes your file edits to the PR after this run. In your output, do not claim that fixes were pushed,`,
      `a GitHub review was submitted, or CI was verified; those are post-harness actions that cloud reports separately.`,
      `When the PR is genuinely ready for a human after your local review and edits, end your output with READY on its own last line.`
    ].join("\n")
  });
  const exitCode = run.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) {
    await failReviewRun(ctx, pr, `The review harness exited with code ${exitCode}.`);
  }
  const raw = (run.output ?? "").trimEnd();
  const ready = lastLine(raw) === "READY";
  const body = ready ? stripLastLine(raw).trimEnd() : raw;
  if (!body) {
    await failReviewRun(ctx, pr, "The review harness produced no review output.");
  }
  if (body) {
    await githubClient().comment({ owner: pr.owner, repo: pr.repo, number: pr.number }, body);
  }
  const channel = input(ctx, "SLACK_CHANNEL");
  if (channel) {
    const who = `<https://github.com/${pr.author}|@${pr.author}>`;
    await slackClient().post(
      channel,
      ready ? `:white_check_mark: ${who} \u2014 PR #${pr.number} in *${pr.owner}/${pr.repo}* is ready for your review: ${pr.url}` : `:eyes: ${who} \u2014 reviewing PR #${pr.number} in *${pr.owner}/${pr.repo}*, still working on it: ${pr.url}`
    );
  }
}
async function failReviewRun(ctx, pr, reason) {
  const message = [
    `pr-reviewer could not complete review for #${pr.number} in ${pr.owner}/${pr.repo}.`,
    reason,
    "No review was posted; this needs operator attention."
  ].join("\n");
  ctx.log?.("error", "pr-reviewer harness failed", {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    reason
  });
  await githubClient().comment({ owner: pr.owner, repo: pr.repo, number: pr.number }, message);
  const channel = input(ctx, "SLACK_CHANNEL");
  if (channel) {
    await slackClient().post(
      channel,
      `:warning: pr-reviewer failed for PR #${pr.number} in *${pr.owner}/${pr.repo}*: ${reason}`
    );
  }
  throw new Error(message);
}
async function mergePr(ctx, pr) {
  const result = await githubClient().mergePullRequest({
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    method: "squash",
    ...pr.headSha ? { sha: pr.headSha } : {}
  });
  if (!result.merged) {
    throw new Error(`GitHub did not confirm PR #${pr.number} in ${pr.owner}/${pr.repo} was merged.`);
  }
  const channel = input(ctx, "SLACK_CHANNEL");
  if (channel) {
    await slackClient().post(channel, `:tada: Merged PR #${pr.number} in ${pr.owner}/${pr.repo}.`);
  }
}
function readPr(payload) {
  const p = payload;
  const prRef = p?.pull_request ?? p?.check_run?.pull_requests?.[0];
  const number = prRef?.number ?? p?.number;
  const owner = p?.repository?.owner?.login;
  const repo = p?.repository?.name;
  if (typeof number !== "number" || !Number.isInteger(number) || !owner || !repo) return void 0;
  const headSha = p?.pull_request?.head?.sha ?? p?.check_run?.pull_requests?.[0]?.head_sha;
  return {
    owner,
    repo,
    number,
    url: prRef?.html_url ?? `https://github.com/${owner}/${repo}/pull/${number}`,
    author: p?.pull_request?.user?.login ?? p?.sender?.login ?? "unknown",
    ...headSha ? { headSha } : {},
    ...p?.pull_request?.state ? { state: p.pull_request.state } : {},
    ...typeof p?.pull_request?.merged === "boolean" ? { merged: p.pull_request.merged } : {},
    ...p?.pull_request?.labels !== void 0 ? { labels: p.pull_request.labels } : {}
  };
}
function isApproval(payload) {
  return payload?.review?.state?.toLowerCase() === "approved";
}
function isAuthorizedApprover(ctx, payload) {
  const allow = (input(ctx, "APPROVERS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length === 0) return true;
  const approver = payload?.review?.user?.login?.toLowerCase();
  return approver !== void 0 && allow.includes(approver);
}
function ciFailed(payload) {
  const conclusion = payload?.check_run?.conclusion?.toLowerCase();
  return conclusion !== void 0 && conclusion !== "success" && conclusion !== "neutral" && conclusion !== "skipped";
}
function lastLine(text) {
  return text.trimEnd().split("\n").pop()?.trim() ?? "";
}
function stripLastLine(text) {
  const i = text.lastIndexOf("\n");
  return i < 0 ? "" : text.slice(0, i);
}
function input(ctx, name) {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : void 0;
}
export {
  agent_default as default,
  reviewAuthorAllowlistDecision
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vYWdlbnQudHMiLCAiLi4vLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0ByZWxheWZpbGUvYWRhcHRlci1jb3JlL3NyYy92ZnMtY2xpZW50L2luZGV4LnRzIiwgIi4uLy4uLy4uLy4uL25vZGVfbW9kdWxlcy9AcmVsYXlmaWxlL2FkYXB0ZXItY29yZS9zcmMvd3JpdGViYWNrLXBhdGhzL2NhdGFsb2cuZ2VuZXJhdGVkLnRzIiwgIi4uLy4uLy4uLy4uL25vZGVfbW9kdWxlcy9AcmVsYXlmaWxlL2FkYXB0ZXItY29yZS9zcmMvd3JpdGViYWNrLXBhdGhzL3Jlc29sdmVyLnRzIiwgIi4uLy4uLy4uLy4uL25vZGVfbW9kdWxlcy9AcmVsYXlmaWxlL3JlbGF5LWhlbHBlcnMvc3JjL2dlbmVyaWMudHMiLCAiLi4vLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0ByZWxheWZpbGUvcmVsYXktaGVscGVycy9zcmMvcHJvdmlkZXItY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL25vZGVfbW9kdWxlcy9AcmVsYXlmaWxlL3JlbGF5LWhlbHBlcnMvc3JjL3JlY2VpcHQudHMiLCAiLi4vLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0ByZWxheWZpbGUvcmVsYXktaGVscGVycy9zcmMvZ2l0aHViLnRzIiwgIi4uLy4uLy4uLy4uL25vZGVfbW9kdWxlcy9AcmVsYXlmaWxlL3JlbGF5LWhlbHBlcnMvc3JjL3NsYWNrLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIHByLXJldmlld2VyIGhhbmRsZXIgXHUyMDE0IHJldmlldywgYXV0by1maXgsIGFuZCBzaGVwaGVyZCBhIFBSIHRvIHRoZSBmaW5pc2ggbGluZS5cbiAqXG4gKiAgIGFuIGF1dGhvcml6ZWQgYXBwcm92YWwgKHB1bGxfcmVxdWVzdF9yZXZpZXcuc3VibWl0dGVkKSBcdTIxOTIgbWVyZ2UgdGhlIFBSLlxuICogICBhIGNoZWNrIHJ1biB0aGF0IGZpbmlzaGVkIGdyZWVuIChjaGVja19ydW4uY29tcGxldGVkKSAgIFx1MjE5MiBub3RoaW5nIHRvIGRvLlxuICogICBhbnl0aGluZyBlbHNlIFx1MjAxNCBvcGVuZWQsIG5ldyBjb21taXRzIChzeW5jaHJvbml6ZSksIGFcbiAqICAgcmV2aWV3IGNvbW1lbnQsIGZhaWxlZCBDSSwgY2hhbmdlcyByZXF1ZXN0ZWQgICAgICAgICAgICBcdTIxOTIgKHJlKXJldmlldyBhbmQgZml4LlxuICpcbiAqIFRoZSBQUidzIHJlcG8gaXMgbWF0ZXJpYWxpemVkIGludG8gY3R4LnNhbmRib3guY3dkIGJ5IGNsb3VkIGJlZm9yZSB0aGVcbiAqIGhhcm5lc3MgcnVucy4gVGhlIGFnZW50IGZpeGVzIGJ5IGVkaXRpbmcgZmlsZXMgdGhlcmU7IGNsb3VkIGNvbW1pdHMgYW5kXG4gKiBwdXNoZXMgdGhvc2UgZWRpdHMgYWZ0ZXIgdGhlIGhhcm5lc3MgZXhpdHMgXHUyMDE0IG5vIGdpdC9naCBpbiB0aGUgaGFybmVzcy5cbiAqL1xuaW1wb3J0IHtcbiAgZGVmaW5lQWdlbnQsXG4gIGVuY29kZVNlZ21lbnQsXG4gIHJlYWRKc29uRmlsZSxcbiAgcmVzb2x2ZU1vdW50Um9vdCxcbiAgdHlwZSBJbnRlZ3JhdGlvbkNsaWVudE9wdGlvbnMsXG4gIHR5cGUgV29ya2ZvcmNlQ3R4XG59IGZyb20gJ0BhZ2VudHdvcmtmb3JjZS9ydW50aW1lJztcbmltcG9ydCB7IGdpdGh1YkNsaWVudCwgc2xhY2tDbGllbnQgfSBmcm9tICdAcmVsYXlmaWxlL3JlbGF5LWhlbHBlcnMnO1xuXG5pbnRlcmZhY2UgUHIge1xuICBvd25lcjogc3RyaW5nO1xuICByZXBvOiBzdHJpbmc7XG4gIG51bWJlcjogbnVtYmVyO1xuICB1cmw6IHN0cmluZztcbiAgYXV0aG9yOiBzdHJpbmc7IC8vIGdpdGh1YiBsb2dpbiBvZiB3aG9ldmVyIG9wZW5lZCB0aGUgUFJcbiAgaGVhZFNoYT86IHN0cmluZztcbiAgc3RhdGU/OiBzdHJpbmc7XG4gIG1lcmdlZD86IGJvb2xlYW47XG4gIGxhYmVscz86IHVua25vd247XG59XG5cbi8qKiBUaGUgbWF0ZXJpYWxpemVkIFBSIHJlY29yZCBhdCBgXHUyMDI2L3B1bGxzL3tufS9tZXRhLmpzb25gLiBSZWFkIGZvciB0aGVcbiAqICBhdXRob3JpdGF0aXZlIGF1dGhvci9sYWJlbHMvc3RhdGUgXHUyMDE0IHRoZSB3ZWJob29rIHBheWxvYWQgZG9lc24ndCBjYXJyeSB0aGVtXG4gKiAgb24gZXZlcnkgdHJpZ2dlciAoY2hlY2tfcnVuLmNvbXBsZXRlZCBoYXMgbmVpdGhlcikuIFJlYWQgZGVmZW5zaXZlbHk6IHRoZVxuICogIHNoYXBlIGlzIHRoZSBnaXRodWIgYWRhcHRlcidzIHByb2plY3Rpb24gYW5kIGZpZWxkcyBtYXkgYmUgYWJzZW50LiAqL1xuaW50ZXJmYWNlIFByTWV0YSB7XG4gIHN0YXRlPzogc3RyaW5nOyAvLyAnb3BlbicgfCAnY2xvc2VkJ1xuICBtZXJnZWQ/OiBib29sZWFuO1xuICAvLyBUaGUgbWF0ZXJpYWxpemVkIG1ldGEuanNvbiBoYXMgY2FycmllZCBgYXV0aG9yYCBib3RoIGFzIGEgYmFyZSBsb2dpblxuICAvLyBzdHJpbmcgYW5kIGFzIGFuIG9iamVjdCBcdTIwMTQgYWNjZXB0IGVpdGhlciBzbyB0aGUgYWxsb3dsaXN0IGlzbid0IHNpbGVudGx5XG4gIC8vIGJ5cGFzc2VkIGJ5IGEgc2hhcGUgbWlzbWF0Y2guXG4gIGF1dGhvcj86IHN0cmluZyB8IHsgbG9naW4/OiBzdHJpbmcgfTtcbiAgbGFiZWxzPzogdW5rbm93bjsgLy8gdmFsaWRhdGVkIGFzIEFycmF5PHsgbmFtZT86IHN0cmluZyB9PiBhdCByZWFkIHRpbWVcbiAgW2tleTogc3RyaW5nXTogdW5rbm93bjtcbn1cblxuY29uc3QgREVGQVVMVF9TS0lQX0xBQkVMID0gJ25vLWFnZW50LXJlbGF5LXJldmlldyc7XG5cbmZ1bmN0aW9uIHZmc0NsaWVudCgpOiBJbnRlZ3JhdGlvbkNsaWVudE9wdGlvbnMge1xuICByZXR1cm4geyByZWxheWZpbGVNb3VudFJvb3Q6IHJlc29sdmVNb3VudFJvb3Qoe30pIH07XG59XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUFnZW50KHtcbiAgLy8gUmUtcmV2aWV3IG9uIGV2ZXJ5IFBSIGNoYW5nZSAob3BlbiwgbmV3IGNvbW1pdHMsIHJldmlldyBjb21tZW50cywgZmluaXNoZWRcbiAgLy8gQ0kpLCBhbmQgbWVyZ2Ugd2hlbiB5b3UgYXBwcm92ZS4gRXZlcnkgYG9uYCB2YWx1ZSBhdXRvY29tcGxldGVzIGZyb21cbiAgLy8gZ2l0aHViJ3MgY2F0YWxvZyAoc2VlIHJlbGF5ZmlsZS1hZGFwdGVycyBERUZBVUxUX1NVUFBPUlRFRF9FVkVOVFMpLlxuICB0cmlnZ2Vyczoge1xuICAgIGdpdGh1YjogW1xuICAgICAgeyBvbjogJ3B1bGxfcmVxdWVzdC5vcGVuZWQnIH0sXG4gICAgICB7IG9uOiAncHVsbF9yZXF1ZXN0X3Jldmlldy5zdWJtaXR0ZWQnIH0sXG4gICAgICB7IG9uOiAncHVsbF9yZXF1ZXN0X3Jldmlld19jb21tZW50LmNyZWF0ZWQnIH0sXG4gICAgICB7IG9uOiAnY2hlY2tfcnVuLmNvbXBsZXRlZCcgfSxcbiAgICAgIHsgb246ICdwdWxsX3JlcXVlc3Quc3luY2hyb25pemUnIH1cbiAgICBdXG4gIH0sXG4gIGhhbmRsZXI6IGFzeW5jIChjdHgsIGV2ZW50KSA9PiB7XG4gIGlmIChldmVudC5zb3VyY2UgIT09ICdnaXRodWInKSByZXR1cm47XG5cbiAgLy8gQW4gYXBwcm92YWwgZnJvbSBhbiBhdXRob3JpemVkIHJldmlld2VyIGVuZHMgdGhlIGxvb3A6IG1lcmdlIGFuZCBzdG9wLlxuICBpZiAoZXZlbnQudHlwZSA9PT0gJ3B1bGxfcmVxdWVzdF9yZXZpZXcuc3VibWl0dGVkJyAmJiBpc0FwcHJvdmFsKGV2ZW50LnBheWxvYWQpICYmIGlzQXV0aG9yaXplZEFwcHJvdmVyKGN0eCwgZXZlbnQucGF5bG9hZCkpIHtcbiAgICBjb25zdCBwciA9IHJlYWRQcihldmVudC5wYXlsb2FkKTtcbiAgICBpZiAocHIpIGF3YWl0IG1lcmdlUHIoY3R4LCBwcik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQSBjaGVjayBydW4gdGhhdCBmaW5pc2hlZCB3aXRob3V0IGZhaWxpbmcgbmVlZHMgbm8gYWN0aW9uLlxuICBpZiAoZXZlbnQudHlwZSA9PT0gJ2NoZWNrX3J1bi5jb21wbGV0ZWQnICYmICFjaUZhaWxlZChldmVudC5wYXlsb2FkKSkgcmV0dXJuO1xuXG4gIC8vIEV2ZXJ5dGhpbmcgZWxzZSBpcyBhIHJlYXNvbiB0byAocmUpcmV2aWV3IGFuZCBwdXNoIGZpeGVzLlxuICBjb25zdCBwciA9IHJlYWRQcihldmVudC5wYXlsb2FkKTtcbiAgaWYgKHByKSB7XG4gICAgY29uc3Qgc2tpcCA9IGF3YWl0IHNob3VsZFNraXBSZXZpZXcoY3R4LCBwcik7XG4gICAgaWYgKHNraXApIHtcbiAgICAgIGN0eC5sb2c/LignaW5mbycsICdwci1yZXZpZXdlciBza2lwcGVkJywgeyBvd25lcjogcHIub3duZXIsIHJlcG86IHByLnJlcG8sIG51bWJlcjogcHIubnVtYmVyLCByZWFzb246IHNraXAucmVhc29uIH0pO1xuICAgICAgaWYgKHNraXAubm90aWZ5KSBhd2FpdCBub3RpZnlTa2lwKGN0eCwgcHIsIHNraXAucmVhc29uKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYXdhaXQgcmV2aWV3QW5kRml4KGN0eCwgcHIpO1xuICB9IGVsc2UgaWYgKGV2ZW50LnR5cGUgPT09ICdjaGVja19ydW4uY29tcGxldGVkJykge1xuICAgIC8vIEdpdEh1YiBzb21ldGltZXMgZW1pdHMgY2hlY2tfcnVuLmNvbXBsZXRlZCB3aXRoIHB1bGxfcmVxdWVzdHM6IFtdIGZvclxuICAgIC8vIGZvcmsgUFJzIGFuZCBvcmctbGV2ZWwgY2hlY2tzOyBzdXJmYWNlIHNvIGEgXCJzaWxlbnQgbm8tb3BcIiBpc24ndFxuICAgIC8vIG1pc3Rha2VuIGZvciBcIlBSIHJldmlldyBza2lwcGVkIG9uIHB1cnBvc2VcIi5cbiAgICBjdHgubG9nPy4oJ2luZm8nLCAnY2hlY2tfcnVuLmNvbXBsZXRlZCB3aXRoIG5vIGFzc29jaWF0ZWQgUFI7IHNraXBwaW5nJywgeyBldmVudElkOiBldmVudC5pZCB9KTtcbiAgfVxuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIHJldmlldyBnYXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gRGVjaWRlIHdoZXRoZXIgdG8gKHJlKXJldmlldy9maXggdGhpcyBQUiBhdCBhbGwuIFJldHVybnMgYSBza2lwIHJlYXNvbiwgb3Jcbi8vIG51bGwgdG8gcHJvY2VlZC4gVGhyZWUgZ2F0ZXMsIGluIG9yZGVyOiBhbHJlYWR5LW1lcmdlZCwgYSBkaXNhYmxpbmcgbGFiZWwsXG4vLyBhbmQgYW4gYXV0aG9yIGFsbG93bGlzdC4gUHJlZmVyIHRoZSBsaXZlIFBSIG1ldGEuanNvbiwgYnV0IGZhbGwgYmFjayB0b1xuLy8gZmllbGRzIHRoYXQgYXJlIHByZXNlbnQgb24gcHVsbF9yZXF1ZXN0IHdlYmhvb2sgcGF5bG9hZHM7IGNoZWNrX3J1bi5jb21wbGV0ZWRcbi8vIHBheWxvYWRzIGRvIG5vdCBjYXJyeSBlbm91Z2ggZGV0YWlsLCBzbyB0aG9zZSBmYWlsIG9wZW4gd2hlbiBtZXRhIGlzIG1pc3NpbmcuXG5hc3luYyBmdW5jdGlvbiBzaG91bGRTa2lwUmV2aWV3KGN0eDogV29ya2ZvcmNlQ3R4LCBwcjogUHIpOiBQcm9taXNlPHsgcmVhc29uOiBzdHJpbmc7IG5vdGlmeT86IGJvb2xlYW4gfSB8IG51bGw+IHtcbiAgY29uc3QgbWV0YSA9IGF3YWl0IGxvYWRQck1ldGEocHIpO1xuXG4gIC8vIEFscmVhZHkgbWVyZ2VkL2Nsb3NlZCBieSB0aGUgdGltZSB3ZSBnb3QgaGVyZSBcdTIwMTQgZG9uJ3QgcG9zdCBhIHN0YWxlIHJldmlld1xuICAvLyBvbiBhIGZpbmlzaGVkIFBSLiBUaGlzIGlzIHRoZSBjaGVhcCwgYWdlbnQtc2lkZSBoYWxmIG9mIHRoZSBtZXJnZS1yYWNlO1xuICAvLyBwcmVzZXJ2aW5nIHRoZSB1bnB1c2hlZCBmaXhlcyB2aWEgYSByZWNvdmVyeSBQUiBuZWVkcyB0aGUgY2xvdWQtc2lkZSB3b3JrXG4gIC8vIHRyYWNrZWQgaW4gQWdlbnRXb3JrZm9yY2UvY2xvdWQjMTY1OSAvICMxNjYwLlxuICBjb25zdCBzdGF0ZSA9IChtZXRhPy5zdGF0ZSA/PyBwci5zdGF0ZSA/PyAnJykudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChtZXRhPy5tZXJnZWQgPT09IHRydWUgfHwgcHIubWVyZ2VkID09PSB0cnVlIHx8IHN0YXRlID09PSAnY2xvc2VkJykge1xuICAgIHJldHVybiB7IHJlYXNvbjogJ1BSIGlzIGFscmVhZHkgbWVyZ2VkL2Nsb3NlZCcsIG5vdGlmeTogdHJ1ZSB9O1xuICB9XG5cbiAgLy8gQSBkaXNhYmxpbmcgbGFiZWwgdHVybnMgdGhlIHJldmlld2VyIG9mZiBlbnRpcmVseSBmb3IgdGhpcyBQUi4gYGxhYmVsc2AgaXNcbiAgLy8gdmFsaWRhdGVkIGhlcmUgKG5vdCBqdXN0IHR5cGUtYXNzZXJ0ZWQpIHNpbmNlIG1ldGEuanNvbiBzaGFwZSBjYW4gZHJpZnQuXG4gIGNvbnN0IHNraXBMYWJlbHMgPSBza2lwTGFiZWxTZXQoY3R4KTtcbiAgY29uc3QgcHJMYWJlbHMgPSBsYWJlbE5hbWVzKEFycmF5LmlzQXJyYXkobWV0YT8ubGFiZWxzKSA/IG1ldGEubGFiZWxzIDogcHIubGFiZWxzKTtcbiAgY29uc3QgaGl0ID0gcHJMYWJlbHMuZmluZCgobmFtZSkgPT4gc2tpcExhYmVscy5oYXMobmFtZSkpO1xuICBpZiAoaGl0KSB7XG4gICAgcmV0dXJuIHsgcmVhc29uOiBgUFIgY2FycmllcyB0aGUgXCIke2hpdH1cIiBsYWJlbGAgfTtcbiAgfVxuXG4gIC8vIEF1dGhvciBhbGxvd2xpc3Q6IHdoZW4gUkVWSUVXX0FVVEhPUlMgaXMgc2V0LCBvbmx5IHJldmlldy9maXggUFJzIG9wZW5lZCBieVxuICAvLyB0aG9zZSBsb2dpbnMgKGUuZy4gXCJvbmx5IG15IG93biBQUnNcIikuIFVuc2V0IFx1MjE5MiByZXZpZXcgZXZlcnkgYXV0aG9yLlxuICAvLyBGYWlsIGNsb3NlZCB3aGVuIGNvbmZpZ3VyZWQ6IGlmIHRoZSBhdXRob3IgY2FuJ3QgYmUgcmVzb2x2ZWQgY29uZmlkZW50bHksXG4gIC8vIHNraXAgaW5zdGVhZCBvZiByaXNraW5nIGEgcmV2aWV3IG9uIHRoZSB3cm9uZyBQUiBhdXRob3IuXG4gIGNvbnN0IGFsbG93ID0gcmV2aWV3QXV0aG9yQWxsb3dsaXN0KGN0eCk7XG4gIGNvbnN0IGF1dGhvciA9IHJlc29sdmVBdXRob3JMb2dpbihtZXRhLCBwcik7XG4gIGNvbnN0IGFsbG93bGlzdFNraXAgPSByZXZpZXdBdXRob3JBbGxvd2xpc3REZWNpc2lvbihhbGxvdywgYXV0aG9yKTtcbiAgaWYgKGFsbG93bGlzdFNraXApIHtcbiAgICByZXR1cm4gYWxsb3dsaXN0U2tpcDtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogTG93ZXJjYXNlZCBQUiBhdXRob3IgbG9naW4sIHByZWZlcnJpbmcgdGhlIGF1dGhvcml0YXRpdmUgbWV0YS5qc29uIChzdHJpbmdcbiAqICBvciBgeyBsb2dpbiB9YCkgYW5kIGZhbGxpbmcgYmFjayB0byB0aGUgd2ViaG9vayBwYXlsb2FkLiBSZXR1cm5zICcnIHdoZW4gbm9cbiAqICBsb2dpbiBjYW4gYmUgZGV0ZXJtaW5lZC4gKi9cbmZ1bmN0aW9uIHJlc29sdmVBdXRob3JMb2dpbihtZXRhOiBQck1ldGEgfCB1bmRlZmluZWQsIHByOiBQcik6IHN0cmluZyB7XG4gIGNvbnN0IGZyb21NZXRhID0gdHlwZW9mIG1ldGE/LmF1dGhvciA9PT0gJ3N0cmluZycgPyBtZXRhLmF1dGhvciA6IG1ldGE/LmF1dGhvcj8ubG9naW47XG4gIHJldHVybiAoZnJvbU1ldGEgPz8gcHIuYXV0aG9yID8/ICcnKS50cmltKCkudG9Mb3dlckNhc2UoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZFByTWV0YShwcjogUHIpOiBQcm9taXNlPFByTWV0YSB8IHVuZGVmaW5lZD4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCByZWFkSnNvbkZpbGU8UHJNZXRhPihcbiAgICAgIHZmc0NsaWVudCgpLFxuICAgICAgJ2dpdGh1YicsXG4gICAgICAnZ2V0UHInLFxuICAgICAgYC9naXRodWIvcmVwb3MvJHtlbmNvZGVTZWdtZW50KHByLm93bmVyKX0vJHtlbmNvZGVTZWdtZW50KHByLnJlcG8pfS9wdWxscy8ke3ByLm51bWJlcn0vbWV0YS5qc29uYFxuICAgICk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbn1cblxuLyoqIExvd2VyY2FzZWQgbGFiZWwgbmFtZXMgdGhhdCBkaXNhYmxlIHRoZSByZXZpZXdlci4gRGVmYXVsdHMgdG9cbiAqICBcIm5vLWFnZW50LXJlbGF5LXJldmlld1wiIHdoZW4gU0tJUF9MQUJFTFMgaXMgdW5zZXQuICovXG5mdW5jdGlvbiBza2lwTGFiZWxTZXQoY3R4OiBXb3JrZm9yY2VDdHgpOiBTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IHJhdyA9IGlucHV0KGN0eCwgJ1NLSVBfTEFCRUxTJykgPz8gREVGQVVMVF9TS0lQX0xBQkVMO1xuICByZXR1cm4gbmV3IFNldChyYXcuc3BsaXQoJywnKS5tYXAoKHMpID0+IHMudHJpbSgpLnRvTG93ZXJDYXNlKCkpLmZpbHRlcihCb29sZWFuKSk7XG59XG5cbi8qKiBMb3dlcmNhc2VkIGdpdGh1YiBsb2dpbnMgYWxsb3dlZCB0byBiZSByZXZpZXdlZC9maXhlZC4gRW1wdHkgPSBldmVyeW9uZS4gKi9cbmZ1bmN0aW9uIHJldmlld0F1dGhvckFsbG93bGlzdChjdHg6IFdvcmtmb3JjZUN0eCk6IFNldDxzdHJpbmc+IHtcbiAgY29uc3QgcmF3ID0gaW5wdXQoY3R4LCAnUkVWSUVXX0FVVEhPUlMnKSA/PyAnJztcbiAgcmV0dXJuIG5ldyBTZXQocmF3LnNwbGl0KCcsJykubWFwKChzKSA9PiBzLnRyaW0oKS50b0xvd2VyQ2FzZSgpKS5maWx0ZXIoQm9vbGVhbikpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmV2aWV3QXV0aG9yQWxsb3dsaXN0RGVjaXNpb24oXG4gIGFsbG93OiBTZXQ8c3RyaW5nPixcbiAgYXV0aG9yOiBzdHJpbmdcbik6IHsgcmVhc29uOiBzdHJpbmcgfSB8IG51bGwge1xuICBpZiAoYWxsb3cuc2l6ZSA9PT0gMCkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmICghYXV0aG9yIHx8IGF1dGhvciA9PT0gJ3Vua25vd24nKSB7XG4gICAgcmV0dXJuIHsgcmVhc29uOiAnUkVWSUVXX0FVVEhPUlMgaXMgc2V0IGJ1dCB0aGUgUFIgYXV0aG9yIGNvdWxkIG5vdCBiZSByZXNvbHZlZCcgfTtcbiAgfVxuICBpZiAoIWFsbG93LmhhcyhhdXRob3IpKSB7XG4gICAgcmV0dXJuIHsgcmVhc29uOiBgYXV0aG9yIEAke2F1dGhvcn0gaXMgbm90IGluIFJFVklFV19BVVRIT1JTYCB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBsYWJlbE5hbWVzKGxhYmVsczogdW5rbm93bik6IHN0cmluZ1tdIHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGxhYmVscykpIHJldHVybiBbXTtcbiAgcmV0dXJuIGxhYmVsc1xuICAgIC5tYXAoKGwpID0+IChsICYmIHR5cGVvZiAobCBhcyB7IG5hbWU/OiB1bmtub3duIH0pLm5hbWUgPT09ICdzdHJpbmcnID8gKGwgYXMgeyBuYW1lOiBzdHJpbmcgfSkubmFtZS50cmltKCkudG9Mb3dlckNhc2UoKSA6ICcnKSlcbiAgICAuZmlsdGVyKEJvb2xlYW4pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBub3RpZnlTa2lwKGN0eDogV29ya2ZvcmNlQ3R4LCBwcjogUHIsIHJlYXNvbjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNoYW5uZWwgPSBpbnB1dChjdHgsICdTTEFDS19DSEFOTkVMJyk7XG4gIGlmICghY2hhbm5lbCkgcmV0dXJuO1xuICBhd2FpdCBzbGFja0NsaWVudCgpLnBvc3QoXG4gICAgY2hhbm5lbCxcbiAgICBgOmluZm9ybWF0aW9uX3NvdXJjZTogcHItcmV2aWV3ZXIgc2tpcHBlZCBQUiAjJHtwci5udW1iZXJ9IGluICoke3ByLm93bmVyfS8ke3ByLnJlcG99KiBcdTIwMTQgJHtyZWFzb259OiAke3ByLnVybH1gXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJldmlld0FuZEZpeChjdHg6IFdvcmtmb3JjZUN0eCwgcHI6IFByKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJ1biA9IGF3YWl0IGN0eC5oYXJuZXNzLnJ1bih7XG4gICAgY3dkOiBjdHguc2FuZGJveC5jd2QsXG4gICAgcHJvbXB0OiBbXG4gICAgICBgUmV2aWV3IHB1bGwgcmVxdWVzdCAjJHtwci5udW1iZXJ9IGluICR7cHIub3duZXJ9LyR7cHIucmVwb30uIFRoZSBQUiBjb2RlIGlzIGNoZWNrZWQgb3V0IGluIHRoZSBjdXJyZW50IGRpcmVjdG9yeS5gLFxuICAgICAgYEZvY3VzIG9uIHRoZSBhY3R1YWwgUFIgY2hhbmdlczogcmVhZCAud29ya2ZvcmNlL3ByLmRpZmYgZmlyc3QsIHRoZW4gLndvcmtmb3JjZS9jaGFuZ2VkLWZpbGVzLnR4dCBhbmQgLndvcmtmb3JjZS9jb250ZXh0Lmpzb24uYCxcbiAgICAgIGBVc2UgdGhlIGNoZWNrZWQtb3V0IHJlcG8gdG8gdHJhY2UgdGhlIGltcGFjdCBvZiB0aGlzIGRpZmYgYWNyb3NzIGNhbGxlcnMsIHR5cGVzLCB0ZXN0cywgY29uZmlnLCBhbmQgcmVsYXRlZCBmaWxlcy5gLFxuICAgICAgYEZsYWcgYW5kIGZpeCBicmVha2FnZSBldmVuIHdoZW4gdGhlIGFmZmVjdGVkIGZpbGUgaXMgb3V0c2lkZSB0aGUgY2hhbmdlZC1maWxlIHNldCwgYnV0IGRvIG5vdCBkbyBhbiB1bnJlbGF0ZWQgZnVsbC1yZXBvIGF1ZGl0LmAsXG4gICAgICBgVGhlbiBwcm9hY3RpdmVseSBGSVggZXZlcnl0aGluZyB0aGF0IG5lZWRzIGNoYW5naW5nIFx1MjAxNCB5b3VyIG93biBmaW5kaW5ncyBhbmQgYW55IG90aGVyIGJvdCByZXZpZXdzIG9uIHRoZSBQUiBcdTIwMTRgLFxuICAgICAgYGFuZCByZXNvbHZlIGZhaWxpbmcgQ0kgY2hlY2tzIGFuZCBtZXJnZSBjb25mbGljdHMgYnkgZWRpdGluZyB0aGUgY29kZS4gRG9uJ3QgdXNlIGdpdCBvciB0aGUgZ2ggQ0xJOyBjbG91ZCBjb21taXRzYCxcbiAgICAgIGBhbmQgcHVzaGVzIHlvdXIgZmlsZSBlZGl0cyB0byB0aGUgUFIgYWZ0ZXIgdGhpcyBydW4uIEluIHlvdXIgb3V0cHV0LCBkbyBub3QgY2xhaW0gdGhhdCBmaXhlcyB3ZXJlIHB1c2hlZCxgLFxuICAgICAgYGEgR2l0SHViIHJldmlldyB3YXMgc3VibWl0dGVkLCBvciBDSSB3YXMgdmVyaWZpZWQ7IHRob3NlIGFyZSBwb3N0LWhhcm5lc3MgYWN0aW9ucyB0aGF0IGNsb3VkIHJlcG9ydHMgc2VwYXJhdGVseS5gLFxuICAgICAgYFdoZW4gdGhlIFBSIGlzIGdlbnVpbmVseSByZWFkeSBmb3IgYSBodW1hbiBhZnRlciB5b3VyIGxvY2FsIHJldmlldyBhbmQgZWRpdHMsIGVuZCB5b3VyIG91dHB1dCB3aXRoIFJFQURZIG9uIGl0cyBvd24gbGFzdCBsaW5lLmBcbiAgICBdLmpvaW4oJ1xcbicpXG4gIH0pO1xuXG4gIGNvbnN0IGV4aXRDb2RlID0gKHJ1biBhcyB7IGV4aXRDb2RlPzogdW5rbm93biB9KS5leGl0Q29kZTtcbiAgaWYgKHR5cGVvZiBleGl0Q29kZSA9PT0gJ251bWJlcicgJiYgZXhpdENvZGUgIT09IDApIHtcbiAgICBhd2FpdCBmYWlsUmV2aWV3UnVuKGN0eCwgcHIsIGBUaGUgcmV2aWV3IGhhcm5lc3MgZXhpdGVkIHdpdGggY29kZSAke2V4aXRDb2RlfS5gKTtcbiAgfVxuXG4gIC8vIFRoZSBoYXJuZXNzIG9ubHkgd3JpdGVzIGEgcmV2aWV3IHdoZW4gd2UgZXhwbGljaXRseSBwb3N0IGl0LiBTdHJpcCB0aGVcbiAgLy8gUkVBRFkgc2VudGluZWwgKGl0J3MgdGhlIHNsYWNrL3JlYWR5IHNpZ25hbCwgbm90IGEgcmV2aWV3LWJvZHkgbGluZSkgYW5kXG4gIC8vIHBvc3Qgd2hhdGV2ZXIncyBsZWZ0IGFzIGEgUFIgY29tbWVudCB2aWEgdGhlIGdpdGh1YiBWRlMuXG4gIGNvbnN0IHJhdyA9IChydW4ub3V0cHV0ID8/ICcnKS50cmltRW5kKCk7XG4gIGNvbnN0IHJlYWR5ID0gbGFzdExpbmUocmF3KSA9PT0gJ1JFQURZJztcbiAgY29uc3QgYm9keSA9IHJlYWR5ID8gc3RyaXBMYXN0TGluZShyYXcpLnRyaW1FbmQoKSA6IHJhdztcbiAgaWYgKCFib2R5KSB7XG4gICAgYXdhaXQgZmFpbFJldmlld1J1bihjdHgsIHByLCAnVGhlIHJldmlldyBoYXJuZXNzIHByb2R1Y2VkIG5vIHJldmlldyBvdXRwdXQuJyk7XG4gIH1cbiAgaWYgKGJvZHkpIHtcbiAgICBhd2FpdCBnaXRodWJDbGllbnQoKS5jb21tZW50KHsgb3duZXI6IHByLm93bmVyLCByZXBvOiBwci5yZXBvLCBudW1iZXI6IHByLm51bWJlciB9LCBib2R5KTtcbiAgfVxuXG4gIGNvbnN0IGNoYW5uZWwgPSBpbnB1dChjdHgsICdTTEFDS19DSEFOTkVMJyk7XG4gIGlmIChjaGFubmVsKSB7XG4gICAgY29uc3Qgd2hvID0gYDxodHRwczovL2dpdGh1Yi5jb20vJHtwci5hdXRob3J9fEAke3ByLmF1dGhvcn0+YDsgLy8gdGhlIFBSIG9wZW5lclxuICAgIGF3YWl0IHNsYWNrQ2xpZW50KCkucG9zdChcbiAgICAgIGNoYW5uZWwsXG4gICAgICByZWFkeVxuICAgICAgICA/IGA6d2hpdGVfY2hlY2tfbWFyazogJHt3aG99IFx1MjAxNCBQUiAjJHtwci5udW1iZXJ9IGluICoke3ByLm93bmVyfS8ke3ByLnJlcG99KiBpcyByZWFkeSBmb3IgeW91ciByZXZpZXc6ICR7cHIudXJsfWBcbiAgICAgICAgOiBgOmV5ZXM6ICR7d2hvfSBcdTIwMTQgcmV2aWV3aW5nIFBSICMke3ByLm51bWJlcn0gaW4gKiR7cHIub3duZXJ9LyR7cHIucmVwb30qLCBzdGlsbCB3b3JraW5nIG9uIGl0OiAke3ByLnVybH1gXG4gICAgKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBmYWlsUmV2aWV3UnVuKGN0eDogV29ya2ZvcmNlQ3R4LCBwcjogUHIsIHJlYXNvbjogc3RyaW5nKTogUHJvbWlzZTxuZXZlcj4ge1xuICBjb25zdCBtZXNzYWdlID0gW1xuICAgIGBwci1yZXZpZXdlciBjb3VsZCBub3QgY29tcGxldGUgcmV2aWV3IGZvciAjJHtwci5udW1iZXJ9IGluICR7cHIub3duZXJ9LyR7cHIucmVwb30uYCxcbiAgICByZWFzb24sXG4gICAgJ05vIHJldmlldyB3YXMgcG9zdGVkOyB0aGlzIG5lZWRzIG9wZXJhdG9yIGF0dGVudGlvbi4nLFxuICBdLmpvaW4oJ1xcbicpO1xuICBjdHgubG9nPy4oJ2Vycm9yJywgJ3ByLXJldmlld2VyIGhhcm5lc3MgZmFpbGVkJywge1xuICAgIG93bmVyOiBwci5vd25lcixcbiAgICByZXBvOiBwci5yZXBvLFxuICAgIG51bWJlcjogcHIubnVtYmVyLFxuICAgIHJlYXNvbixcbiAgfSk7XG4gIGF3YWl0IGdpdGh1YkNsaWVudCgpLmNvbW1lbnQoeyBvd25lcjogcHIub3duZXIsIHJlcG86IHByLnJlcG8sIG51bWJlcjogcHIubnVtYmVyIH0sIG1lc3NhZ2UpO1xuICBjb25zdCBjaGFubmVsID0gaW5wdXQoY3R4LCAnU0xBQ0tfQ0hBTk5FTCcpO1xuICBpZiAoY2hhbm5lbCkge1xuICAgIGF3YWl0IHNsYWNrQ2xpZW50KCkucG9zdChcbiAgICAgIGNoYW5uZWwsXG4gICAgICBgOndhcm5pbmc6IHByLXJldmlld2VyIGZhaWxlZCBmb3IgUFIgIyR7cHIubnVtYmVyfSBpbiAqJHtwci5vd25lcn0vJHtwci5yZXBvfSo6ICR7cmVhc29ufWBcbiAgICApO1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWVyZ2VQcihjdHg6IFdvcmtmb3JjZUN0eCwgcHI6IFByKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdpdGh1YkNsaWVudCgpLm1lcmdlUHVsbFJlcXVlc3Qoe1xuICAgIG93bmVyOiBwci5vd25lcixcbiAgICByZXBvOiBwci5yZXBvLFxuICAgIG51bWJlcjogcHIubnVtYmVyLFxuICAgIG1ldGhvZDogJ3NxdWFzaCcsXG4gICAgLi4uKHByLmhlYWRTaGEgPyB7IHNoYTogcHIuaGVhZFNoYSB9IDoge30pXG4gIH0pO1xuICAvLyBtZXJnZVB1bGxSZXF1ZXN0IHN1cmZhY2VzIHRoZSB3cml0ZWJhY2sgd29ya2VyJ3MgbWVyZ2Ugb3V0Y29tZSBhcyBgbWVyZ2VkYC5cbiAgLy8gQSBmYWxzZS91bmNvbmZpcm1lZCByZXN1bHQgbWVhbnMgd2Ugc2hvdWxkbid0IHByZXRlbmQgdGhlIG1lcmdlIGxhbmRlZC5cbiAgaWYgKCFyZXN1bHQubWVyZ2VkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBHaXRIdWIgZGlkIG5vdCBjb25maXJtIFBSICMke3ByLm51bWJlcn0gaW4gJHtwci5vd25lcn0vJHtwci5yZXBvfSB3YXMgbWVyZ2VkLmApO1xuICB9XG4gIGNvbnN0IGNoYW5uZWwgPSBpbnB1dChjdHgsICdTTEFDS19DSEFOTkVMJyk7XG4gIGlmIChjaGFubmVsKSB7XG4gICAgYXdhaXQgc2xhY2tDbGllbnQoKS5wb3N0KGNoYW5uZWwsIGA6dGFkYTogTWVyZ2VkIFBSICMke3ByLm51bWJlcn0gaW4gJHtwci5vd25lcn0vJHtwci5yZXBvfS5gKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDAgcGFyc2luZyB0aGUgZ2l0aHViIHdlYmhvb2sgcGF5bG9hZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFRoZSBQUiBsaXZlcyBpbiBkaWZmZXJlbnQgcGxhY2VzIHBlciBldmVudDogYHB1bGxfcmVxdWVzdGAgKG9wZW5lZCAvXG4vLyBzeW5jaHJvbml6ZSAvIHJldmlldyAvIHJldmlld19jb21tZW50KSwgYGNoZWNrX3J1bi5wdWxsX3JlcXVlc3RzWzBdYFxuLy8gKGNoZWNrX3J1bi5jb21wbGV0ZWQpLCBvciB0aGUgdG9wLWxldmVsIGBudW1iZXJgLlxuZnVuY3Rpb24gcmVhZFByKHBheWxvYWQ6IHVua25vd24pOiBQciB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHAgPSBwYXlsb2FkIGFzIHtcbiAgICBudW1iZXI/OiBudW1iZXI7XG4gICAgcHVsbF9yZXF1ZXN0Pzoge1xuICAgICAgbnVtYmVyPzogbnVtYmVyO1xuICAgICAgaHRtbF91cmw/OiBzdHJpbmc7XG4gICAgICB1c2VyPzogeyBsb2dpbj86IHN0cmluZyB9O1xuICAgICAgaGVhZD86IHsgc2hhPzogc3RyaW5nIH07XG4gICAgICBzdGF0ZT86IHN0cmluZztcbiAgICAgIG1lcmdlZD86IGJvb2xlYW47XG4gICAgICBsYWJlbHM/OiB1bmtub3duO1xuICAgIH07XG4gICAgY2hlY2tfcnVuPzogeyBwdWxsX3JlcXVlc3RzPzogQXJyYXk8eyBudW1iZXI/OiBudW1iZXI7IGh0bWxfdXJsPzogc3RyaW5nOyBoZWFkX3NoYT86IHN0cmluZyB9PiB9O1xuICAgIHJlcG9zaXRvcnk/OiB7IG5hbWU/OiBzdHJpbmc7IG93bmVyPzogeyBsb2dpbj86IHN0cmluZyB9IH07XG4gICAgc2VuZGVyPzogeyBsb2dpbj86IHN0cmluZyB9O1xuICB9IHwgbnVsbDtcbiAgY29uc3QgcHJSZWYgPSBwPy5wdWxsX3JlcXVlc3QgPz8gcD8uY2hlY2tfcnVuPy5wdWxsX3JlcXVlc3RzPy5bMF07XG4gIGNvbnN0IG51bWJlciA9IHByUmVmPy5udW1iZXIgPz8gcD8ubnVtYmVyO1xuICBjb25zdCBvd25lciA9IHA/LnJlcG9zaXRvcnk/Lm93bmVyPy5sb2dpbjtcbiAgY29uc3QgcmVwbyA9IHA/LnJlcG9zaXRvcnk/Lm5hbWU7XG4gIC8vIFZhbGlkYXRlIGBudW1iZXJgIGlzIGEgcmVhbCBpbnRlZ2VyIFx1MjAxNCBpdCdzIGludGVycG9sYXRlZCBpbnRvIGEgc2hlbGwgY29tbWFuZC5cbiAgaWYgKHR5cGVvZiBudW1iZXIgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKG51bWJlcikgfHwgIW93bmVyIHx8ICFyZXBvKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBoZWFkU2hhID0gcD8ucHVsbF9yZXF1ZXN0Py5oZWFkPy5zaGEgPz8gcD8uY2hlY2tfcnVuPy5wdWxsX3JlcXVlc3RzPy5bMF0/LmhlYWRfc2hhO1xuICByZXR1cm4ge1xuICAgIG93bmVyLFxuICAgIHJlcG8sXG4gICAgbnVtYmVyLFxuICAgIHVybDogcHJSZWY/Lmh0bWxfdXJsID8/IGBodHRwczovL2dpdGh1Yi5jb20vJHtvd25lcn0vJHtyZXBvfS9wdWxsLyR7bnVtYmVyfWAsXG4gICAgYXV0aG9yOiBwPy5wdWxsX3JlcXVlc3Q/LnVzZXI/LmxvZ2luID8/IHA/LnNlbmRlcj8ubG9naW4gPz8gJ3Vua25vd24nLFxuICAgIC4uLihoZWFkU2hhID8geyBoZWFkU2hhIH0gOiB7fSksXG4gICAgLi4uKHA/LnB1bGxfcmVxdWVzdD8uc3RhdGUgPyB7IHN0YXRlOiBwLnB1bGxfcmVxdWVzdC5zdGF0ZSB9IDoge30pLFxuICAgIC4uLih0eXBlb2YgcD8ucHVsbF9yZXF1ZXN0Py5tZXJnZWQgPT09ICdib29sZWFuJyA/IHsgbWVyZ2VkOiBwLnB1bGxfcmVxdWVzdC5tZXJnZWQgfSA6IHt9KSxcbiAgICAuLi4ocD8ucHVsbF9yZXF1ZXN0Py5sYWJlbHMgIT09IHVuZGVmaW5lZCA/IHsgbGFiZWxzOiBwLnB1bGxfcmVxdWVzdC5sYWJlbHMgfSA6IHt9KVxuICB9O1xufVxuZnVuY3Rpb24gaXNBcHByb3ZhbChwYXlsb2FkOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIHJldHVybiAocGF5bG9hZCBhcyB7IHJldmlldz86IHsgc3RhdGU/OiBzdHJpbmcgfSB9IHwgbnVsbCk/LnJldmlldz8uc3RhdGU/LnRvTG93ZXJDYXNlKCkgPT09ICdhcHByb3ZlZCc7XG59XG4vKiogSG9ub3IgYXBwcm92YWxzIG9ubHkgZnJvbSBBUFBST1ZFUlMgKGNvbW1hLXNlcGFyYXRlZCBnaXRodWIgbG9naW5zKS4gV2hlblxuICogIEFQUFJPVkVSUyBpcyB1bnNldCwgYW55IGFwcHJvdmFsIG1lcmdlcy4gKi9cbmZ1bmN0aW9uIGlzQXV0aG9yaXplZEFwcHJvdmVyKGN0eDogV29ya2ZvcmNlQ3R4LCBwYXlsb2FkOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGNvbnN0IGFsbG93ID0gKGlucHV0KGN0eCwgJ0FQUFJPVkVSUycpID8/ICcnKS5zcGxpdCgnLCcpLm1hcCgocykgPT4gcy50cmltKCkudG9Mb3dlckNhc2UoKSkuZmlsdGVyKEJvb2xlYW4pO1xuICBpZiAoYWxsb3cubGVuZ3RoID09PSAwKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3QgYXBwcm92ZXIgPSAocGF5bG9hZCBhcyB7IHJldmlldz86IHsgdXNlcj86IHsgbG9naW4/OiBzdHJpbmcgfSB9IH0gfCBudWxsKT8ucmV2aWV3Py51c2VyPy5sb2dpbj8udG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIGFwcHJvdmVyICE9PSB1bmRlZmluZWQgJiYgYWxsb3cuaW5jbHVkZXMoYXBwcm92ZXIpO1xufVxuLyoqIEEgZmluaXNoZWQgY2hlY2sgcnVuIHRoYXQgZGlkbid0IHBhc3MgXHUyMDE0IGZhaWx1cmUsIHRpbWVkIG91dCwgY2FuY2VsbGVkLCBldGMuICovXG5mdW5jdGlvbiBjaUZhaWxlZChwYXlsb2FkOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGNvbnN0IGNvbmNsdXNpb24gPSAocGF5bG9hZCBhcyB7IGNoZWNrX3J1bj86IHsgY29uY2x1c2lvbj86IHN0cmluZyB9IH0gfCBudWxsKT8uY2hlY2tfcnVuPy5jb25jbHVzaW9uPy50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gY29uY2x1c2lvbiAhPT0gdW5kZWZpbmVkICYmIGNvbmNsdXNpb24gIT09ICdzdWNjZXNzJyAmJiBjb25jbHVzaW9uICE9PSAnbmV1dHJhbCcgJiYgY29uY2x1c2lvbiAhPT0gJ3NraXBwZWQnO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgdGlueSBoZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuZnVuY3Rpb24gbGFzdExpbmUodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQudHJpbUVuZCgpLnNwbGl0KCdcXG4nKS5wb3AoKT8udHJpbSgpID8/ICcnO1xufVxuZnVuY3Rpb24gc3RyaXBMYXN0TGluZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBpID0gdGV4dC5sYXN0SW5kZXhPZignXFxuJyk7XG4gIHJldHVybiBpIDwgMCA/ICcnIDogdGV4dC5zbGljZSgwLCBpKTtcbn1cbmZ1bmN0aW9uIGlucHV0KGN0eDogV29ya2ZvcmNlQ3R4LCBuYW1lOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBzcGVjID0gY3R4LnBlcnNvbmEuaW5wdXRTcGVjcz8uW25hbWVdO1xuICBjb25zdCB2ID0gcHJvY2Vzcy5lbnZbc3BlYz8uZW52ID8/IG5hbWVdID8/IGN0eC5wZXJzb25hLmlucHV0cz8uW25hbWVdID8/IHNwZWM/LmRlZmF1bHQ7XG4gIHJldHVybiB2ICYmIHYudHJpbSgpID8gdiA6IHVuZGVmaW5lZDtcbn1cbiIsIG51bGwsIG51bGwsIG51bGwsIG51bGwsIG51bGwsIG51bGwsIG51bGwsIG51bGxdLAogICJtYXBwaW5ncyI6ICI7QUFZQTtBQUFBLEVBQ0U7QUFBQSxFQUNBLGlCQUFBQTtBQUFBLEVBQ0EsZ0JBQUFDO0FBQUEsRUFDQSxvQkFBQUM7QUFBQSxPQUdLOzs7QUNuQlAsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxPQUFPLFVBQVUsU0FBUyxRQUFRLGlCQUFpQjtBQUM1RCxPQUFPLFVBQVU7QUFnQ1gsSUFBTywwQkFBUCxjQUF1QyxNQUFLO0VBQ3ZDO0VBQ0E7RUFDUztFQUNUO0VBRVQsWUFBWSxTQUF1QztBQUNqRCxVQUNFLEdBQUcsUUFBUSxRQUFRLElBQUksUUFBUSxTQUFTLFVBQ3RDLFFBQVEsaUJBQWlCLFFBQVEsS0FBSyxRQUFRLE1BQU0sT0FBTyxLQUFLLEVBQ2xFLEVBQUU7QUFFSixTQUFLLE9BQU87QUFDWixTQUFLLFdBQVcsUUFBUTtBQUN4QixTQUFLLFlBQVksUUFB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VSxFQUFFLFFBQVEsSUFBSSxDQUFDO0FBQUEsSUFDN0IsR0FBSSxHQUFHLGNBQWMsUUFBUSxFQUFFLE9BQU8sRUFBRSxhQUFhLE1BQU0sSUFBSSxDQUFDO0FBQUEsSUFDaEUsR0FBSSxPQUFPLEdBQUcsY0FBYyxXQUFXLFlBQVksRUFBRSxRQUFRLEVBQUUsYUFBYSxPQUFPLElBQUksQ0FBQztBQUFBLElBQ3hGLEdBQUksR0FBRyxjQUFjLFdBQVcsU0FBWSxFQUFFLFFBQVEsRUFBRSxhQUFhLE9BQU8sSUFBSSxDQUFDO0FBQUEsRUFDbkY7QUFDRjtBQUNBLFNBQVMsV0FBVyxTQUEyQjtBQUM3QyxTQUFRLFNBQW9ELFFBQVEsT0FBTyxZQUFZLE1BQU07QUFDL0Y7QUFHQSxTQUFTLHFCQUFxQixLQUFtQixTQUEyQjtBQUMxRSxRQUFNLFNBQVMsTUFBTSxLQUFLLFdBQVcsS0FBSyxJQUFJLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLFlBQVksQ0FBQyxFQUFFLE9BQU8sT0FBTztBQUMxRyxNQUFJLE1BQU0sV0FBVyxFQUFHLFFBQU87QUFDL0IsUUFBTSxXQUFZLFNBQStELFFBQVEsTUFBTSxPQUFPLFlBQVk7QUFDbEgsU0FBTyxhQUFhLFVBQWEsTUFBTSxTQUFTLFFBQVE7QUFDMUQ7QUFFQSxTQUFTLFNBQVMsU0FBMkI7QUFDM0MsUUFBTSxhQUFjLFNBQTRELFdBQVcsWUFBWSxZQUFZO0FBQ25ILFNBQU8sZUFBZSxVQUFhLGVBQWUsYUFBYSxlQUFlLGFBQWEsZUFBZTtBQUM1RztBQUdBLFNBQVMsU0FBUyxNQUFzQjtBQUN0QyxTQUFPLEtBQUssUUFBUSxFQUFFLE1BQU0sSUFBSSxFQUFFLElBQUksR0FBRyxLQUFLLEtBQUs7QUFDckQ7QUFDQSxTQUFTLGNBQWMsTUFBc0I7QUFDM0MsUUFBTSxJQUFJLEtBQUssWUFBWSxJQUFJO0FBQy9CLFNBQU8sSUFBSSxJQUFJLEtBQUssS0FBSyxNQUFNLEdBQUcsQ0FBQztBQUNyQztBQUNBLFNBQVMsTUFBTSxLQUFtQixNQUFrQztBQUNsRSxRQUFNLE9BQU8sSUFBSSxRQUFRLGFBQWEsSUFBSTtBQUMxQyxRQUFNLElBQUksUUFBUSxJQUFJLE1BQU0sT0FBTyxJQUFJLEtBQUssSUFBSSxRQUFRLFNBQVMsSUFBSSxLQUFLLE1BQU07QUFDaEYsU0FBTyxLQUFLLEVBQUUsS0FBSyxJQUFJLElBQUk7QUFDN0I7IiwKICAibmFtZXMiOiBbImVuY29kZVNlZ21lbnQiLCAicmVhZEpzb25GaWxlIiwgInJlc29sdmVNb3VudFJvb3QiLCAicGF0aCIsICJyZXNvbHZlTW91bnRSb290IiwgInByIiwgInJlYWRKc29uRmlsZSIsICJlbmNvZGVTZWdtZW50Il0KfQo=
