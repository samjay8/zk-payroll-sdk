# Worker-Based Proof Generation

ZK proof generation involves heavy witness computation that can take several seconds. Running this work inside a [Web Worker](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API) keeps the main UI thread free and prevents the interface from freezing.

## How it works

```
Main thread                         Worker thread
──────────────────                  ──────────────────────────────
WorkerProofGenerator                proof.worker.ts
  │                                   │
  │── GENERATE_PROOF ──────────────►  │
  │                                   │  fetch .wasm + .zkey
  │◄── PROGRESS (loading_wasm) ──────  │  (cached after first call)
  │◄── PROGRESS (loading_zkey) ──────  │
  │◄── PROGRESS (generating) ────────  │  groth16.fullProve(witness)
  │◄── PROOF_RESULT ─────────────────  │
  │                                   │
```

All messages are strongly typed via `WorkerRequest` / `WorkerResponse` in `WorkerMessages.ts`.

## Quick start

### 1. Copy (or import) the worker script

The worker entrypoint lives at:

```
packages/core/src/crypto/proof.worker.ts
```

Your bundler must be able to resolve and bundle it as a separate chunk. See the framework-specific sections below.

### 2. Create a `WorkerProofGenerator`

```ts
import { WorkerProofGenerator } from '@zk-payroll/core';

// Create the worker using your bundler's syntax (see below)
const worker = /* … */;

const generator = new WorkerProofGenerator(
  worker,
  {
    wasmUrl: '/circuits/payroll.wasm',
    zkeyUrl:  '/circuits/payroll.zkey',
  },
  {
    // Optional: global progress handler for all generateProof calls
    onProgress: (stage, pct) => {
      console.log(`[proof] ${stage}`, pct !== undefined ? `${pct}%` : '');
    },
    // Optional: override the default 120 000 ms timeout
    timeoutMs: 90_000,
  }
);
```

### 3. Generate a proof

```ts
const proof = await generator.generateProof(
  { recipient: 'GABC…', amount: 5000n },
  // Optional per-call progress override
  (stage) => setStatus(stage),
);

// proof.proof   — pi_a, pi_b, pi_c ready for the Soroban verifier
// proof.publicSignals — circuit public signals
```

### 4. Tear down

```ts
// Terminates the worker and rejects any in-flight requests
generator.terminate();
```

---

## Framework examples

### Vite / vanilla TypeScript

```ts
// src/zkWorker.ts
import { WorkerProofGenerator } from '@zk-payroll/core';

// Vite bundles this as a separate worker chunk at build time
const worker = new Worker(
  new URL('./crypto/proof.worker.ts', import.meta.url),
  { type: 'module' }
);

export const proofGenerator = new WorkerProofGenerator(worker, {
  wasmUrl: '/circuits/payroll.wasm',
  zkeyUrl:  '/circuits/payroll.zkey',
});

// Pre-fetch artifacts so the first proof starts immediately
proofGenerator.preloadArtifacts();
```

```ts
// src/PayButton.ts
import { proofGenerator } from './zkWorker';

async function handlePay(recipient: string, amount: bigint) {
  const proof = await proofGenerator.generateProof(
    { recipient, amount },
    (stage) => updateSpinner(stage),
  );
  await submitPayroll(proof);
}
```

### Next.js (App Router)

Next.js supports the `new Worker(new URL(…))` pattern when the target file is resolved at build time.

```tsx
// lib/useProofGenerator.ts
'use client';

import { useEffect, useRef } from 'react';
import { WorkerProofGenerator } from '@zk-payroll/core';

export function useProofGenerator() {
  const generatorRef = useRef<WorkerProofGenerator | null>(null);

  useEffect(() => {
    const worker = new Worker(
      // Next.js resolves this at build time
      new URL('../crypto/proof.worker.ts', import.meta.url)
    );

    generatorRef.current = new WorkerProofGenerator(worker, {
      wasmUrl: '/circuits/payroll.wasm',
      zkeyUrl:  '/circuits/payroll.zkey',
    });

    // Warm up the cache on mount
    generatorRef.current.preloadArtifacts().catch(console.error);

    return () => {
      generatorRef.current?.terminate();
      generatorRef.current = null;
    };
  }, []);

  return generatorRef;
}
```

