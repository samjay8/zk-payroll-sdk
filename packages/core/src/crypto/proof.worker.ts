/**
 * ZK Payroll proof generation worker.
 *
 * This file is designed to run inside a browser Web Worker so that heavy
 * witness computation and proof generation do not block the main UI thread.
 *
 * Bundler usage:
 *   Vite  — new Worker(new URL('./proof.worker.ts', import.meta.url), { type: 'module' })
 *   Next.js — new Worker(new URL('./proof.worker.ts', import.meta.url))
 *   webpack — import ProofWorker from './proof.worker.ts?worker' (with worker-loader)
 *
 * The worker communicates with the main thread via typed postMessage messages
 * defined in WorkerMessages.ts.
 */

import { groth16 } from "snarkjs";
import type { ProofPayload, ProofGeneratorConfig } from "./IProofGenerator";
import type { WorkerRequest, WorkerResponse, ProofProgressStage } from "./WorkerMessages";

// Typed reference to the Web Worker global scope.
// Using an interface avoids conflicts between the DOM lib (Window) and the
// webworker lib (DedicatedWorkerGlobalScope).
interface WorkerScope {
  postMessage(msg: WorkerResponse): void;
  addEventListener(type: "message", listener: (event: { data: WorkerRequest }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

// ── In-worker artifact cache ─────────────────────────────────────────────────
let wasmCache: ArrayBuffer | null = null;
let zkeyCache: Uint8Array | null = null;
let cachedWasmUrl: string | null = null;
let cachedZkeyUrl: string | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function emit(msg: WorkerResponse): void {
  scope.postMessage(msg);
}

function emitProgress(id: string, stage: ProofProgressStage, progress?: number): void {
  emit({ type: "PROGRESS", id, stage, progress });
}

async function loadWasm(url: string, id: string): Promise<ArrayBuffer> {
  if (wasmCache !== null && cachedWasmUrl === url) return wasmCache;

  emitProgress(id, "loading_wasm");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch .wasm (HTTP ${res.status}): ${url}`);
  }

  wasmCache = await res.arrayBuffer();
  cachedWasmUrl = url;
  return wasmCache;
}

async function loadZkey(url: string, id: string): Promise<Uint8Array> {
  if (zkeyCache !== null && cachedZkeyUrl === url) return zkeyCache;

  emitProgress(id, "loading_zkey");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch .zkey (HTTP ${res.status}): ${url}`);
  }

  zkeyCache = new Uint8Array(await res.arrayBuffer());
  cachedZkeyUrl = url;
  return zkeyCache;
}

function formatPayload(
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol?: string;
    curve?: string;
  },
  publicSignals: string[]
): ProofPayload {
  return {
    proof: {
      pi_a: [proof.pi_a[0], proof.pi_a[1]],
      // snarkjs pi_b coordinates must be swapped for Solidity/Soroban verifiers
      pi_b: [
        [proof.pi_b[0][1], proof.pi_b[0][0]],
        [proof.pi_b[1][1], proof.pi_b[1][0]],
      ],
      pi_c: [proof.pi_c[0], proof.pi_c[1]],
      protocol: proof.protocol ?? "groth16",
      curve: proof.curve ?? "bn128",
    },
    publicSignals,
  };
}

// ── Request handlers ─────────────────────────────────────────────────────────

async function handleGenerateProof(
  id: string,
  witness: Record<string, unknown>,
  config: ProofGeneratorConfig
): Promise<void> {
  const [wasm, zkey] = await Promise.all([
    loadWasm(config.wasmUrl, id),
    loadZkey(config.zkeyUrl, id),
  ]);

  emitProgress(id, "generating", 0);

  const { proof, publicSignals } = await groth16.fullProve(witness, wasm, zkey);

  emitProgress(id, "done", 100);
  emit({ type: "PROOF_RESULT", id, payload: formatPayload(proof, publicSignals) });
}

async function handlePreload(id: string, config: ProofGeneratorConfig): Promise<void> {
  await Promise.all([loadWasm(config.wasmUrl, id), loadZkey(config.zkeyUrl, id)]);
  emit({ type: "PRELOAD_DONE", id });
}

function handleClearCache(id: string): void {
  wasmCache = null;
  zkeyCache = null;
  cachedWasmUrl = null;
  cachedZkeyUrl = null;
  emit({ type: "CACHE_CLEARED", id });
}

// ── Message loop ─────────────────────────────────────────────────────────────

scope.addEventListener("message", (event: { data: WorkerRequest }) => {
  const req = event.data;

  const run = async (): Promise<void> => {
    if (req.type === "GENERATE_PROOF") {
      await handleGenerateProof(req.id, req.witness, req.config);
    } else if (req.type === "PRELOAD_ARTIFACTS") {
      await handlePreload(req.id, req.config);
    } else if (req.type === "CLEAR_CACHE") {
      handleClearCache(req.id);
    }
  };

  run().catch((err: unknown) => {
    emit({
      type: "PROOF_ERROR",
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    });
  });
});
