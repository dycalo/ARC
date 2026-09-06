import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['packages/web/client/index.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  loader: { '.css': 'text' },
  write: false,
  minify: true,
  legalComments: 'inline',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const content = result.outputFiles[0].text;
await mkdir('dist/web', { recursive: true });
await writeFile(
  'dist/web/client.js',
  `window.__ModuleLoader__.load({id:"@dycalo/arc",factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${content}\nreturn module.exports;}});\n`,
);
