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
    return { reason: "PR is already merged/closed" };
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
      `Only end your output with READY on its own last line when the PR genuinely needs a human now \u2014 meaning you have`,
      `resolved or addressed every bot and reviewer comment, there are no failing checks left that you could fix, and the`,
      `remaining decision requires human judgment. If anything is still red, unresolved, or in-progress, do NOT print READY.`
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
  if (channel && ready) {
    const who = `<https://github.com/${pr.author}|@${pr.author}>`;
    await slackClient().post(
      channel,
      `:white_check_mark: ${who} \u2014 PR #${pr.number} in *${pr.owner}/${pr.repo}* is ready for your review: ${pr.url}`
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
    author: p?.pull_request?.user?.login ?? "unknown",
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
  labelNames,
  readPr,
  resolveAuthorLogin,
  reviewAuthorAllowlistDecision
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vYWdlbnQudHMiLCAiLi4vLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0ByZWxheWZpbGUvYWRhcHRlci1jb3JlL3NyYy92ZnMtY2xpZW50L2luZGV4LnRzIiwgIi4uLy4uLy4uLy4uL25vZGVfbW9kdWxlcy9AcmVsYXlmaWxlL2FkYXB0ZXItY29yZS9zcmMvd3JpdGViYWNrLXBhdGhzL2NhdGFsb2cuZ2VuZXJhdGVkLnRzIiwgIi4uLy4uLy4uLy4uL25vZGVfbW9kdWxlcy9AcmVsYXlmaWxlL2FkYXB0ZXItY29yZS9zcmMvd3JpdGViYWNrLXBhdGhzL3Jlc29sdmVyLnRzIiwgIi4uLy4uLy4uLy4uL25vZGVfbW9kdWxlcy9AcmVsYXlmaWxlL3JlbGF5LWhlbHBlcnMvc3JjL2dlbmVyaWMudHMiLCAiLi4vLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0ByZWxheWZpbGUvcmVsYXktaGVscGVycy9zcmMvcHJvdmlkZXItY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL25vZGVfbW9kdWxlcy9AcmVsYXlmaWxlL3JlbGF5LWhlbHBlcnMvc3JjL3JlY2VpcHQudHMiLCAiLi4vLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0ByZWxheWZpbGUvcmVsYXktaGVscGVycy9zcmMvZ2l0aHViLnRzIiwgIi4uLy4uLy4uLy4uL25vZGVfbW9kdWxlcy9AcmVsYXlmaWxlL3JlbGF5LWhlbHBlcnMvc3JjL3NsYWNrLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIHByLXJldmlld2VyIGhhbmRsZXIgXHUyMDE0IHJldmlldywgYXV0by1maXgsIGFuZCBzaGVwaGVyZCBhIFBSIHRvIHRoZSBmaW5pc2ggbGluZS5cbiAqXG4gKiAgIGFuIGF1dGhvcml6ZWQgYXBwcm92YWwgKHB1bGxfcmVxdWVzdF9yZXZpZXcuc3VibWl0dGVkKSBcdTIxOTIgbWVyZ2UgdGhlIFBSLlxuICogICBhIGNoZWNrIHJ1biB0aGF0IGZpbmlzaGVkIGdyZWVuIChjaGVja19ydW4uY29tcGxldGVkKSAgIFx1MjE5MiBub3RoaW5nIHRvIGRvLlxuICogICBhbnl0aGluZyBlbHNlIFx1MjAxNCBvcGVuZWQsIG5ldyBjb21taXRzIChzeW5jaHJvbml6ZSksIGFcbiAqICAgcmV2aWV3IGNvbW1lbnQsIGZhaWxlZCBDSSwgY2hhbmdlcyByZXF1ZXN0ZWQgICAgICAgICAgICBcdTIxOTIgKHJlKXJldmlldyBhbmQgZml4LlxuICpcbiAqIFRoZSBQUidzIHJlcG8gaXMgbWF0ZXJpYWxpemVkIGludG8gY3R4LnNhbmRib3guY3dkIGJ5IGNsb3VkIGJlZm9yZSB0aGVcbiAqIGhhcm5lc3MgcnVucy4gVGhlIGFnZW50IGZpeGVzIGJ5IGVkaXRpbmcgZmlsZXMgdGhlcmU7IGNsb3VkIGNvbW1pdHMgYW5kXG4gKiBwdXNoZXMgdGhvc2UgZWRpdHMgYWZ0ZXIgdGhlIGhhcm5lc3MgZXhpdHMgXHUyMDE0IG5vIGdpdC9naCBpbiB0aGUgaGFybmVzcy5cbiAqXG4gKiBTbGFjayBwb2xpY3k6IHRoZSBjaGFubmVsIG9ubHkgaGVhcnMgYWJvdXQgYSBQUiB3aGVuIGl0J3MgYSBodW1hbidzIHR1cm4gXHUyMDE0XG4gKiBjaGVja3MgZ3JlZW4sIGV2ZXJ5IGJvdC9yZXZpZXdlciBjb21tZW50IHJlc29sdmVkLCBub3RoaW5nIGxlZnQgZm9yIHRoZSBhZ2VudFxuICogdG8gZml4ICh0aGUgYWdlbnQncyBSRUFEWSBzZW50aW5lbCkuIEluLXByb2dyZXNzIHBhc3NlcyBzdGF5IHNpbGVudC4gVGhlIG9ubHlcbiAqIG90aGVyIHBpbmdzIGFyZSBvcGVyYXRvci90ZXJtaW5hbCBzaWduYWxzOiBhIGZhaWxlZCBoYXJuZXNzIHJ1biBhbmQgYSBtZXJnZS5cbiAqL1xuaW1wb3J0IHtcbiAgZGVmaW5lQWdlbnQsXG4gIGVuY29kZVNlZ21lbnQsXG4gIHJlYWRKc29uRmlsZSxcbiAgcmVzb2x2ZU1vdW50Um9vdCxcbiAgdHlwZSBJbnRlZ3JhdGlvbkNsaWVudE9wdGlvbnMsXG4gIHR5cGUgV29ya2ZvcmNlQ3R4XG59IGZyb20gJ0BhZ2VudHdvcmtmb3JjZS9ydW50aW1lJztcbmltcG9ydCB7IGdpdGh1YkNsaWVudCwgc2xhY2tDbGllbnQgfSBmcm9tICdAcmVsYXlmaWxlL3JlbGF5LWhlbHBlcnMnO1xuXG5pbnRlcmZhY2UgUHIge1xuICBvd25lcjogc3RyaW5nO1xuICByZXBvOiBzdHJpbmc7XG4gIG51bWJlcjogbnVtYmVyO1xuICB1cmw6IHN0cmluZztcbiAgYXV0aG9yOiBzdHJpbmc7IC8vIGdpdGh1YiBsb2dpbiBvZiB3aG9ldmVyIG9wZW5lZCB0aGUgUFJcbiAgaGVhZFNoYT86IHN0cmluZztcbiAgc3RhdGU/OiBzdHJpbmc7XG4gIG1lcmdlZD86IGJvb2xlYW47XG4gIGxhYmVscz86IHVua25vd247XG59XG5cbi8qKiBUaGUgbWF0ZXJpYWxpemVkIFBSIHJlY29yZCBhdCBgXHUyMDI2L3B1bGxzL3tufS9tZXRhLmpzb25gLiBSZWFkIGZvciB0aGVcbiAqICBhdXRob3JpdGF0aXZlIGF1dGhvci9sYWJlbHMvc3RhdGUgXHUyMDE0IHRoZSB3ZWJob29rIHBheWxvYWQgZG9lc24ndCBjYXJyeSB0aGVtXG4gKiAgb24gZXZlcnkgdHJpZ2dlciAoY2hlY2tfcnVuLmNvbXBsZXRlZCBoYXMgbmVpdGhlcikuIFJlYWQgZGVmZW5zaXZlbHk6IHRoZVxuICogIHNoYXBlIGlzIHRoZSBnaXRodWIgYWRhcHRlcidzIHByb2plY3Rpb24gYW5kIGZpZWxkcyBtYXkgYmUgYWJzZW50LiAqL1xuaW50ZXJmYWNlIFByTWV0YSB7XG4gIHN0YXRlPzogc3RyaW5nOyAvLyAnb3BlbicgfCAnY2xvc2VkJ1xuICBtZXJnZWQ/OiBib29sZWFuO1xuICAvLyBUaGUgbWF0ZXJpYWxpemVkIG1ldGEuanNvbiBoYXMgY2FycmllZCBgYXV0aG9yYCBib3RoIGFzIGEgYmFyZSBsb2dpblxuICAvLyBzdHJpbmcgYW5kIGFzIGFuIG9iamVjdCBcdTIwMTQgYWNjZXB0IGVpdGhlciBzbyB0aGUgYWxsb3dsaXN0IGlzbid0IHNpbGVudGx5XG4gIC8vIGJ5cGFzc2VkIGJ5IGEgc2hhcGUgbWlzbWF0Y2guXG4gIGF1dGhvcj86IHN0cmluZyB8IHsgbG9naW4/OiBzdHJpbmcgfTtcbiAgbGFiZWxzPzogdW5rbm93bjsgLy8gdmFsaWRhdGVkIGFzIEFycmF5PHsgbmFtZT86IHN0cmluZyB9PiBhdCByZWFkIHRpbWVcbiAgW2tleTogc3RyaW5nXTogdW5rbm93bjtcbn1cblxuY29uc3QgREVGQVVMVF9TS0lQX0xBQkVMID0gJ25vLWFnZW50LXJlbGF5LXJldmlldyc7XG5cbmZ1bmN0aW9uIHZmc0NsaWVudCgpOiBJbnRlZ3JhdGlvbkNsaWVudE9wdGlvbnMge1xuICByZXR1cm4geyByZWxheWZpbGVNb3VudFJvb3Q6IHJlc29sdmVNb3VudFJvb3Qoe30pIH07XG59XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUFnZW50KHtcbiAgLy8gUmUtcmV2aWV3IG9uIGV2ZXJ5IFBSIGNoYW5nZSAob3BlbiwgbmV3IGNvbW1pdHMsIHJldmlldyBjb21tZW50cywgZmluaXNoZWRcbiAgLy8gQ0kpLCBhbmQgbWVyZ2Ugd2hlbiB5b3UgYXBwcm92ZS4gRXZlcnkgYG9uYCB2YWx1ZSBhdXRvY29tcGxldGVzIGZyb21cbiAgLy8gZ2l0aHViJ3MgY2F0YWxvZyAoc2VlIHJlbGF5ZmlsZS1hZGFwdGVycyBERUZBVUxUX1NVUFBPUlRFRF9FVkVOVFMpLlxuICB0cmlnZ2Vyczoge1xuICAgIGdpdGh1YjogW1xuICAgICAgeyBvbjogJ3B1bGxfcmVxdWVzdC5vcGVuZWQnIH0sXG4gICAgICB7IG9uOiAncHVsbF9yZXF1ZXN0X3Jldmlldy5zdWJtaXR0ZWQnIH0sXG4gICAgICB7IG9uOiAncHVsbF9yZXF1ZXN0X3Jldmlld19jb21tZW50LmNyZWF0ZWQnIH0sXG4gICAgICB7IG9uOiAnY2hlY2tfcnVuLmNvbXBsZXRlZCcgfSxcbiAgICAgIHsgb246ICdwdWxsX3JlcXVlc3Quc3luY2hyb25pemUnIH1cbiAgICBdXG4gIH0sXG4gIGhhbmRsZXI6IGFzeW5jIChjdHgsIGV2ZW50KSA9PiB7XG4gIGlmIChldmVudC5zb3VyY2UgIT09ICdnaXRodWInKSByZXR1cm47XG5cbiAgLy8gQW4gYXBwcm92YWwgZnJvbSBhbiBhdXRob3JpemVkIHJldmlld2VyIGVuZHMgdGhlIGxvb3A6IG1lcmdlIGFuZCBzdG9wLlxuICBpZiAoZXZlbnQudHlwZSA9PT0gJ3B1bGxfcmVxdWVzdF9yZXZpZXcuc3VibWl0dGVkJyAmJiBpc0FwcHJvdmFsKGV2ZW50LnBheWxvYWQpICYmIGlzQXV0aG9yaXplZEFwcHJvdmVyKGN0eCwgZXZlbnQucGF5bG9hZCkpIHtcbiAgICBjb25zdCBwciA9IHJlYWRQcihldmVudC5wYXlsb2FkKTtcbiAgICBpZiAocHIpIGF3YWl0IG1lcmdlUHIoY3R4LCBwcik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQSBjaGVjayBydW4gdGhhdCBmaW5pc2hlZCB3aXRob3V0IGZhaWxpbmcgbmVlZHMgbm8gYWN0aW9uLlxuICBpZiAoZXZlbnQudHlwZSA9PT0gJ2NoZWNrX3J1bi5jb21wbGV0ZWQnICYmICFjaUZhaWxlZChldmVudC5wYXlsb2FkKSkgcmV0dXJuO1xuXG4gIC8vIEV2ZXJ5dGhpbmcgZWxzZSBpcyBhIHJlYXNvbiB0byAocmUpcmV2aWV3IGFuZCBwdXNoIGZpeGVzLlxuICBjb25zdCBwciA9IHJlYWRQcihldmVudC5wYXlsb2FkKTtcbiAgaWYgKHByKSB7XG4gICAgY29uc3Qgc2tpcCA9IGF3YWl0IHNob3VsZFNraXBSZXZpZXcoY3R4LCBwcik7XG4gICAgaWYgKHNraXApIHtcbiAgICAgIGN0eC5sb2c/LignaW5mbycsICdwci1yZXZpZXdlciBza2lwcGVkJywgeyBvd25lcjogcHIub3duZXIsIHJlcG86IHByLnJlcG8sIG51bWJlcjogcHIubnVtYmVyLCByZWFzb246IHNraXAucmVhc29uIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCByZXZpZXdBbmRGaXgoY3R4LCBwcik7XG4gIH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gJ2NoZWNrX3J1bi5jb21wbGV0ZWQnKSB7XG4gICAgLy8gR2l0SHViIHNvbWV0aW1lcyBlbWl0cyBjaGVja19ydW4uY29tcGxldGVkIHdpdGggcHVsbF9yZXF1ZXN0czogW10gZm9yXG4gICAgLy8gZm9yayBQUnMgYW5kIG9yZy1sZXZlbCBjaGVja3M7IHN1cmZhY2Ugc28gYSBcInNpbGVudCBuby1vcFwiIGlzbid0XG4gICAgLy8gbWlzdGFrZW4gZm9yIFwiUFIgcmV2aWV3IHNraXBwZWQgb24gcHVycG9zZVwiLlxuICAgIGN0eC5sb2c/LignaW5mbycsICdjaGVja19ydW4uY29tcGxldGVkIHdpdGggbm8gYXNzb2NpYXRlZCBQUjsgc2tpcHBpbmcnLCB7IGV2ZW50SWQ6IGV2ZW50LmlkIH0pO1xuICB9XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgcmV2aWV3IGdhdGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBEZWNpZGUgd2hldGhlciB0byAocmUpcmV2aWV3L2ZpeCB0aGlzIFBSIGF0IGFsbC4gUmV0dXJucyBhIHNraXAgcmVhc29uLCBvclxuLy8gbnVsbCB0byBwcm9jZWVkLiBUaHJlZSBnYXRlcywgaW4gb3JkZXI6IGFscmVhZHktbWVyZ2VkLCBhIGRpc2FibGluZyBsYWJlbCxcbi8vIGFuZCBhbiBhdXRob3IgYWxsb3dsaXN0LiBQcmVmZXIgdGhlIGxpdmUgUFIgbWV0YS5qc29uLCBidXQgZmFsbCBiYWNrIHRvXG4vLyBmaWVsZHMgdGhhdCBhcmUgcHJlc2VudCBvbiBwdWxsX3JlcXVlc3Qgd2ViaG9vayBwYXlsb2FkczsgY2hlY2tfcnVuLmNvbXBsZXRlZFxuLy8gcGF5bG9hZHMgZG8gbm90IGNhcnJ5IGVub3VnaCBkZXRhaWwsIHNvIHRob3NlIGZhaWwgb3BlbiB3aGVuIG1ldGEgaXMgbWlzc2luZy5cbmFzeW5jIGZ1bmN0aW9uIHNob3VsZFNraXBSZXZpZXcoY3R4OiBXb3JrZm9yY2VDdHgsIHByOiBQcik6IFByb21pc2U8eyByZWFzb246IHN0cmluZyB9IHwgbnVsbD4ge1xuICBjb25zdCBtZXRhID0gYXdhaXQgbG9hZFByTWV0YShwcik7XG5cbiAgLy8gQWxyZWFkeSBtZXJnZWQvY2xvc2VkIGJ5IHRoZSB0aW1lIHdlIGdvdCBoZXJlIFx1MjAxNCBkb24ndCBwb3N0IGEgc3RhbGUgcmV2aWV3XG4gIC8vIG9uIGEgZmluaXNoZWQgUFIuIFRoaXMgaXMgdGhlIGNoZWFwLCBhZ2VudC1zaWRlIGhhbGYgb2YgdGhlIG1lcmdlLXJhY2U7XG4gIC8vIHByZXNlcnZpbmcgdGhlIHVucHVzaGVkIGZpeGVzIHZpYSBhIHJlY292ZXJ5IFBSIG5lZWRzIHRoZSBjbG91ZC1zaWRlIHdvcmtcbiAgLy8gdHJhY2tlZCBpbiBBZ2VudFdvcmtmb3JjZS9jbG91ZCMxNjU5IC8gIzE2NjAuXG4gIGNvbnN0IHN0YXRlID0gKG1ldGE/LnN0YXRlID8/IHByLnN0YXRlID8/ICcnKS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKG1ldGE/Lm1lcmdlZCA9PT0gdHJ1ZSB8fCBwci5tZXJnZWQgPT09IHRydWUgfHwgc3RhdGUgPT09ICdjbG9zZWQnKSB7XG4gICAgcmV0dXJuIHsgcmVhc29uOiAnUFIgaXMgYWxyZWFkeSBtZXJnZWQvY2xvc2VkJyB9O1xuICB9XG5cbiAgLy8gQSBkaXNhYmxpbmcgbGFiZWwgdHVybnMgdGhlIHJldmlld2VyIG9mZiBlbnRpcmVseSBmb3IgdGhpcyBQUi4gYGxhYmVsc2AgaXNcbiAgLy8gdmFsaWRhdGVkIGhlcmUgKG5vdCBqdXN0IHR5cGUtYXNzZXJ0ZWQpIHNpbmNlIG1ldGEuanNvbiBzaGFwZSBjYW4gZHJpZnQuXG4gIGNvbnN0IHNraXBMYWJlbHMgPSBza2lwTGFiZWxTZXQoY3R4KTtcbiAgY29uc3QgcHJMYWJlbHMgPSBsYWJlbE5hbWVzKEFycmF5LmlzQXJyYXkobWV0YT8ubGFiZWxzKSA/IG1ldGEubGFiZWxzIDogcHIubGFiZWxzKTtcbiAgY29uc3QgaGl0ID0gcHJMYWJlbHMuZmluZCgobmFtZSkgPT4gc2tpcExhYmVscy5oYXMobmFtZSkpO1xuICBpZiAoaGl0KSB7XG4gICAgcmV0dXJuIHsgcmVhc29uOiBgUFIgY2FycmllcyB0aGUgXCIke2hpdH1cIiBsYWJlbGAgfTtcbiAgfVxuXG4gIC8vIEF1dGhvciBhbGxvd2xpc3Q6IHdoZW4gUkVWSUVXX0FVVEhPUlMgaXMgc2V0LCBvbmx5IHJldmlldy9maXggUFJzIG9wZW5lZCBieVxuICAvLyB0aG9zZSBsb2dpbnMgKGUuZy4gXCJvbmx5IG15IG93biBQUnNcIikuIFVuc2V0IFx1MjE5MiByZXZpZXcgZXZlcnkgYXV0aG9yLlxuICAvLyBGYWlsIGNsb3NlZCB3aGVuIGNvbmZpZ3VyZWQ6IGlmIHRoZSBhdXRob3IgY2FuJ3QgYmUgcmVzb2x2ZWQgY29uZmlkZW50bHksXG4gIC8vIHNraXAgaW5zdGVhZCBvZiByaXNraW5nIGEgcmV2aWV3IG9uIHRoZSB3cm9uZyBQUiBhdXRob3IuXG4gIGNvbnN0IGFsbG93ID0gcmV2aWV3QXV0aG9yQWxsb3dsaXN0KGN0eCk7XG4gIGNvbnN0IGF1dGhvciA9IHJlc29sdmVBdXRob3JMb2dpbihtZXRhLCBwcik7XG4gIGNvbnN0IGFsbG93bGlzdFNraXAgPSByZXZpZXdBdXRob3JBbGxvd2xpc3REZWNpc2lvbihhbGxvdywgYXV0aG9yKTtcbiAgaWYgKGFsbG93bGlzdFNraXApIHtcbiAgICByZXR1cm4gYWxsb3dsaXN0U2tpcDtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogTG93ZXJjYXNlZCBQUiBhdXRob3IgbG9naW4sIHByZWZlcnJpbmcgdGhlIGF1dGhvcml0YXRpdmUgbWV0YS5qc29uIChzdHJpbmdcbiAqICBvciBgeyBsb2dpbiB9YCkgYW5kIGZhbGxpbmcgYmFjayB0byB0aGUgd2ViaG9vayBwYXlsb2FkLiBSZXR1cm5zICcnIHdoZW4gbm9cbiAqICBsb2dpbiBjYW4gYmUgZGV0ZXJtaW5lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQXV0aG9yTG9naW4obWV0YTogUHJNZXRhIHwgdW5kZWZpbmVkLCBwcjogUHIpOiBzdHJpbmcge1xuICBjb25zdCBmcm9tTWV0YSA9IHR5cGVvZiBtZXRhPy5hdXRob3IgPT09ICdzdHJpbmcnID8gbWV0YS5hdXRob3IgOiBtZXRhPy5hdXRob3I/LmxvZ2luO1xuICByZXR1cm4gKGZyb21NZXRhID8/IHByLmF1dGhvciA/PyAnJykudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRQck1ldGEocHI6IFByKTogUHJvbWlzZTxQck1ldGEgfCB1bmRlZmluZWQ+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgcmVhZEpzb25GaWxlPFByTWV0YT4oXG4gICAgICB2ZnNDbGllbnQoKSxcbiAgICAgICdnaXRodWInLFxuICAgICAgJ2dldFByJyxcbiAgICAgIGAvZ2l0aHViL3JlcG9zLyR7ZW5jb2RlU2VnbWVudChwci5vd25lcil9LyR7ZW5jb2RlU2VnbWVudChwci5yZXBvKX0vcHVsbHMvJHtwci5udW1iZXJ9L21ldGEuanNvbmBcbiAgICApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKiBMb3dlcmNhc2VkIGxhYmVsIG5hbWVzIHRoYXQgZGlzYWJsZSB0aGUgcmV2aWV3ZXIuIERlZmF1bHRzIHRvXG4gKiAgXCJuby1hZ2VudC1yZWxheS1yZXZpZXdcIiB3aGVuIFNLSVBfTEFCRUxTIGlzIHVuc2V0LiAqL1xuZnVuY3Rpb24gc2tpcExhYmVsU2V0KGN0eDogV29ya2ZvcmNlQ3R4KTogU2V0PHN0cmluZz4ge1xuICBjb25zdCByYXcgPSBpbnB1dChjdHgsICdTS0lQX0xBQkVMUycpID8/IERFRkFVTFRfU0tJUF9MQUJFTDtcbiAgcmV0dXJuIG5ldyBTZXQocmF3LnNwbGl0KCcsJykubWFwKChzKSA9PiBzLnRyaW0oKS50b0xvd2VyQ2FzZSgpKS5maWx0ZXIoQm9vbGVhbikpO1xufVxuXG4vKiogTG93ZXJjYXNlZCBnaXRodWIgbG9naW5zIGFsbG93ZWQgdG8gYmUgcmV2aWV3ZWQvZml4ZWQuIEVtcHR5ID0gZXZlcnlvbmUuICovXG5mdW5jdGlvbiByZXZpZXdBdXRob3JBbGxvd2xpc3QoY3R4OiBXb3JrZm9yY2VDdHgpOiBTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IHJhdyA9IGlucHV0KGN0eCwgJ1JFVklFV19BVVRIT1JTJykgPz8gJyc7XG4gIHJldHVybiBuZXcgU2V0KHJhdy5zcGxpdCgnLCcpLm1hcCgocykgPT4gcy50cmltKCkudG9Mb3dlckNhc2UoKSkuZmlsdGVyKEJvb2xlYW4pKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJldmlld0F1dGhvckFsbG93bGlzdERlY2lzaW9uKFxuICBhbGxvdzogU2V0PHN0cmluZz4sXG4gIGF1dGhvcjogc3RyaW5nXG4pOiB7IHJlYXNvbjogc3RyaW5nIH0gfCBudWxsIHtcbiAgaWYgKGFsbG93LnNpemUgPT09IDApIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAoIWF1dGhvciB8fCBhdXRob3IgPT09ICd1bmtub3duJykge1xuICAgIHJldHVybiB7IHJlYXNvbjogJ1JFVklFV19BVVRIT1JTIGlzIHNldCBidXQgdGhlIFBSIGF1dGhvciBjb3VsZCBub3QgYmUgcmVzb2x2ZWQnIH07XG4gIH1cbiAgaWYgKCFhbGxvdy5oYXMoYXV0aG9yKSkge1xuICAgIHJldHVybiB7IHJlYXNvbjogYGF1dGhvciBAJHthdXRob3J9IGlzIG5vdCBpbiBSRVZJRVdfQVVUSE9SU2AgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxhYmVsTmFtZXMobGFiZWxzOiB1bmtub3duKTogc3RyaW5nW10ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkobGFiZWxzKSkgcmV0dXJuIFtdO1xuICByZXR1cm4gbGFiZWxzXG4gICAgLm1hcCgobCkgPT4gKGwgJiYgdHlwZW9mIChsIGFzIHsgbmFtZT86IHVua25vd24gfSkubmFtZSA9PT0gJ3N0cmluZycgPyAobCBhcyB7IG5hbWU6IHN0cmluZyB9KS5uYW1lLnRyaW0oKS50b0xvd2VyQ2FzZSgpIDogJycpKVxuICAgIC5maWx0ZXIoQm9vbGVhbik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJldmlld0FuZEZpeChjdHg6IFdvcmtmb3JjZUN0eCwgcHI6IFByKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJ1biA9IGF3YWl0IGN0eC5oYXJuZXNzLnJ1bih7XG4gICAgY3dkOiBjdHguc2FuZGJveC5jd2QsXG4gICAgcHJvbXB0OiBbXG4gICAgICBgUmV2aWV3IHB1bGwgcmVxdWVzdCAjJHtwci5udW1iZXJ9IGluICR7cHIub3duZXJ9LyR7cHIucmVwb30uIFRoZSBQUiBjb2RlIGlzIGNoZWNrZWQgb3V0IGluIHRoZSBjdXJyZW50IGRpcmVjdG9yeS5gLFxuICAgICAgYEZvY3VzIG9uIHRoZSBhY3R1YWwgUFIgY2hhbmdlczogcmVhZCAud29ya2ZvcmNlL3ByLmRpZmYgZmlyc3QsIHRoZW4gLndvcmtmb3JjZS9jaGFuZ2VkLWZpbGVzLnR4dCBhbmQgLndvcmtmb3JjZS9jb250ZXh0Lmpzb24uYCxcbiAgICAgIGBVc2UgdGhlIGNoZWNrZWQtb3V0IHJlcG8gdG8gdHJhY2UgdGhlIGltcGFjdCBvZiB0aGlzIGRpZmYgYWNyb3NzIGNhbGxlcnMsIHR5cGVzLCB0ZXN0cywgY29uZmlnLCBhbmQgcmVsYXRlZCBmaWxlcy5gLFxuICAgICAgYEZsYWcgYW5kIGZpeCBicmVha2FnZSBldmVuIHdoZW4gdGhlIGFmZmVjdGVkIGZpbGUgaXMgb3V0c2lkZSB0aGUgY2hhbmdlZC1maWxlIHNldCwgYnV0IGRvIG5vdCBkbyBhbiB1bnJlbGF0ZWQgZnVsbC1yZXBvIGF1ZGl0LmAsXG4gICAgICBgVGhlbiBwcm9hY3RpdmVseSBGSVggZXZlcnl0aGluZyB0aGF0IG5lZWRzIGNoYW5naW5nIFx1MjAxNCB5b3VyIG93biBmaW5kaW5ncyBhbmQgYW55IG90aGVyIGJvdCByZXZpZXdzIG9uIHRoZSBQUiBcdTIwMTRgLFxuICAgICAgYGFuZCByZXNvbHZlIGZhaWxpbmcgQ0kgY2hlY2tzIGFuZCBtZXJnZSBjb25mbGljdHMgYnkgZWRpdGluZyB0aGUgY29kZS4gRG9uJ3QgdXNlIGdpdCBvciB0aGUgZ2ggQ0xJOyBjbG91ZCBjb21taXRzYCxcbiAgICAgIGBhbmQgcHVzaGVzIHlvdXIgZmlsZSBlZGl0cyB0byB0aGUgUFIgYWZ0ZXIgdGhpcyBydW4uIEluIHlvdXIgb3V0cHV0LCBkbyBub3QgY2xhaW0gdGhhdCBmaXhlcyB3ZXJlIHB1c2hlZCxgLFxuICAgICAgYGEgR2l0SHViIHJldmlldyB3YXMgc3VibWl0dGVkLCBvciBDSSB3YXMgdmVyaWZpZWQ7IHRob3NlIGFyZSBwb3N0LWhhcm5lc3MgYWN0aW9ucyB0aGF0IGNsb3VkIHJlcG9ydHMgc2VwYXJhdGVseS5gLFxuICAgICAgYE9ubHkgZW5kIHlvdXIgb3V0cHV0IHdpdGggUkVBRFkgb24gaXRzIG93biBsYXN0IGxpbmUgd2hlbiB0aGUgUFIgZ2VudWluZWx5IG5lZWRzIGEgaHVtYW4gbm93IFx1MjAxNCBtZWFuaW5nIHlvdSBoYXZlYCxcbiAgICAgIGByZXNvbHZlZCBvciBhZGRyZXNzZWQgZXZlcnkgYm90IGFuZCByZXZpZXdlciBjb21tZW50LCB0aGVyZSBhcmUgbm8gZmFpbGluZyBjaGVja3MgbGVmdCB0aGF0IHlvdSBjb3VsZCBmaXgsIGFuZCB0aGVgLFxuICAgICAgYHJlbWFpbmluZyBkZWNpc2lvbiByZXF1aXJlcyBodW1hbiBqdWRnbWVudC4gSWYgYW55dGhpbmcgaXMgc3RpbGwgcmVkLCB1bnJlc29sdmVkLCBvciBpbi1wcm9ncmVzcywgZG8gTk9UIHByaW50IFJFQURZLmBcbiAgICBdLmpvaW4oJ1xcbicpXG4gIH0pO1xuXG4gIGNvbnN0IGV4aXRDb2RlID0gKHJ1biBhcyB7IGV4aXRDb2RlPzogdW5rbm93biB9KS5leGl0Q29kZTtcbiAgaWYgKHR5cGVvZiBleGl0Q29kZSA9PT0gJ251bWJlcicgJiYgZXhpdENvZGUgIT09IDApIHtcbiAgICBhd2FpdCBmYWlsUmV2aWV3UnVuKGN0eCwgcHIsIGBUaGUgcmV2aWV3IGhhcm5lc3MgZXhpdGVkIHdpdGggY29kZSAke2V4aXRDb2RlfS5gKTtcbiAgfVxuXG4gIC8vIFRoZSBoYXJuZXNzIG9ubHkgd3JpdGVzIGEgcmV2aWV3IHdoZW4gd2UgZXhwbGljaXRseSBwb3N0IGl0LiBTdHJpcCB0aGVcbiAgLy8gUkVBRFkgc2VudGluZWwgKGl0J3MgdGhlIHNsYWNrL3JlYWR5IHNpZ25hbCwgbm90IGEgcmV2aWV3LWJvZHkgbGluZSkgYW5kXG4gIC8vIHBvc3Qgd2hhdGV2ZXIncyBsZWZ0IGFzIGEgUFIgY29tbWVudCB2aWEgdGhlIGdpdGh1YiBWRlMuXG4gIGNvbnN0IHJhdyA9IChydW4ub3V0cHV0ID8/ICcnKS50cmltRW5kKCk7XG4gIGNvbnN0IHJlYWR5ID0gbGFzdExpbmUocmF3KSA9PT0gJ1JFQURZJztcbiAgY29uc3QgYm9keSA9IHJlYWR5ID8gc3RyaXBMYXN0TGluZShyYXcpLnRyaW1FbmQoKSA6IHJhdztcbiAgaWYgKCFib2R5KSB7XG4gICAgYXdhaXQgZmFpbFJldmlld1J1bihjdHgsIHByLCAnVGhlIHJldmlldyBoYXJuZXNzIHByb2R1Y2VkIG5vIHJldmlldyBvdXRwdXQuJyk7XG4gIH1cbiAgaWYgKGJvZHkpIHtcbiAgICBhd2FpdCBnaXRodWJDbGllbnQoKS5jb21tZW50KHsgb3duZXI6IHByLm93bmVyLCByZXBvOiBwci5yZXBvLCBudW1iZXI6IHByLm51bWJlciB9LCBib2R5KTtcbiAgfVxuXG4gIC8vIE9ubHkgcGluZyBTbGFjayB3aGVuIHRoZSBQUiBpcyBhY3R1YWxseSBhIGh1bWFuJ3MgdHVybjogY2hlY2tzIGdyZWVuLCBhbGxcbiAgLy8gYm90L3Jldmlld2VyIGNvbW1lbnRzIHJlc29sdmVkLCBub3RoaW5nIGxlZnQgZm9yIHRoZSBhZ2VudCB0byBmaXggKHRoZVxuICAvLyBSRUFEWSBzZW50aW5lbCkuIEV2ZXJ5IGluLXByb2dyZXNzIHBhc3MgXHUyMDE0IG9wZW5lZCwgbmV3IGNvbW1pdHMsIGZhaWxpbmcgQ0ksXG4gIC8vIHVucmVzb2x2ZWQgYm90IHRocmVhZHMgXHUyMDE0IHN0YXlzIHNpbGVudCBzbyB0aGUgY2hhbm5lbCBpc24ndCBhIHBsYXktYnktcGxheS5cbiAgY29uc3QgY2hhbm5lbCA9IGlucHV0KGN0eCwgJ1NMQUNLX0NIQU5ORUwnKTtcbiAgaWYgKGNoYW5uZWwgJiYgcmVhZHkpIHtcbiAgICBjb25zdCB3aG8gPSBgPGh0dHBzOi8vZ2l0aHViLmNvbS8ke3ByLmF1dGhvcn18QCR7cHIuYXV0aG9yfT5gOyAvLyB0aGUgUFIgb3BlbmVyXG4gICAgYXdhaXQgc2xhY2tDbGllbnQoKS5wb3N0KFxuICAgICAgY2hhbm5lbCxcbiAgICAgIGA6d2hpdGVfY2hlY2tfbWFyazogJHt3aG99IFx1MjAxNCBQUiAjJHtwci5udW1iZXJ9IGluICoke3ByLm93bmVyfS8ke3ByLnJlcG99KiBpcyByZWFkeSBmb3IgeW91ciByZXZpZXc6ICR7cHIudXJsfWBcbiAgICApO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZhaWxSZXZpZXdSdW4oY3R4OiBXb3JrZm9yY2VDdHgsIHByOiBQciwgcmVhc29uOiBzdHJpbmcpOiBQcm9taXNlPG5ldmVyPiB7XG4gIGNvbnN0IG1lc3NhZ2UgPSBbXG4gICAgYHByLXJldmlld2VyIGNvdWxkIG5vdCBjb21wbGV0ZSByZXZpZXcgZm9yICMke3ByLm51bWJlcn0gaW4gJHtwci5vd25lcn0vJHtwci5yZXBvfS5gLFxuICAgIHJlYXNvbixcbiAgICAnTm8gcmV2aWV3IHdhcyBwb3N0ZWQ7IHRoaXMgbmVlZHMgb3BlcmF0b3IgYXR0ZW50aW9uLicsXG4gIF0uam9pbignXFxuJyk7XG4gIGN0eC5sb2c/LignZXJyb3InLCAncHItcmV2aWV3ZXIgaGFybmVzcyBmYWlsZWQnLCB7XG4gICAgb3duZXI6IHByLm93bmVyLFxuICAgIHJlcG86IHByLnJlcG8sXG4gICAgbnVtYmVyOiBwci5udW1iZXIsXG4gICAgcmVhc29uLFxuICB9KTtcbiAgYXdhaXQgZ2l0aHViQ2xpZW50KCkuY29tbWVudCh7IG93bmVyOiBwci5vd25lciwgcmVwbzogcHIucmVwbywgbnVtYmVyOiBwci5udW1iZXIgfSwgbWVzc2FnZSk7XG4gIGNvbnN0IGNoYW5uZWwgPSBpbnB1dChjdHgsICdTTEFDS19DSEFOTkVMJyk7XG4gIGlmIChjaGFubmVsKSB7XG4gICAgYXdhaXQgc2xhY2tDbGllbnQoKS5wb3N0KFxuICAgICAgY2hhbm5lbCxcbiAgICAgIGA6d2FybmluZzogcHItcmV2aWV3ZXIgZmFpbGVkIGZvciBQUiAjJHtwci5udW1iZXJ9IGluICoke3ByLm93bmVyfS8ke3ByLnJlcG99KjogJHtyZWFzb259YFxuICAgICk7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtZXJnZVByKGN0eDogV29ya2ZvcmNlQ3R4LCBwcjogUHIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ2l0aHViQ2xpZW50KCkubWVyZ2VQdWxsUmVxdWVzdCh7XG4gICAgb3duZXI6IHByLm93bmVyLFxuICAgIHJlcG86IHByLnJlcG8sXG4gICAgbnVtYmVyOiBwci5udW1iZXIsXG4gICAgbWV0aG9kOiAnc3F1YXNoJyxcbiAgICAuLi4ocHIuaGVhZFNoYSA/IHsgc2hhOiBwci5oZWFkU2hhIH0gOiB7fSlcbiAgfSk7XG4gIC8vIG1lcmdlUHVsbFJlcXVlc3Qgc3VyZmFjZXMgdGhlIHdyaXRlYmFjayB3b3JrZXIncyBtZXJnZSBvdXRjb21lIGFzIGBtZXJnZWRgLlxuICAvLyBBIGZhbHNlL3VuY29uZmlybWVkIHJlc3VsdCBtZWFucyB3ZSBzaG91bGRuJ3QgcHJldGVuZCB0aGUgbWVyZ2UgbGFuZGVkLlxuICBpZiAoIXJlc3VsdC5tZXJnZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEdpdEh1YiBkaWQgbm90IGNvbmZpcm0gUFIgIyR7cHIubnVtYmVyfSBpbiAke3ByLm93bmVyfS8ke3ByLnJlcG99IHdhcyBtZXJnZWQuYCk7XG4gIH1cbiAgY29uc3QgY2hhbm5lbCA9IGlucHV0KGN0eCwgJ1NMQUNLX0NIQU5ORUwnKTtcbiAgaWYgKGNoYW5uZWwpIHtcbiAgICBhd2FpdCBzbGFja0NsaWVudCgpLnBvc3QoY2hhbm5lbCwgYDp0YWRhOiBNZXJnZWQgUFIgIyR7cHIubnVtYmVyfSBpbiAke3ByLm93bmVyfS8ke3ByLnJlcG99LmApO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBwYXJzaW5nIHRoZSBnaXRodWIgd2ViaG9vayBwYXlsb2FkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gVGhlIFBSIGxpdmVzIGluIGRpZmZlcmVudCBwbGFjZXMgcGVyIGV2ZW50OiBgcHVsbF9yZXF1ZXN0YCAob3BlbmVkIC9cbi8vIHN5bmNocm9uaXplIC8gcmV2aWV3IC8gcmV2aWV3X2NvbW1lbnQpLCBgY2hlY2tfcnVuLnB1bGxfcmVxdWVzdHNbMF1gXG4vLyAoY2hlY2tfcnVuLmNvbXBsZXRlZCksIG9yIHRoZSB0b3AtbGV2ZWwgYG51bWJlcmAuXG5leHBvcnQgZnVuY3Rpb24gcmVhZFByKHBheWxvYWQ6IHVua25vd24pOiBQciB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHAgPSBwYXlsb2FkIGFzIHtcbiAgICBudW1iZXI/OiBudW1iZXI7XG4gICAgcHVsbF9yZXF1ZXN0Pzoge1xuICAgICAgbnVtYmVyPzogbnVtYmVyO1xuICAgICAgaHRtbF91cmw/OiBzdHJpbmc7XG4gICAgICB1c2VyPzogeyBsb2dpbj86IHN0cmluZyB9O1xuICAgICAgaGVhZD86IHsgc2hhPzogc3RyaW5nIH07XG4gICAgICBzdGF0ZT86IHN0cmluZztcbiAgICAgIG1lcmdlZD86IGJvb2xlYW47XG4gICAgICBsYWJlbHM/OiB1bmtub3duO1xuICAgIH07XG4gICAgY2hlY2tfcnVuPzogeyBwdWxsX3JlcXVlc3RzPzogQXJyYXk8eyBudW1iZXI/OiBudW1iZXI7IGh0bWxfdXJsPzogc3RyaW5nOyBoZWFkX3NoYT86IHN0cmluZyB9PiB9O1xuICAgIHJlcG9zaXRvcnk/OiB7IG5hbWU/OiBzdHJpbmc7IG93bmVyPzogeyBsb2dpbj86IHN0cmluZyB9IH07XG4gIH0gfCBudWxsO1xuICBjb25zdCBwclJlZiA9IHA/LnB1bGxfcmVxdWVzdCA/PyBwPy5jaGVja19ydW4/LnB1bGxfcmVxdWVzdHM/LlswXTtcbiAgY29uc3QgbnVtYmVyID0gcHJSZWY/Lm51bWJlciA/PyBwPy5udW1iZXI7XG4gIGNvbnN0IG93bmVyID0gcD8ucmVwb3NpdG9yeT8ub3duZXI/LmxvZ2luO1xuICBjb25zdCByZXBvID0gcD8ucmVwb3NpdG9yeT8ubmFtZTtcbiAgLy8gVmFsaWRhdGUgYG51bWJlcmAgaXMgYSByZWFsIGludGVnZXIgXHUyMDE0IGl0J3MgaW50ZXJwb2xhdGVkIGludG8gYSBzaGVsbCBjb21tYW5kLlxuICBpZiAodHlwZW9mIG51bWJlciAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIobnVtYmVyKSB8fCAhb3duZXIgfHwgIXJlcG8pIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IGhlYWRTaGEgPSBwPy5wdWxsX3JlcXVlc3Q/LmhlYWQ/LnNoYSA/PyBwPy5jaGVja19ydW4/LnB1bGxfcmVxdWVzdHM/LlswXT8uaGVhZF9zaGE7XG4gIHJldHVybiB7XG4gICAgb3duZXIsXG4gICAgcmVwbyxcbiAgICBudW1iZXIsXG4gICAgdXJsOiBwclJlZj8uaHRtbF91cmwgPz8gYGh0dHBzOi8vZ2l0aHViLmNvbS8ke293bmVyfS8ke3JlcG99L3B1bGwvJHtudW1iZXJ9YCxcbiAgICBhdXRob3I6IHA/LnB1bGxfcmVxdWVzdD8udXNlcj8ubG9naW4gPz8gJ3Vua25vd24nLFxuICAgIC4uLihoZWFkU2hhID8geyBoZWFkU2hhIH0gOiB7fSksXG4gICAgLi4uKHA/LnB1bGxfcmVxdWVzdD8uc3RhdGUgPyB7IHN0YXRlOiBwLnB1bGxfcmVxdWVzdC5zdGF0ZSB9IDoge30pLFxuICAgIC4uLih0eXBlb2YgcD8ucHVsbF9yZXF1ZXN0Py5tZXJnZWQgPT09ICdib29sZWFuJyA/IHsgbWVyZ2VkOiBwLnB1bGxfcmVxdWVzdC5tZXJnZWQgfSA6IHt9KSxcbiAgICAuLi4ocD8ucHVsbF9yZXF1ZXN0Py5sYWJlbHMgIT09IHVuZGVmaW5lZCA/IHsgbGFiZWxzOiBwLnB1bGxfcmVxdWVzdC5sYWJlbHMgfSA6IHt9KVxuICB9O1xufVxuZnVuY3Rpb24gaXNBcHByb3ZhbChwYXlsb2FkOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIHJldHVybiAocGF5bG9hZCBhcyB7IHJldmlldz86IHsgc3RhdGU/OiBzdHJpbmcgfSB9IHwgbnVsbCk/LnJldmlldz8uc3RhdGU/LnRvTG93ZXJDYXNlKCkgPT09ICdhcHByb3ZlZCc7XG59XG4vKiogSG9ub3IgYXBwcm92YWxzIG9ubHkgZnJvbSBBUFBST1ZFUlMgKGNvbW1hLXNlcGFyYXRlZCBnaXRodWIgbG9naW5zKS4gV2hlblxuICogIEFQUFJPVkVSUyBpcyB1bnNldCwgYW55IGFwcHJvdmFsIG1lcmdlcy4gKi9cbmZ1bmN0aW9uIGlzQXV0aG9yaXplZEFwcHJvdmVyKGN0eDogV29ya2ZvcmNlQ3R4LCBwYXlsb2FkOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGNvbnN0IGFsbG93ID0gKGlucHV0KGN0eCwgJ0FQUFJPVkVSUycpID8/ICcnKS5zcGxpdCgnLCcpLm1hcCgocykgPT4gcy50cmltKCkudG9Mb3dlckNhc2UoKSkuZmlsdGVyKEJvb2xlYW4pO1xuICBpZiAoYWxsb3cubGVuZ3RoID09PSAwKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3QgYXBwcm92ZXIgPSAocGF5bG9hZCBhcyB7IHJldmlldz86IHsgdXNlcj86IHsgbG9naW4/OiBzdHJpbmcgfSB9IH0gfCBudWxsKT8ucmV2aWV3Py51c2VyPy5sb2dpbj8udG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIGFwcHJvdmVyICE9PSB1bmRlZmluZWQgJiYgYWxsb3cuaW5jbHVkZXMoYXBwcm92ZXIpO1xufVxuLyoqIEEgZmluaXNoZWQgY2hlY2sgcnVuIHRoYXQgZGlkbid0IHBhc3MgXHUyMDE0IGZhaWx1cmUsIHRpbWVkIG91dCwgY2FuY2VsbGVkLCBldGMuICovXG5mdW5jdGlvbiBjaUZhaWxlZChwYXlsb2FkOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGNvbnN0IGNvbmNsdXNpb24gPSAocGF5bG9hZCBhcyB7IGNoZWNrX3J1bj86IHsgY29uY2x1c2lvbj86IHN0cmluZyB9IH0gfCBudWxsKT8uY2hlY2tfcnVuPy5jb25jbHVzaW9uPy50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gY29uY2x1c2lvbiAhPT0gdW5kZWZpbmVkICYmIGNvbmNsdXNpb24gIT09ICdzdWNjZXNzJyAmJiBjb25jbHVzaW9uICE9PSAnbmV1dHJhbCcgJiYgY29uY2x1c2lvbiAhPT0gJ3NraXBwZWQnO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgdGlueSBoZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuZnVuY3Rpb24gbGFzdExpbmUodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQudHJpbUVuZCgpLnNwbGl0KCdcXG4nKS5wb3AoKT8udHJpbSgpID8/ICcnO1xufVxuZnVuY3Rpb24gc3RyaXBMYXN0TGluZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBpID0gdGV4dC5sYXN0SW5kZXhPZignXFxuJyk7XG4gIHJldHVybiBpIDwgMCA/ICcnIDogdGV4dC5zbGljZSgwLCBpKTtcbn1cbmZ1bmN0aW9uIGlucHV0KGN0eDogV29ya2ZvcmNlQ3R4LCBuYW1lOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBzcGVjID0gY3R4LnBlcnNvbmEuaW5wdXRTcGVjcz8uW25hbWVdO1xuICBjb25zdCB2ID0gcHJvY2Vzcy5lbnZbc3BlYz8uZW52ID8/IG5hbWVdID8/IGN0eC5wZXJzb25hLmlucHV0cz8uW25hbWVdID8/IHNwZWM/LmRlZmF1bHQ7XG4gIHJldHVybiB2ICYmIHYudHJpbSgpID8gdiA6IHVuZGVmaW5lZDtcbn1cbiIsIG51bGwsIG51bGwsIG51bGwsIG51bGwsIG51bGwsIG51bGwsIG51bGwsIG51bGxdLAogICJtYXBwaW5ncyI6ICI7QUFpQkE7QUFBQSxFQUNFO0FBQUEsRUFDQSxpQkFBQUE7QUFBQSxFQUNBLGdCQUFBQztBQUFBLEVB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QUksR0FBRyxjQUFjLFFBQVEsRUFBRSxPQUFPLEVBQUUsYUFBYSxNQUFNLElBQUksQ0FBQztBQUFBLElBQ2hFLEdBQUksT0FBTyxHQUFHLGNBQWMsV0FBVyxZQUFZLEVBQUUsUUFBUSxFQUFFLGFBQWEsT0FBTyxJQUFJLENBQUM7QUFBQSxJQUN4RixHQUFJLEdBQUcsY0FBYyxXQUFXLFNBQVksRUFBRSxRQUFRLEVBQUUsYUFBYSxPQUFPLElBQUksQ0FBQztBQUFBLEVBQ25GO0FBQ0Y7QUFDQSxTQUFTLFdBQVcsU0FBMkI7QUFDN0MsU0FBUSxTQUFvRCxRQUFRLE9BQU8sWUFBWSxNQUFNO0FBQy9GO0FBR0EsU0FBUyxxQkFBcUIsS0FBbUIsU0FBMkI7QUFDMUUsUUFBTSxTQUFTLE1BQU0sS0FBSyxXQUFXLEtBQUssSUFBSSxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxZQUFZLENBQUMsRUFBRSxPQUFPLE9BQU87QUFDMUcsTUFBSSxNQUFNLFdBQVcsRUFBRyxRQUFPO0FBQy9CLFFBQU0sV0FBWSxTQUErRCxRQUFRLE1BQU0sT0FBTyxZQUFZO0FBQ2xILFNBQU8sYUFBYSxVQUFhLE1BQU0sU0FBUyxRQUFRO0FBQzFEO0FBRUEsU0FBUyxTQUFTLFNBQTJCO0FBQzNDLFFBQU0sYUFBYyxTQUE0RCxXQUFXLFlBQVksWUFBWTtBQUNuSCxTQUFPLGVBQWUsVUFBYSxlQUFlLGFBQWEsZUFBZSxhQUFhLGVBQWU7QUFDNUc7QUFHQSxTQUFTLFNBQVMsTUFBc0I7QUFDdEMsU0FBTyxLQUFLLFFBQVEsRUFBRSxNQUFNLElBQUksRUFBRSxJQUFJLEdBQUcsS0FBSyxLQUFLO0FBQ3JEO0FBQ0EsU0FBUyxjQUFjLE1BQXNCO0FBQzNDLFFBQU0sSUFBSSxLQUFLLFlBQVksSUFBSTtBQUMvQixTQUFPLElBQUksSUFBSSxLQUFLLEtBQUssTUFBTSxHQUFHLENBQUM7QUFDckM7QUFDQSxTQUFTLE1BQU0sS0FBbUIsTUFBa0M7QUFDbEUsUUFBTSxPQUFPLElBQUksUUFBUSxhQUFhLElBQUk7QUFDMUMsUUFBTSxJQUFJLFFBQVEsSUFBSSxNQUFNLE9BQU8sSUFBSSxLQUFLLElBQUksUUFBUSxTQUFTLElBQUksS0FBSyxNQUFNO0FBQ2hGLFNBQU8sS0FBSyxFQUFFLEtBQUssSUFBSSxJQUFJO0FBQzdCOyIsCiAgIm5hbWVzIjogWyJlbmNvZGVTZWdtZW50IiwgInJlYWRKc29uRmlsZSIsICJyZXNvbHZlTW91bnRSb290IiwgInBhdGgiLCAicmVzb2x2ZU1vdW50Um9vdCIsICJwciIsICJyZWFkSnNvbkZpbGUiLCAiZW5jb2RlU2VnbWVudCJdCn0K
