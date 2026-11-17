import { createServer } from 'node:http';
import { staticRequest, reply, headers, configureHTTP } from './http.mjs';
const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
  if (req.url?.startsWith('/api/account')) { headers(res); reply(res, 503, { error: 'Account service unavailable. Retry later; direct connection is available.' }); }
  else staticRequest(req, res);
});
configureHTTP(server);
server.on('error', () => { process.stderr.write('Direct portal could not listen.\n'); process.exitCode = 1; });
server.listen(Number(process.env.PORTAL_PORT || 43180), '127.0.0.1', () => { process.stdout.write('Direct portal listening on loopback.\n'); process.send?.({ port: server.address().port }); });
