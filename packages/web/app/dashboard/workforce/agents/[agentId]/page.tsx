"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarClock,
  ChevronRight,
  Clock,
  Copy,
  FileJson,
  Search,
  Terminal,
  Zap,
} from "lucide-react";
import { toAppPath } from "@/lib/app-path";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "@/app/components/ProviderLogo";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/app/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/app/components/ui/table";
import {
  formatRelative,
  formatTimestamp,
  formatAgentInputValue,
  getAgentInputEntries,
  type DeployedAgent,
  type DeploymentFire,
  type DeploymentFireDetail,
  type DeploymentLogEntry,
  useDashboard,
} from "../../../_components/dashboard-data";
import { AgentCardThumbnail } from "../../../_components/agent-card-thumbnail";
import { formatNextFireRelative, getNextAgentFire } from "./schedule-next-fire";

function getDeploymentAgentBadgeVariant(status: string) {
  const normalized = status.toLowerCase();

  if (["ready", "active", "running", "connected", "authenticated"].includes(normalized)) {
    return "success" as const;
  }

  if (["deploying", "starting", "pending", "queued", "authorizing"].includes(normalized)) {
    return "info" as const;
  }

  if (["paused", "stopped", "inactive"].includes(normalized)) {
    return "warning" as const;
  }

  if (["failed", "error", "revoked", "expired", "destroyed"].includes(normalized)) {
    return "danger" as const;
  }

  return "default" as const;
}

function getFireBadgeVariant(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "succeeded" || normalized === "success") return "success" as const;
  if (normalized === "running" || normalized === "starting") return "info" as const;
  if (normalized === "failed" || normalized === "error") return "danger" as const;
  return "default" as const;
}

function getDeploymentLastActivity(agent: DeployedAgent) {
  return agent.lastCompletedAt ?? agent.lastFiredAt ?? agent.lastUsedAt ?? agent.createdAt;
}

