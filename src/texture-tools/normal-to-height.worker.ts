import { normalToHeight, type NormalMapGreenConvention } from "./normal-to-height";

/** Runs normalToHeight() off the main thread - the FFT on a 2048x2048
 * mirrored field takes a few seconds, which would freeze the whole UI
 * (including the loading overlay meant to show progress) if run inline. */
export interface HeightWorkerRequest {
  rgba: ArrayBuffer;
  width: number;
  height: number;
  greenConvention: NormalMapGreenConvention;
}

export type HeightWorkerResponse =
  | { type: "progress"; stage: string }
  | { type: "done"; width: number; height: number; data: ArrayBuffer }
  | { type: "error"; message: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<HeightWorkerRequest>) => void) | null;
  postMessage: (message: HeightWorkerResponse, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  try {
    const { rgba, width, height, greenConvention } = e.data;
    const result = normalToHeight(new Uint8ClampedArray(rgba), width, height, { greenConvention }, (stage) =>
      ctx.postMessage({ type: "progress", stage }),
    );
    ctx.postMessage({ type: "done", width: result.width, height: result.height, data: result.data.buffer as ArrayBuffer }, [
      result.data.buffer as ArrayBuffer,
    ]);
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
