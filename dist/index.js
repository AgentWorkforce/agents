import matrix from './matrix.json' with { type: 'json' };

export function getHarnesses() {
  return Object.entries(matrix).map(([id, v]) => ({ id, name: v.name }));
}

export function getModelsByHarness(harnessId) {
  return matrix[harnessId]?.models ?? [];
}

export function getHarnessesByModel(modelId) {
  return Object.entries(matrix)
    .filter(([, v]) => v.models.includes(modelId))
    .map(([id, v]) => ({ id, name: v.name }));
}

export function getMatrix() {
  return matrix;
}
