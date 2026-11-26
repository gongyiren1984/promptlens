import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(rootDir, '../..');
const devFile = process.env.PROMPTLENS_DEV_FILE ?? resolve(repoRoot, '.promptlens-dev.json');

type DevConfig = { endpoint: string; token: string };

function loadDevConfig(): DevConfig | null {
  if (!existsSync(devFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(devFile, 'utf8'));
    return parsed?.endpoint && parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

export default defineConfig(({ command }) => {
  // 仅开发服务器读取 .promptlens-dev.json；生产构建不得把本地令牌注入产物。
  const dev = command === 'serve' ? loadDevConfig() : null;

  return {
    plugins: [react()],
    resolve: {
      alias: [
        { find: /^@promptlens\/contracts$/, replacement: resolve(repoRoot, 'packages/contracts/src/index.ts') },
        { find: /^@promptlens\/api-client$/, replacement: resolve(repoRoot, 'packages/api-client/src/index.ts') },
      ],
    },
    define: {
      __PROMPTLENS_DEV__: JSON.stringify(dev ? { baseUrl: '', token: dev.token } : null),
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: dev
        ? {
            '/v1': { target: dev.endpoint, changeOrigin: true, ws: false },
          }
        : undefined,
    },
    build: {
      outDir: 'dist',
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  };
});
