import { randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';

// Drain the gateway stream through EOF even if the native SSE client closes as
// soon as it observes response.completed. The gateway only reports a completed
// receipt after the full upstream body reaches its own downstream; Official's
// end-of-stream can trail response.completed (notably through a proxy), and a
// probe also closes its app-server right after the turn. Never inspect or save
// auth headers.
export async function drainingRelay(target) {
  if (!(target instanceof URL) || target.protocol !== 'http:' || target.hostname !== '127.0.0.1'
    || !target.port || target.username || target.password || target.search || target.hash
    || !/^\/[a-f0-9]{64}(?:\/provider\/[^/]+)?\/v1$/.test(target.pathname)) {
    throw new Error('Reference relay requires the selected local gateway provider path');
  }
  const prefix = `/${randomBytes(24).toString('hex')}/v1`;
  const observations = [], sockets = new Set(), requests = new Set();
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin
      || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none')) {
      req.resume(); res.writeHead(403); res.end(); return;
    }
    const suffix = req.url?.startsWith(prefix) ? req.url.slice(prefix.length) : null;
    // Only the models listing carries a query (client_version); the gateway checks it again.
    const match = /^(\/responses(?:\/compact)?|\/models)(\?[^#]*)?$/.exec(suffix || '');
    if (!match || (match[2] && match[1] !== '/models') || req.method !== (match[1] === '/models' ? 'GET' : 'POST')) {
      req.resume(); res.writeHead(404); res.end(); return;
    }
    const upstream = request(target, {
      method: req.method, path: `${target.pathname}${match[1]}${match[2] || ''}`,
      headers: { ...req.headers, host: target.host, 'accept-encoding': 'identity' },
    }, incoming => {
      const observation = { statusCode: incoming.statusCode, contentType: incoming.headers['content-type'] ?? null,
        contentEncoding: incoming.headers['content-encoding'] ?? null, ended: false };
      observations.push(observation);
      res.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.on('data', chunk => { if (!res.destroyed) res.write(chunk); });
      incoming.once('end', () => {
        observation.ended = incoming.complete; requests.delete(upstream);
        if (!res.destroyed) res.end();
      });
      incoming.once('error', () => { requests.delete(upstream); res.destroy(); });
    });
    requests.add(upstream);
    upstream.once('error', () => {
      requests.delete(upstream);
      if (!res.headersSent) res.writeHead(502);
      if (!res.destroyed) res.end();
    });
    upstream.setTimeout(600000, () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let closed;
  return {
    url: `http://127.0.0.1:${server.address().port}${prefix}`, observations,
    close() {
      closed ||= (async () => {
        for (const upstream of requests) upstream.destroy();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      })();
      return closed;
    },
  };
}
