import { IProofGenerator, ProofPayload, ProofGeneratorConfig } from "./IProofGenerator";
import { WorkerRequest, WorkerResponse, ProofProgressStage } from "./WorkerMessages";
import { PayrollError } from "../errors";

/**
 * Callback invoked as the worker reports proof generation progress.
 *
 * @param stage    - Current stage of work inside the worker
 * @param progress - Optional 0-100 completion percentage
 */
export type ProofProgressCallback = (stage: ProofProgressStage, progress?: number) => void;

/**
 * Options for WorkerProofGenerator.
 */
export interface WorkerProofOptions {
  /**
   * Global progress handler applied to every generateProof call unless
   * overridden by the per-call onProgress argument.
   */
  onProgress?: ProofProgressCallback;
  /**
   * Maximum milliseconds to wait for the worker to respond before
   * rejecting with a timeout error. Defaults to 120 000 ms (2 minutes).
   */
  timeoutMs?: number;
}

/**
 * Minimal interface for a Web Worker (or any compatible message channel).
 * Using an interface instead of the concrete DOM Worker type keeps this
 * class usable in non-DOM environments and makes testing straightforward.
 */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  addEventListener(
    type: "message",
    listener: (event: { data: WorkerResponse }) => void
  ): void;
  addEventListener(type: "error", listener: (event: { message: string }) => void): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: WorkerResponse }) => void
  ): void;
  removeEventListener(
    type: "error",
    listener: (event: { message: string }) => void
  ): void;
  terminate(): void;
}

interface PendingRequest {
  resolve: (payload: ProofPayload) => void;
  reject: (err: Error) => void;
  onProgress?: ProofProgressCallback;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * IProofGenerator implementation that delegates proof generation to a
 * browser Web Worker, keeping the main UI thread responsive during heavy
 * witness computation.
 *
 * @example Basic usage (Vite)
 * ```ts
 * import { WorkerProofGenerator } from '@zk-payroll/core';
 *
 * const worker = new Worker(
 *   new URL('./proof.worker.ts', import.meta.url),
 *   { type: 'module' }
 * );
 *
 * const generator = new WorkerProofGenerator(worker, {
 *   wasmUrl: '/circuits/payroll.wasm',
 *   zkeyUrl: '/circuits/payroll.zkey',
 * });
 *
 * const proof = await generator.generateProof(
 *   { recipient: 'GABC...', amount: 5000n },
 *   (stage, pct) => console.log(stage, pct),
 * );
 *
 * // Tear down when done
 * generator.terminate();
 * ```
 */
export class WorkerProofGenerator implements IProofGenerator {
  private readonly pending = new Map<string, PendingRequest>();
  private seq = 0;

  private readonly messageHandler: (event: { data: WorkerResponse }) => void;
  private readonly errorHandler: (event: { message: string }) => void;

  constructor(
    private readonly worker: WorkerLike,
    private readonly config: ProofGeneratorConfig,
    private readonly options: WorkerProofOptions = {}
  ) {
    this.messageHandler = this.onMessage.bind(this);
    this.errorHandler = this.onError.bind(this);
    this.worker.addEventListener("message", this.messageHandler);
    this.worker.addEventListener("error", this.errorHandler);
  }

  // ── Internal event handlers ────────────────────────────────────────────────

  private onMessage(event: { data: WorkerResponse }): void {
    const msg = event.data;
    const pending = this.pending.get(msg.id);
    if (!pending) return;

    switch (msg.type) {
      case "PROOF_RESULT":
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        pending.resolve(msg.payload);
        break;

      case "PROOF_ERROR":
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        pending.reject(
          new PayrollError(`Worker proof generation failed: ${msg.message}`, 500)
        );
        break;

      case "PROGRESS":
        pending.onProgress?.(msg.stage, msg.progress);
        break;

      case "PRELOAD_DONE":
      case "CACHE_CLEARED":
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        // Cast satisfies the generic Promise<ProofPayload> signature;
        // callers of preloadArtifacts / clearCache map the result to void.
        pending.resolve(undefined as unknown as ProofPayload);
        break;
    }
  }

  private onError(event: { message: string }): void {
    const err = new PayrollError(`Worker error: ${event.message}`, 500);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  // ── Dispatch helper ────────────────────────────────────────────────────────

  private dispatch(
    req: WorkerRequest,
    onProgress?: ProofProgressCallback
  ): Promise<ProofPayload> {
    return new Promise<ProofPayload>((resolve, reject) => {
      const timeoutMs = this.options.timeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(
          new PayrollError(
            `Proof generation timed out after ${timeoutMs}ms`,
            408
          )
        );
      }, timeoutMs);

      this.pending.set(req.id, {
        resolve,
        reject,
        onProgress: onProgress ?? this.options.onProgress,
        timer,
      });

      this.worker.postMessage(req);
    });
  }

  private nextId(): string {
    return String(this.seq++);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generates a ZK proof inside the worker.
   *
   * @param witness    - Circuit input signals (bigint values are supported)
   * @param onProgress - Optional per-call progress callback; overrides the
   *                     global `onProgress` set in the constructor options
   */
  generateProof(
    witness: Record<string, unknown>,
    onProgress?: ProofProgressCallback
  ): Promise<ProofPayload> {
    return this.dispatch(
      { type: "GENERATE_PROOF", id: this.nextId(), witness, config: this.config },
      onProgress
    );
  }

  /**
   * Instructs the worker to pre-fetch and cache the .wasm and .zkey
   * artifacts so that the first `generateProof` call starts immediately.
   */
  preloadArtifacts(): Promise<void> {
    return this.dispatch({
      type: "PRELOAD_ARTIFACTS",
      id: this.nextId(),
      config: this.config,
    }).then(() => undefined);
  }

  /**
   * Clears the worker's in-memory artifact cache, forcing a fresh download
   * on the next proof generation request.
   */
  clearCache(): Promise<void> {
    return this.dispatch({ type: "CLEAR_CACHE", id: this.nextId() }).then(
      () => undefined
    );
  }

  /**
   * Terminates the underlying worker and rejects all in-flight requests.
   * The generator cannot be used after this call.
   */
  terminate(): void {
    const err = new PayrollError("Worker was terminated", 0);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.worker.removeEventListener("message", this.messageHandler);
    this.worker.removeEventListener("error", this.errorHandler);
    this.worker.terminate();
  }
}