```tsx
// components/PayButton.tsx
'use client';

import { useState } from 'react';
import { useProofGenerator } from '../lib/useProofGenerator';

export function PayButton({ recipient, amount }: { recipient: string; amount: bigint }) {
  const [status, setStatus] = useState('');
  const generatorRef = useProofGenerator();

  async function handleClick() {
    if (!generatorRef.current) return;
    try {
      const proof = await generatorRef.current.generateProof(
        { recipient, amount },
        (stage) => setStatus(stage),
      );
      await submitPayroll(proof);
      setStatus('done');
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    }
  }

  return (
    <button onClick={handleClick}>
      Pay {status ? `— ${status}` : ''}
    </button>
  );
}
```

> **Next.js note**: Add the following to `next.config.js` if you encounter worker bundling issues:
> ```js
> /** @type {import('next').NextConfig} */
> const nextConfig = {
>   webpack(config) {
>     config.module.rules.push({
>       resourceQuery: /worker/,
>       type: 'asset/resource',
>     });
>     return config;
>   },
> };
> module.exports = nextConfig;
> ```

---

## API reference

### `WorkerProofGenerator`

Implements the `IProofGenerator` interface. All proof work runs inside the supplied worker.

```ts
new WorkerProofGenerator(
  worker:  WorkerLike,          // The Web Worker (or compatible object)
  config:  ProofGeneratorConfig, // wasmUrl, zkeyUrl, artifactCacheTTL?
  options?: WorkerProofOptions   // onProgress?, timeoutMs?
)
```

| Method | Returns | Description |
|---|---|---|
| `generateProof(witness, onProgress?)` | `Promise<ProofPayload>` | Generate a proof off-thread |
| `preloadArtifacts()` | `Promise<void>` | Pre-fetch .wasm and .zkey into the worker cache |
| `clearCache()` | `Promise<void>` | Clear the worker's artifact cache |
| `terminate()` | `void` | Stop the worker; rejects all pending requests |

### Progress stages

| Stage | Meaning |
|---|---|
| `loading_wasm` | Worker is fetching the `.wasm` circuit file |
| `loading_zkey` | Worker is fetching the `.zkey` proving key |
| `generating` | `groth16.fullProve` is running |
| `done` | Proof complete; `PROOF_RESULT` will follow immediately |

### `WorkerLike` interface

`WorkerProofGenerator` accepts any object matching this interface, which makes it easy to test with mock workers:

```ts
interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  addEventListener(type: 'message', listener: …): void;
  addEventListener(type: 'error',   listener: …): void;
  removeEventListener(…): void;
  terminate(): void;
}
```

---

## Error handling

All errors surface as `PayrollError` rejections on the returned Promise.

```ts
import { PayrollError } from '@zk-payroll/core';

try {
  const proof = await generator.generateProof(witness);
} catch (err) {
  if (err instanceof PayrollError) {
    // err.code:
    //   500 — worker reported an error or crashed
    //   408 — proof generation timed out (default 120 s)
    //   0   — generator.terminate() was called
    console.error('Proof failed:', err.message, 'code:', err.code);
  }
}
```

### Timeout

The default timeout is **120 000 ms** (2 minutes). Adjust via `options.timeoutMs`:

```ts
const generator = new WorkerProofGenerator(worker, config, { timeoutMs: 60_000 });
```

---

## Minimising data-copy overhead

The `.wasm` and `.zkey` files are loaded **once inside the worker** and held in memory. Subsequent proof requests reuse the cached buffers — no cross-thread copying occurs for the artifact data.

Witness objects are serialised via the structured-clone algorithm (browser native), which supports `bigint`, typed arrays, and nested objects. For very large witnesses, consider passing only primitive-serialisable fields.

Call `preloadArtifacts()` early (e.g. on page load) so the first user-triggered proof starts instantly rather than waiting for network fetches.
