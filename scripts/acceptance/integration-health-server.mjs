import http from 'node:http';

const WORKSPACE_ID = 'ws-acceptance-test';

export async function createIntegrationHealthServer(opts = {}) {
  const workspaceId = opts.workspaceId ?? WORKSPACE_ID;
  const receivedRequests = [];

  const catalog = [{ id: 'github' }];
  const userList = [
    {
      provider: 'github',
      connectionId: 'conn-user-acceptance',
      scope: 'deployer_user',
      status: 'connected',
    },
  ];
  const workspaceList = [
    {
      provider: 'github',
      connectionId: 'conn-ws-acceptance',
      scope: 'workspace',
      status: 'connected',
    },
  ];
  const registrationHealthFixture = {
    registered: true,
    healthy: true,
    adapter: 'github-nango',
    checkedAt: '2026-07-15T00:00:00.000Z',
  };

  const server = http.createServer((req, res) => {
    const authHeader = req.headers['authorization'] ?? null;
    // Never retain the raw credential — store only presence and scheme.
    const authScheme = authHeader ? authHeader.split(' ')[0] : null;
    receivedRequests.push({ method: req.method, url: req.url, hasAuth: authHeader !== null, authScheme });

    res.setHeader('content-type', 'application/json');

    const url = req.url ?? '';
    if (url === '/api/v1/integrations/catalog') {
      res.writeHead(200);
      res.end(JSON.stringify(catalog));
      return;
    }
    if (url === '/api/v1/me/integrations') {
      res.writeHead(200);
      res.end(JSON.stringify(userList));
      return;
    }
    if (url === `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations`) {
      res.writeHead(200);
      res.end(JSON.stringify(workspaceList));
      return;
    }
    if (url.startsWith(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/`) && url.includes('/status')) {
      res.writeHead(200);
      res.end(JSON.stringify({ registrationHealth: registrationHealthFixture }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found', url }));
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate local integration-health server port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    workspaceId,
    receivedRequests,
    close: () => server.close(),
  };
}
