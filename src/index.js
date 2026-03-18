import harnesses from '../data/harnesses.json' with { type: 'json' };
import compatibility from '../data/compatibility.json' with { type: 'json' };

export function getHarnesses() {
  return harnesses.harnesses;
}

export function getCompatibility() {
  return compatibility.entries;
}

export function getModelsForHarness(harnessId) {
  return compatibility.entries.filter((e) => e.harness_id === harnessId);
}

export function getHarnessesForModel(model) {
  return compatibility.entries.filter((e) => e.model === model);
}

export function getReasoningProfiles(model, harnessId) {
  const row = compatibility.entries.find(
    (e) => e.model === model && e.harness_id === harnessId,
  );
  return row?.recommended_profiles ?? null;
}

export function getReasoningMeta(model, harnessId) {
  const row = compatibility.entries.find(
    (e) => e.model === model && e.harness_id === harnessId,
  );
  if (!row) return null;
  return {
    supported: row.reasoning_effort_supported ?? ['unknown'],
    param: row.reasoning_effort_param ?? null,
    values: row.reasoning_effort_values ?? [],
    default: row.default_reasoning_effort ?? null,
    costMultiplier: row.reasoning_cost_multiplier ?? null,
    latencyImpactMs: row.reasoning_latency_impact_ms ?? null,
    qualityDeltaByEffort: row.quality_delta_by_effort ?? null,
  };
}
