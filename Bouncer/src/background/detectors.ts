// The fixed classifier result and its one-result dispatch boundary.
import type { FilterScore } from '../types';

export interface DetectorResult {
  shouldHide: boolean;
  reasoning: string;
  category?: string | null;
  matches?: string[];
  scores?: FilterScore[];
  textSent?: string;
  rawResponse?: string | null;
  inferenceTime?: number;
  classifierFingerprint?: string;
  modelId?: string;
  engine?: 'llama.app';
}

/** Dispatch exactly once for a terminal result or error; propagate failures. */
export async function runDetector(
  name: string,
  promise: Promise<DetectorResult>,
  onResponse: (name: string, result: DetectorResult | null, error: Error | null) => void,
): Promise<DetectorResult> {
  let result: DetectorResult;
  try {
    result = await promise;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    onResponse(name, null, failure);
    throw failure;
  }
  onResponse(name, result, null);
  return result;
}
