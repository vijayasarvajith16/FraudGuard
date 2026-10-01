import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin /api in development too: the dev server forwards to the gateway (contracts §8.1).
      proxy: { '/api': { target: env.GATEWAY_URL || 'http://localhost:8080' } },
    },
    build: { target: 'es2022', sourcemap: false },
    test: {
      environment: 'jsdom',
      setupFiles: ['./tests/setup.js'],
      include: ['tests/**/*.test.{js,jsx}'],
      restoreMocks: true,
      unstubGlobals: true,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{js,jsx}'],
        reporter: ['text-summary', 'lcov'],
      },
    },
  };
});
