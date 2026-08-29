// Vitest setup — applied to all unit + integration tests.
import { afterEach, beforeAll } from 'vitest';

beforeAll(() => {
  // Force a deterministic TZ for date math
  process.env.TZ = process.env.TZ ?? 'UTC';
});

afterEach(() => {
  // Each test is responsible for its own cleanup
});
