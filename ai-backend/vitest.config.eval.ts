import { defineConfig } from 'vitest/config';

// Eval com o modelo real (custa API): npm run eval. Fora do npm test de propósito.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['eval/**/*.eval.ts'],
  },
});
