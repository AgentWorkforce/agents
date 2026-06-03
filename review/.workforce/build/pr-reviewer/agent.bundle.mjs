// ../agents/node_modules/@agentworkforce/runtime/dist/handler.js
function handler(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("handler() expects a function");
  }
  Object.defineProperty(fn, "__workforceHandler", {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false
  });
  return fn;
}

// ../agents/node_modules/@agentworkforce/runtime/dist/define-agent.js
function defineAgent(input2) {
  if (!input2 || typeof input2 !== "object") {
    throw new TypeError("defineAgent() expects an object");
  }
  if (typeof input2.handler !== "function") {
    throw new TypeError("defineAgent({ handler }) \u2014 handler must be a function");
  }
  const agent = {
    ...input2.triggers ? { triggers: input2.triggers } : {},
    ...input2.schedules ? { schedules: input2.schedules } : {},
    ...input2.watch ? { watch: input2.watch } : {},
    handler: handler(input2.handler)
  };
  Object.defineProperty(agent, "__workforceAgent", {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false
  });
  return agent;
}

// ../agents/node_modules/@agentworkforce/runtime/dist/clients/request.js
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// ../agents/node_modules/@agentworkforce/runtime/dist/errors.js
var WorkforceIntegrationError = class extends Error {
  provider;
  operation;
  cause;
  retryable;
  constructor(options) {
    super(`${options.provider}.${options.operation} failed${options.cause instanceof Error ? `: ${options.cause.message}` : ""}`);
    this.name = "WorkforceIntegrationError";
    this.provider = options.provider;
    this.operation = options.operation;
    if (options.cause !== void 0)
      this.cause = options.cause;
    this.retryable = options.retryable ?? false;
  }
};

// ../agents/node_modules/@agentworkforce/runtime/dist/clients/request.js
function encodeSegment(value) {
  return encodeURIComponent(String(value));
}
function resolveMountRoot(client) {
  return path.resolve(client.relayfileMountRoot ?? client.relayfileRoot ?? client.mountRoot ?? process.env.RELAYFILE_MOUNT_ROOT ?? process.env.RELAYFILE_ROOT ?? client.workspaceCwd ?? process.cwd());
}
function toAbsolutePath(client, relayPath) {
  const root = resolveMountRoot(client);
  const normalized = relayPath.startsWith("/") ? relayPath.slice(1) : relayPath;
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Relayfile path escapes mount root: ${relayPath}`);
  }
  return absolute;
}
async function readJsonFile(client, provider, operation, relayPath) {
  try {
    const absolutePath = toAbsolutePath(client, relayPath);
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (cause) {
    throw new WorkforceIntegrationError({ provider, operation, cause, retryable: false });
  }
}

// ../agents/node_modules/@relayfile/adapter-core/dist/src/vfs-client/index.js
import { randomUUID } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, readdir as readdir2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import path2 from "node:path";
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
function draftFile2(prefix) {
  return `${prefix} ${randomUUID()}.json`;
}
function resolveMountRoot2(client) {
  return path2.resolve(client.relayfileMountRoot ?? client.relayfileRoot ?? client.mountRoot ?? process.env.RELAYFILE_MOUNT_ROOT ?? process.env.RELAYFILE_ROOT ?? client.workspaceCwd ?? process.cwd());
}
function toAbsolutePath2(client, relayPath) {
  const root = resolveMountRoot2(client);
  const normalized = relayPath.startsWith("/") ? relayPath.slice(1) : relayPath;
  const absolute = path2.resolve(root, normalized);
  const relative = path2.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path2.sep}`) || path2.isAbsolute(relative)) {
    throw new Error(`Relayfile path escapes mount root: ${relayPath}`);
  }
  return absolute;
}
async function readJsonFile2(client, provider, operation, relayPath) {
  try {
    const absolutePath = toAbsolutePath2(client, relayPath);
    return JSON.parse(await readFile2(absolutePath, "utf8"));
  } catch (cause) {
    throw new RelayfileWritebackError({ provider, operation, cause, retryable: false });
  }
}
async function listJsonFiles2(client, provider, operation, relayDir) {
  try {
    const absoluteDir = toAbsolutePath2(client, relayDir);
    const entries = await readdirIfPresent(absoluteDir);
    const out = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json"))
        continue;
      const relayPath = `${relayDir.replace(/\/+$/, "")}/${entry}`;
      const value = JSON.parse(await readFile2(path2.join(absoluteDir, entry), "utf8"));
      out.push({ path: relayPath, value });
    }
    return out;
  } catch (cause) {
    throw new RelayfileWritebackError({ provider, operation, cause, retryable: false });
  }
}
async function readdirIfPresent(absoluteDir) {
  try {
    return await readdir2(absoluteDir);
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
async function writeJsonFile2(client, provider, operation, relayPath, body) {
  try {
    const absolutePath = toAbsolutePath2(client, relayPath);
    await mkdir2(path2.dirname(absolutePath), { recursive: true });
    const tempPath = `${absolutePath}.tmp-${randomUUID()}`;
    await writeFile2(tempPath, `${JSON.stringify(body, null, 2)}
`, "utf8");
    await rename2(tempPath, absolutePath);
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
    return JSON.parse(await readFile2(absolutePath, "utf8"));
  } catch {
    return void 0;
  }
}

// ../agents/node_modules/@relayfile/adapter-core/dist/src/writeback-paths/catalog.generated.js
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

// ../agents/node_modules/@relayfile/adapter-core/dist/src/writeback-paths/resolver.js
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

// ../agents/node_modules/@relayfile/relay-helpers/dist/generic.js
function isItemPath(path3) {
  return path3.endsWith(".json");
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
      const target = isItemPath(base) ? base : `${base}/${draftFile2(String(resource))}`;
      return writeJsonFile2(opts, provider, `write.${String(resource)}`, target, body);
    },
    async read(resource, params = {}) {
      const path3 = writebackPath(provider, resource, params);
      if (!isItemPath(path3)) {
        throw new Error(`read("${String(resource)}") resolves to collection "${path3}"; read a specific item path or use list(). Known resources for ${provider}: ${knownResources()}`);
      }
      return readJsonFile2(opts, provider, `read.${String(resource)}`, path3);
    },
    async list(resource, params = {}) {
      const path3 = writebackPath(provider, resource, params);
      if (isItemPath(path3)) {
        throw new Error(`list("${String(resource)}") resolves to item "${path3}"; use read() instead. Known resources for ${provider}: ${knownResources()}`);
      }
      const files = await listJsonFiles2(opts, provider, `list.${String(resource)}`, path3);
      return files.map((file) => file.value);
    }
  };
}

// ../agents/node_modules/@relayfile/relay-helpers/dist/provider-client.js
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

// ../agents/node_modules/@relayfile/relay-helpers/dist/receipt.js
function created(result) {
  return {
    id: result.receipt?.created ?? result.receipt?.id ?? result.path,
    url: result.receipt?.url ?? result.path
  };
}

// ../agents/node_modules/@relayfile/relay-helpers/dist/github.js
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

// ../agents/node_modules/@relayfile/relay-helpers/dist/slack.js
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
  return { relayfileMountRoot: resolveMountRoot({}) };
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
    return await readJsonFile(
      vfsClient(),
      "github",
      "getPr",
      `/github/repos/${encodeSegment(pr.owner)}/${encodeSegment(pr.repo)}/pulls/${pr.number}/meta.json`
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
    return { reason: "REVIEW_AUTHORS is set but the PR author could not be resolved", notify: true };
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
    author: p?.pull_request?.user?.login ?? (p?.pull_request ? p?.sender?.login : void 0) ?? "unknown",
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
