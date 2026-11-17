import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
export function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
export function headers(res) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'");
  res.setHeader('Cache-Control', 'no-store');
}
const files = new Map([
  ['/app/assets/icon.svg', ['assets/icon.svg', 'image/svg+xml']],
  ...['ApfelGrotezk-Fett', 'InriaSans-Regular', 'InriaSans-Bold'].map(name => ['/app/assets/fonts/' + name + '.woff2', ['assets/fonts/' + name + '.woff2', 'font/woff2']]),
  ['/app/', ['index.html', 'text/html; charset=utf-8']],
  ['/app/app.mjs', ['app.mjs', 'text/javascript']],
  ['/app/account-client.mjs', ['account-client.mjs', 'text/javascript']],
  ['/app/direct.mjs', ['direct.mjs', 'text/javascript']],
  ['/app/device-vault.mjs', ['device-vault.mjs', 'text/javascript']],
  ['/app/vault.mjs', ['vault.mjs', 'text/javascript']],
  ['/app/styles.css', ['styles.css', 'text/css']],
  ['/app/opaque.mjs', ['opaque.mjs', 'text/javascript']],
]);
export function staticRequest(req, res) {
  headers(res);
  if (!['GET', 'HEAD'].includes(req.method)) { reply(res, 405, { error: 'Method not allowed.' }); return; }
  if (req.url === '/app') { res.writeHead(308, { Location: '/app/' }); res.end(); return; }
  const file = files.get(req.url);
  if (!file) { reply(res, 404, { error: 'Not found.' }); return; }
  try {
    const data = readFileSync(root + file[0]);
    res.writeHead(200, { 'Content-Type': file[1] }); res.end(req.method === 'HEAD' ? undefined : data);
  } catch { reply(res, 503, { error: 'Portal asset unavailable. Retry after the build completes.' }); }
}
export function configureHTTP(server) {
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000; server.maxConnections = 64;
  server.maxRequestsPerSocket = 50;
  server.on('clientError', (_error, socket) => { socket.destroy(); });
}
