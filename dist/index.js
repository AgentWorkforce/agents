import matrix from '../dist/matrix.json' with { type: 'json' };
const typedMatrix = matrix;
export function getHarnesses() {
    return Object.entries(typedMatrix).map(([id, v]) => ({ id, name: v.name }));
}
export function getModelsByHarness(harnessId) {
    return typedMatrix[harnessId]?.models ?? [];
}
export function getHarnessesByModel(modelId) {
    return Object.entries(typedMatrix)
        .filter(([, v]) => v.models.includes(modelId))
        .map(([id, v]) => ({ id, name: v.name }));
}
export function getMatrix() {
    return typedMatrix;
}
