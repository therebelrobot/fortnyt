import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/client'),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/public'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: { '/api/': `http://localhost:${process.env.PORT ?? 8080}` },
  },
});
