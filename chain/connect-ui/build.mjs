import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', '..', 'public', 'vendor');
await build({
  entryPoints: [path.join(here, 'src', 'main.jsx')],
  outfile: path.join(out, 'dogeos-connect.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: true, sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.jpg': 'dataurl', '.gif': 'dataurl' },
  logLevel: 'info'
});
