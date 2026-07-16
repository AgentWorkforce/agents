import http from 'node:http';

export async function createSentinelServer() {
  const counts = {
    allowed: { get: 0 },
    denied: { post: 0, raw: 0 },
    undeclared: { get: 0 },
    requests: [],
  };

  const server = http.createServer((req, res) => {
    const body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      const payload = Buffer.concat(body).toString('utf8');
      counts.requests.push({ method: req.method, url: req.url, body: payload });
      if (req.method === 'GET' && req.url === '/allowed-get') counts.allowed.get += 1;
      if (req.method === 'GET' && req.url === '/undeclared-get') counts.undeclared.get += 1;
      if (req.method === 'POST' && req.url === '/denied-post') {
        if (payload === 'raw-http-body') counts.denied.raw += 1;
        else counts.denied.post += 1;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate local sentinel server port');
  }

  return {
    allowedUrl: `http://127.0.0.1:${address.port}/allowed-get`,
    deniedUrl: `http://127.0.0.1:${address.port}/denied-post`,
    undeclaredUrl: `http://127.0.0.1:${address.port}/undeclared-get`,
    counts,
    close: () => server.close(),
  };
}
