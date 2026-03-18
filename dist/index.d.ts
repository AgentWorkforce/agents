type MatrixRow = {
    name: string;
    models: string[];
};
type Matrix = Record<string, MatrixRow>;
export declare function getHarnesses(): Array<{
    id: string;
    name: string;
}>;
export declare function getModelsByHarness(harnessId: string): string[];
export declare function getHarnessesByModel(modelId: string): Array<{
    id: string;
    name: string;
}>;
export declare function getMatrix(): Matrix;
export {};
