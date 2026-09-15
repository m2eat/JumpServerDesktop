import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
const utilityDir = resolve('apps/desktop/src/utility');
const utilityEntries = existsSync(utilityDir) ? Object.fromEntries(readdirSync(utilityDir).filter(file => file.endsWith('.ts')).map(file => [basename(file, '.ts'), resolve(utilityDir, file)])) : {};
const development = process.env.JMS_DEV_MODE === '1';
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { ...(development ? { outDir: resolve('out-dev/main') } : {}), rollupOptions: { input: { index: resolve('apps/desktop/src/main/index.ts'), ...utilityEntries } } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { ...(development ? { outDir: resolve('out-dev/preload') } : {}), rollupOptions: { input: { index: resolve('apps/desktop/src/preload/index.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: { root: resolve('apps/desktop/src/renderer'), resolve: { alias: { '@shared': resolve('packages/desktop-contract/src') } }, plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: Number(process.env.JMS_DEV_PORT || 5173), strictPort: true }, build: { rollupOptions: { input: resolve('apps/desktop/src/renderer/index.html') } } }
});
