import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/**/*.test.ts', 'apps/desktop/src/**/*.test.ts'], exclude: ['sources/**', 'node_modules/**'], environment: 'node' } });
