import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Playwright owns `e2e/*.spec.ts`; without this vitest also collects them and dies on
  // Playwright's test() outside a Playwright runner.
  test: { include: ['tests/**/*.test.ts'] },
});
