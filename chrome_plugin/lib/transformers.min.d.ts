/**
 * Types for the vendored Transformers.js bundle.
 * transformers.min.js is excluded from checkJs; this declaration is what tsc resolves.
 */

export type ProgressInfo = {
  status?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  file?: string;
};

export type PipelineOptions = {
  device?: string;
  dtype?: string;
  revision?: string;
  progress_callback?: (info: ProgressInfo) => void;
};

export type TextClassificationRow = {
  label?: string;
  score?: number;
};

export type Pipeline = {
  (text: string): Promise<TextClassificationRow[] | TextClassificationRow[][]>;
  (
    image: string,
    labels: string[],
  ): Promise<TextClassificationRow[] | TextClassificationRow>;
};

export function pipeline(
  task: string,
  model: string,
  options?: PipelineOptions,
): Promise<Pipeline>;

export const env: {
  allowLocalModels: boolean;
  useBrowserCache: boolean;
  allowRemoteModels: boolean;
  backends?: {
    onnx?: {
      wasm?: {
        wasmPaths?: string;
        numThreads?: number;
      };
    };
  };
};
