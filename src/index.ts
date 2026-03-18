import matrix from '../dist/matrix.json' with { type: 'json' };

type MatrixRow = { name: string; source: string; known: boolean; models: string[] };
type Matrix = Record<string, MatrixRow>;
const typedMatrix = matrix as Matrix;

export function getHarnesses(): Array<{ id: string; name: string; known: boolean; source: string }> {
  return Object.entries(typedMatrix).map(([id, v]) => ({ id, name: v.name, known: v.known, source: v.source }));
}

export function getModelsByHarness(harnessId: string): string[] {
  return typedMatrix[harnessId]?.models ?? [];
}

export function getHarnessesByModel(modelId: string): Array<{ id: string; name: string }> {
  return Object.entries(typedMatrix)
    .filter(([, v]) => v.models.includes(modelId))
    .map(([id, v]) => ({ id, name: v.name }));
}

export function getMatrix(): Matrix {
  return typedMatrix;
}