function formatDuration(durationMs: number | null | undefined) {
  if (!durationMs || durationMs < 0) return "0 ms";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function formatTokenCount(value: number | null | undefined) {
  if (!value || value < 0) return "0";
  if (value < 1_000_000) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function levelBadgeVariant(level: string) {
  const normalized = level.toLowerCase();
  if (normalized === "error") return "danger" as const;
  if (normalized === "warn" || normalized === "warning") return "warning" as const;
  if (normalized === "info" || normalized === "success") return "info" as const;
  return "default" as const;
}

function triggerFromEventSource(eventSource: string) {
  const [source] = eventSource.split(":");
  return source?.trim() || "unknown";
}

function providerFromEventSource(eventSource: string) {
  const source = triggerFromEventSource(eventSource).toLowerCase();
  if (source === "cron" || source === "schedule") return "system";
  return source;
}

function fullTimestamp(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

function entryStatus(entry: DeploymentLogEntry) {
  const status = entry.payload.status;
  if (typeof status === "string" && status.trim()) return status.trim();
  if (entry.level.toLowerCase() === "error") return "failed";
  if (entry.level.toLowerCase() === "warn") return "warning";
  return "success";
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function optionValues(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

async function fetchDashboardJson<T>(url: string, fallbackMessage: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "include",
    ...init,
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? fallbackMessage);
  }
  if (!payload) {
    throw new Error(fallbackMessage);
  }
  return payload as T;
}

type PickerOption = {
  value: string;
  label: string;
  hint?: string;
};

type ResolvedInputValue = {
  label: string;
  hint?: string;
  rawValue: string;
};

function isPickerOption(value: unknown): value is PickerOption {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.value === "string" && typeof record.label === "string";
}

async function fetchPickerOptions(input: {
  workspaceId: string;
  provider: string;
  resource: string;
}): Promise<PickerOption[]> {
  const response = await fetch(
    toAppPath(
      `/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/${encodeURIComponent(input.provider)}/resources/${encodeURIComponent(input.resource)}`,
    ),
    {
      cache: "no-store",
      credentials: "include",
    },
  );
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; options?: unknown[] } | null;
  if (!response.ok || payload?.ok !== true) {
    return [];
  }
  return Array.isArray(payload.options) ? payload.options.filter(isPickerOption) : [];
}

function StatPill({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-[8.5rem] flex-1 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-base font-semibold text-foreground">{value}</p>
      {note ? <p className="mt-1 truncate text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function TimelineField({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-sm font-medium text-foreground">{value}</p>
      {note ? <p className="mt-1 truncate text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function AgentInputsCard({ agent, workspaceId }: { agent: DeployedAgent | null; workspaceId: string | null }) {
  const entries = getAgentInputEntries(agent?.inputValues);
  const [resolvedValues, setResolvedValues] = useState<Record<string, ResolvedInputValue>>({});

  useEffect(() => {
    if (!agent || !workspaceId) {
      setResolvedValues({});
      return;
    }

    const pickerEntries = getAgentInputEntries(agent.inputValues)
      .map(([key, value]) => ({
        key,
        value,
        picker: agent.inputSpecs[key]?.picker,
        formattedValue: formatAgentInputValue(key, value),
      }))
      .filter((entry) =>
        entry.picker &&
        entry.value.trim().length > 0 &&
        entry.formattedValue === entry.value,
      );

    if (pickerEntries.length === 0) {
      setResolvedValues({});
      return;
    }

    let active = true;
    const requestKeys = [
      ...new Set(
        pickerEntries.map((entry) =>
          `${entry.picker?.provider ?? ""}\u0000${entry.picker?.resource ?? ""}`,
        ),
      ),
    ];

    Promise.all(
      requestKeys.map(async (requestKey) => {
        const [provider, resource] = requestKey.split("\u0000");
        const options = await fetchPickerOptions({ workspaceId, provider, resource }).catch(() => []);
        return [requestKey, options] as const;
      }),
    ).then((pairs) => {
      if (!active) return;
      const optionsByRequest = new Map(pairs);
      const nextResolvedValues: Record<string, ResolvedInputValue> = {};
      for (const entry of pickerEntries) {
        const picker = entry.picker;
        if (!picker) continue;
        const options = optionsByRequest.get(`${picker.provider}\u0000${picker.resource}`) ?? [];
        const option = options.find((candidate) => candidate.value === entry.value);
        if (option) {
          nextResolvedValues[entry.key] = {
            label: option.label,
            hint: option.hint,
            rawValue: entry.value,
          };
        }
      }
      setResolvedValues(nextResolvedValues);
    });

    return () => {
      active = false;
    };
  }, [agent, workspaceId]);

  return (
    <Card className="rounded-[2rem] border-[var(--dashboard-border)] bg-[var(--dashboard-panel)]">
      <CardHeader>
        <CardTitle>Inputs</CardTitle>
        <CardDescription>Configured values this agent was deployed with.</CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No inputs configured.</p>
        ) : (
          <dl className="grid gap-3 md:grid-cols-2">
            {entries.map(([key, value]) => {
              const resolved = resolvedValues[key];
              const displayValue = resolved?.label ?? formatAgentInputValue(key, value);
              return (
                <div
                  key={key}
                  className="min-w-0 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-4"
                >
                  <dt className="truncate font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    {key}
                  </dt>
                  <dd className="mt-2 break-words text-sm font-medium text-foreground">
                    {displayValue}
                  </dd>
                  {resolved ? (
                    <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
                      {resolved.hint ? `${resolved.hint} · ${resolved.rawValue}` : resolved.rawValue}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="min-w-[8.5rem]">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="all">{label}: all</SelectItem>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function EntryDetailSheet({
  entry,
  onOpenChange,
}: {
  entry: DeploymentLogEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const payload = prettyJson(entry?.payload ?? {});

  useEffect(() => {
    setCopied(false);
  }, [entry?.id]);

  const copyPayload = async () => {
    await navigator.clipboard.writeText(payload);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Sheet open={entry !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            Log entry
            {entry ? <Badge variant={levelBadgeVariant(entry.level)}>{entry.level}</Badge> : null}
          </SheetTitle>
          <SheetDescription>
            {entry ? fullTimestamp(entry.timestamp) : "No entry selected."}
          </SheetDescription>
        </SheetHeader>
        {entry ? (
          <div className="flex flex-col gap-5 px-4 pb-6">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="default">{entry.source}</Badge>
              <span className="inline-flex items-center gap-1">
                <Clock aria-hidden="true" />
                {formatDuration(entry.durationMs)}
              </span>
              <span className="inline-flex items-center gap-1">
                <CalendarClock aria-hidden="true" />
                {fullTimestamp(entry.timestamp)}
              </span>
            </div>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Message</h3>
              <div className="rounded-xl border border-[var(--code-border)] bg-[var(--code-bg)] p-3 font-mono text-xs leading-5 text-foreground">
                {entry.message}
              </div>
            </section>
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Payload</h3>
                <Button variant="outline" size="sm" onClick={() => void copyPayload()}>
                  <Copy data-icon="inline-start" aria-hidden="true" />
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="max-h-[32rem] overflow-auto rounded-xl border border-[var(--code-border)] bg-[var(--code-bg)] p-4 font-mono text-xs leading-5 text-foreground">
                {payload}
              </pre>
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export default function WorkforceAgentDetailPage() {
  const params = useParams<{ agentId?: string | string[] }>();
  const agentId = Array.isArray(params.agentId) ? params.agentId[0] : params.agentId;
  const { authenticated, authSession, deploymentAgents, loadingData, sessionLoading } = useDashboard();
  const [fires, setFires] = useState<DeploymentFire[]>([]);
  const [firesRefreshKey, setFiresRefreshKey] = useState(0);
  const [triggerState, setTriggerState] = useState<"idle" | "arm" | "firing" | "fired">("idle");
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [totalTokens, setTotalTokens] = useState(0);
  const [firesLoading, setFiresLoading] = useState(false);
  const [firesError, setFiresError] = useState<string | null>(null);
  const [runSearch, setRunSearch] = useState("");
  const [runStatusFilter, setRunStatusFilter] = useState("all");
  const [runTriggerFilter, setRunTriggerFilter] = useState("all");
  const [selectedRun, setSelectedRun] = useState<DeploymentFireDetail | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<DeploymentLogEntry | null>(null);
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);
  const [runDetailError, setRunDetailError] = useState<string | null>(null);
  const [entrySearch, setEntrySearch] = useState("");
  const [entryLevelFilter, setEntryLevelFilter] = useState("all");
  const [entrySourceFilter, setEntrySourceFilter] = useState("all");
  const [showRawLogs, setShowRawLogs] = useState(false);
  const runLogPanelRef = useRef<HTMLDivElement | null>(null);

  const agent = useMemo(
    () => deploymentAgents.find((candidate) => candidate.agentId === agentId) ?? null,
    [agentId, deploymentAgents],
  );
  const agentSchedules = useMemo(() => agent?.scheduleSpecs ?? [], [agent?.scheduleSpecs]);
  const nextFire = useMemo(() => getNextAgentFire(agentSchedules), [agentSchedules]);
  const agentDescription = agent?.personaDescription?.trim() || "Granular deployment details and recent proactive fires.";

  const workspaceId = authSession?.currentWorkspace.id ?? null;

  // Manual one-off fire (operator "Trigger now"). The endpoint reuses the
  // scheduler's tick-delivery path verbatim; the run row appears in Recent
  // fires when the run completes, so we re-poll the list a few times after
  // a successful 202 instead of fabricating an optimistic row.
  const triggerNow = useCallback(async () => {
    if (!agentId || !workspaceId || triggerState === "firing") return;
    setTriggerState("firing");
    setTriggerError(null);
    try {
      await fetchDashboardJson<{ deploymentId: string }>(
        toAppPath(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments/${encodeURIComponent(agentId)}/trigger`,
        ),
        "Failed to trigger agent.",
        { method: "POST" },
      );
      setTriggerState("fired");
      for (const delayMs of [8_000, 20_000, 45_000]) {
        window.setTimeout(() => setFiresRefreshKey((key) => key + 1), delayMs);
      }
      window.setTimeout(() => setTriggerState("idle"), 45_000);
    } catch (error) {
      setTriggerError(error instanceof Error ? error.message : "Failed to trigger agent.");
      setTriggerState("idle");
    }
  }, [agentId, workspaceId, triggerState]);

  const loadRunDetail = useCallback(async (fire: DeploymentFire) => {
    setRunDetailError(null);
    setLoadingRunId(fire.id);
    try {
      const payload = await fetchDashboardJson<{ run?: DeploymentFireDetail }>(
        toAppPath(`/api/v1/agents/${encodeURIComponent(fire.agentId)}/runs/${encodeURIComponent(fire.id)}`),
        "Failed to load run logs.",
      );
      if (!payload.run) {
        throw new Error("Run logs were not found.");
      }
      setSelectedRun(payload.run);
      setShowRawLogs(false);
    } catch (error) {
      setSelectedRun(null);
      setRunDetailError(error instanceof Error ? error.message : "Failed to load run logs.");
    } finally {
      setLoadingRunId(null);
    }
  }, []);

  const focusRunLogPanel = useCallback(() => {
    window.setTimeout(() => {
      runLogPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      runLogPanelRef.current?.focus({ preventScroll: true });
    }, 0);
  }, []);

  const openRun = useCallback(async (fire: DeploymentFire) => {
    if (selectedRun?.id !== fire.id) {
      await loadRunDetail(fire);
    }
    focusRunLogPanel();
  }, [focusRunLogPanel, loadRunDetail, selectedRun?.id]);

  useEffect(() => {
    if (!agentId || !authenticated) {
      setFires([]);
      setTotalTokens(0);
      return;
    }

    let active = true;
    setFiresLoading(true);
    setFiresError(null);
    fetchDashboardJson<{ runs?: DeploymentFire[]; totalTokens?: number }>(
      toAppPath(`/api/v1/agents/${encodeURIComponent(agentId)}/runs?limit=50`),
      "Failed to load fires.",
    )
      .then((payload) => {
        if (active) {
          const nextFires = Array.isArray(payload.runs) ? payload.runs : [];
          setFires(nextFires);
          setSelectedRun((current) =>
            current && nextFires.some((fire) => fire.id === current.id) ? current : null,
          );
          setTotalTokens(
            typeof payload.totalTokens === "number" && Number.isFinite(payload.totalTokens)
              ? Number(payload.totalTokens)
              : nextFires.reduce((sum, fire) => sum + (fire.totalTokens ?? 0), 0),
          );
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setFires([]);
          setSelectedRun(null);
          setTotalTokens(0);
          setFiresError(error instanceof Error ? error.message : "Failed to load fires.");
        }
      })
      .finally(() => {
        if (active) setFiresLoading(false);
      });

    return () => {
      active = false;
    };
  }, [agentId, authenticated, firesRefreshKey]);

  useEffect(() => {
    if (selectedRun || loadingRunId || fires.length === 0) {
      return;
    }
    void loadRunDetail(fires[0]);
  }, [fires, loadRunDetail, loadingRunId, selectedRun]);

  const runStatusOptions = useMemo(() => optionValues(fires.map((fire) => fire.status)), [fires]);
  const runTriggerOptions = useMemo(
    () => optionValues(fires.map((fire) => triggerFromEventSource(fire.eventSource))),
    [fires],
  );
  const filteredFires = useMemo(() => {
    const query = runSearch.trim().toLowerCase();
    return fires.filter((fire) => {
      if (runStatusFilter !== "all" && fire.status !== runStatusFilter) return false;
      if (runTriggerFilter !== "all" && triggerFromEventSource(fire.eventSource) !== runTriggerFilter) return false;
      if (!query) return true;
      return [
        fire.status,
        fire.eventSource,
        fire.summary,
        fire.error,
        fire.sandboxName,
        fire.sandboxId,
      ].some((value) => String(value ?? "").toLowerCase().includes(query));
    });
  }, [fires, runSearch, runStatusFilter, runTriggerFilter]);

  const entries = selectedRun?.entries ?? [];
  const entryLevelOptions = useMemo(() => optionValues(entries.map((entry) => entry.level)), [entries]);
  const entrySourceOptions = useMemo(() => optionValues(entries.map((entry) => entry.source)), [entries]);
  const filteredEntries = useMemo(() => {
    const query = entrySearch.trim().toLowerCase();
    return entries.filter((entry) => {
      if (entryLevelFilter !== "all" && entry.level !== entryLevelFilter) return false;
      if (entrySourceFilter !== "all" && entry.source !== entrySourceFilter) return false;
      if (!query) return true;
      return [
        entry.level,
        entry.source,
        entry.message,
        entryStatus(entry),
        prettyJson(entry.payload),
      ].some((value) => value.toLowerCase().includes(query));
    });
  }, [entries, entryLevelFilter, entrySearch, entrySourceFilter]);

  if (sessionLoading || (authenticated && loadingData)) {
    return (
      <Card className="rounded-[2rem] border-[var(--dashboard-border)] bg-[var(--dashboard-panel)]">
        <CardHeader>
          <CardTitle>Loading agent</CardTitle>
          <CardDescription>Resolving deployment details and recent fires.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!authenticated) {
    return (
      <Card className="rounded-[2rem] border-[var(--dashboard-border)] bg-[var(--dashboard-panel)]">
        <CardHeader>
          <CardTitle>Sign in to view agent</CardTitle>
          <CardDescription>Agent details are available after signing in.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="mb-3">
            <Link href="/dashboard/workforce">
              <ArrowLeft aria-hidden="true" />
              Workforce
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <AgentCardThumbnail
              deployedName={agent?.deployedName}
              imageUrl={agent?.imageUrl}
              className="size-11"
            />
            <div className="min-w-0">
              <h1 className="truncate text-3xl font-semibold tracking-tight text-foreground">
                {agent?.deployedName ?? "Deployed agent"}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground" title={agentDescription}>
                {agentDescription}
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 lg:items-end">
          <div className="flex items-center gap-3">
            {agent && agent.scheduleIds.length > 0 && agent.status === "active" ? (
              triggerState === "arm" ? (
                <Button
                  size="sm"
                  onClick={() => void triggerNow()}
                  onBlur={() => setTriggerState((current) => (current === "arm" ? "idle" : current))}
                >
                  <Zap aria-hidden="true" />
                  Confirm fire?
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={triggerState === "firing" || triggerState === "fired"}
                  onClick={() => {
                    setTriggerError(null);
                    setTriggerState("arm");
                    window.setTimeout(
                      () => setTriggerState((current) => (current === "arm" ? "idle" : current)),
                      5_000,
                    );
                  }}
                >
                  <Zap aria-hidden="true" />
                  {triggerState === "firing"
                    ? "Triggering…"
                    : triggerState === "fired"
                      ? "Fired — run incoming"
                      : "Trigger now"}
                </Button>
              )
            ) : null}
            {agent ? <Badge variant={getDeploymentAgentBadgeVariant(agent.status)}>{agent.status}</Badge> : null}
          </div>
          {triggerError ? (
            <p className="text-xs leading-5 text-[var(--status-danger)]">{triggerError}</p>
          ) : triggerState === "fired" ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Fired. The run appears in Recent fires once it completes (~1–2 min).
            </p>
          ) : null}
        </div>
      </div>

      <Card className="rounded-[2rem] border-[var(--dashboard-border)] bg-[var(--dashboard-panel)]">
        <CardHeader>
          <CardTitle>Agent summary</CardTitle>
          <CardDescription>
            {agent ? "Runtime health and usage for this proactive persona." : "This deployment is not in the current workspace list."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-col gap-3 md:flex-row">
            <StatPill label="Runs" value={String(agent?.runCount ?? fires.length)} />
            <StatPill
              label="Last activity"
              value={agent ? formatRelative(getDeploymentLastActivity(agent)) : "No activity yet"}
              note={agent ? formatTimestamp(getDeploymentLastActivity(agent)) : undefined}
            />
            <StatPill
              label="Next fire"
              value={nextFire ? formatNextFireRelative(nextFire) : "—"}
              note={nextFire ? formatTimestamp(nextFire.toISOString()) : undefined}
            />
            <StatPill label="Schedules" value={String(agent?.scheduleIds.length ?? 0)} />
            <StatPill label="Tokens" value={formatTokenCount(totalTokens)} />
          </div>

          <div className="grid gap-4 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-4 md:grid-cols-3">
            <TimelineField
              label="Created"
              value={formatTimestamp(agent?.createdAt)}
              note={agent ? formatRelative(agent.createdAt) : undefined}
            />
            <TimelineField
              label="Last fired"
              value={formatTimestamp(agent?.lastFiredAt)}
              note={agent ? formatRelative(agent.lastFiredAt) : undefined}
            />
            <TimelineField
              label="Last completed"
              value={formatTimestamp(agent?.lastCompletedAt)}
              note={agent ? formatRelative(agent.lastCompletedAt) : undefined}
            />
          </div>

          <p className="break-all font-mono text-xs leading-6 text-muted-foreground">
            Agent {agentId ?? "unknown"} · Persona {agent?.personaId ?? "unknown"}
          </p>
        </CardContent>
      </Card>

      <AgentInputsCard agent={agent} workspaceId={workspaceId} />

      <Card className="rounded-[2rem] border-[var(--dashboard-border)] bg-[var(--dashboard-panel)]">
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle>Run logs</CardTitle>
              <CardDescription>
                {filteredFires.length} of {fires.length} runs shown · live
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-[16rem]">
                <Search className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground" aria-hidden="true" />
                <Input
                  value={runSearch}
                  onChange={(event) => setRunSearch(event.target.value)}
                  placeholder="Search logs..."
                  className="pl-9"
                />
              </div>
              <FilterSelect
                label="Status"
                value={runStatusFilter}
                values={runStatusOptions}
                onChange={setRunStatusFilter}
              />
              <FilterSelect
                label="Trigger"
                value={runTriggerFilter}
                values={runTriggerOptions}
                onChange={setRunTriggerFilter}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {firesError ? (
            <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
              {firesError}
            </div>
          ) : null}
          <div className="overflow-hidden rounded-[1.25rem] border border-[var(--border-default)] bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Integration</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {firesLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
                      Loading runs.
                    </TableCell>
                  </TableRow>
                ) : filteredFires.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
                      No runs match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredFires.map((fire) => {
                    const provider = providerFromEventSource(fire.eventSource);
                    const selected = selectedRun?.id === fire.id;
                    return (
                      <TableRow
                        key={fire.id}
                        className={cn("cursor-pointer", selected ? "bg-[var(--surface-soft)]" : null)}
                        onClick={() => void openRun(fire)}
                      >
                        <TableCell className="min-w-[13rem]">
                          <div className="flex flex-col gap-1">
                            <span className="font-mono text-xs text-foreground">{fullTimestamp(fire.startedAt)}</span>
                            <span className="text-xs text-muted-foreground">{formatRelative(fire.startedAt)}</span>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {formatDuration(fire.durationMs)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <Badge variant={getFireBadgeVariant(fire.status)}>{fire.status}</Badge>
                            <span className="text-xs text-muted-foreground">Exit {fire.exitCode ?? "unknown"}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="default">{triggerFromEventSource(fire.eventSource)}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-0 items-center gap-2">
                            <ProviderLogo provider={provider} label={provider} size={18} />
                            <span className="max-w-[14rem] truncate text-sm text-foreground">
                              {fire.eventSource}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Open run ${fire.id}`}
                            disabled={loadingRunId === fire.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              void openRun(fire);
                            }}
                          >
                            <ChevronRight aria-hidden="true" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {runDetailError ? (
            <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
              {runDetailError}
            </div>
          ) : null}

          <div
            ref={runLogPanelRef}
            tabIndex={-1}
            data-testid="run-log-panel"
            className="rounded-[1.25rem] border border-[var(--border-default)] bg-card outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <div className="flex flex-col gap-3 border-b border-[var(--border-default)] p-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold text-foreground">Log entries</h2>
                  {selectedRun ? <Badge variant={getFireBadgeVariant(selectedRun.status)}>{selectedRun.status}</Badge> : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedRun
                    ? `${filteredEntries.length} of ${entries.length} structured entries · ${selectedRun.eventSource}`
                    : "Select a run to inspect structured entries."}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative min-w-[16rem]">
                  <Search className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground" aria-hidden="true" />
                  <Input
                    value={entrySearch}
                    onChange={(event) => setEntrySearch(event.target.value)}
                    placeholder="Search entries..."
                    className="pl-9"
                    disabled={!selectedRun}
                  />
                </div>
                <FilterSelect
                  label="Level"
                  value={entryLevelFilter}
                  values={entryLevelOptions}
                  onChange={setEntryLevelFilter}
                />
                <FilterSelect
                  label="Source"
                  value={entrySourceFilter}
                  values={entrySourceOptions}
                  onChange={setEntrySourceFilter}
                />
                <Button
                  variant={showRawLogs ? "default" : "outline"}
                  size="sm"
                  disabled={!selectedRun}
                  onClick={() => setShowRawLogs((current) => !current)}
                >
                  <Terminal data-icon="inline-start" aria-hidden="true" />
                  Raw
                </Button>
              </div>
            </div>

            {showRawLogs && selectedRun ? (
              <div className="grid gap-3 p-4 lg:grid-cols-3">
                {[
                  { label: "stdout", value: selectedRun.stdout, truncated: selectedRun.stdoutTruncated },
                  { label: "stderr", value: selectedRun.stderr, truncated: selectedRun.stderrTruncated },
                  { label: "mount", value: selectedRun.mountLogTail, truncated: false },
                ].map((log) => (
                  <div key={log.label} className="min-w-0 rounded-xl border border-[var(--code-border)] bg-[var(--code-bg)]">
                    <div className="flex items-center justify-between gap-2 border-b border-[var(--code-border)] px-3 py-2">
                      <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{log.label}</span>
                      {log.truncated ? <Badge variant="warning">truncated</Badge> : null}
                    </div>
                    <pre className="max-h-[22rem] overflow-auto p-3 font-mono text-xs leading-5 text-foreground">
                      {log.value || "No output captured."}
                    </pre>
                  </div>
                ))}
              </div>
            ) : selectedRun ? (
              <div className="overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Timestamp</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead className="text-right">Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEntries.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">
                          {entries.length === 0 ? "No structured entries found. Use Raw to inspect captured output." : "No entries match these filters."}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredEntries.map((entry) => (
                        <TableRow key={entry.id} className="cursor-pointer" onClick={() => setSelectedEntry(entry)}>
                          <TableCell className="min-w-[13rem]">
                            <div className="flex flex-col gap-1">
                              <span className="font-mono text-xs text-foreground">{fullTimestamp(entry.timestamp)}</span>
                              <span className="text-xs text-muted-foreground">{formatRelative(entry.timestamp)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs">
                            {formatDuration(entry.durationMs)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={levelBadgeVariant(entry.level)}>{entryStatus(entry)}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="default">
                              <FileJson aria-hidden="true" />
                              {entry.level}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="default">{entry.source}</Badge>
                          </TableCell>
                          <TableCell className="max-w-xl">
                            <p className="truncate font-mono text-xs text-foreground">{entry.message}</p>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Open log entry ${entry.id}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedEntry(entry);
                              }}
                            >
                              <ChevronRight aria-hidden="true" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="flex min-h-[12rem] items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {firesLoading || loadingRunId ? "Loading run logs." : "Select a run above to inspect structured entries."}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      <EntryDetailSheet entry={selectedEntry} onOpenChange={(open) => {
        if (!open) setSelectedEntry(null);
      }} />
    </div>
  );
}
