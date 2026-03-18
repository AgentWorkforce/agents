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
