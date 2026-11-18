import { build } from 'esbuild';
export default async function() {
  await build({entryPoints:['tests/request-harness.tsx'],bundle:true,format:'iife',jsx:'automatic',outfile:'test-results/qr-harness.js',define:{__APP_VERSION__:'"test"','import.meta.env.MODE':'"test"','import.meta.env.DEV':'true'},logLevel:'warning'});
}
