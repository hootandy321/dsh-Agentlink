import { cp } from 'node:fs/promises';

// The bridge owns the calculation source. Ship an independent compiled copy
// in the companion package; installed Hosts never import outside that package.
await cp(new URL('../../src/cost/', import.meta.url), new URL('../src/cost-core/', import.meta.url), { recursive: true });
