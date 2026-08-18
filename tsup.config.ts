import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  // Dual CJS + ESM so the package.json `exports` map resolves for both the
  // app's tsc/jest (require → dist/index.js) and bundlers (import → index.mjs).
  format: ['cjs', 'esm'],
  // Emit declarations so the host's tsc can type the package.
  dts: true,
  sourcemap: true,
  clean: true,
  // Peer deps — provided by the host, never bundled.
  external: ['react', 'react-dom', '@signalsandsorcery/plugin-sdk'],
});
