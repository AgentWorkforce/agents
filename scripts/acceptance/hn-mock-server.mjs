/**
 * Local mock HN Algolia API server for CI determinism.
 *
 * Serves fixture files from hn-monitor/fixtures/ at paths matching the
 * real HN Algolia API, so live-read cases can target this server instead
 * of the external network.  Tracks per-route request counts for assertion.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, '..', '..', 'hn-monitor', 'fixtures');

function readFixture(name) {
  return readFileSync(resolve(fixtureRoot, name), 'utf8');
}

export async function createHnMockServer() {
  const counts = {
    frontPage: 0,
    showHn: 0,
    newStories: 0,
    items: {},
    titleSearch: 0,
    total: 0,
    requests: [],
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    counts.total += 1;
    counts.requests.push({ method: req.method, path: url.pathname, search: url.search });

    res.setHeader('content-type', 'application/json');

    // /api/v1/items/:id
    const itemMatch = url.pathname.match(/^\/api\/v1\/items\/(\d+)$/u);
    if (itemMatch) {
      const id = itemMatch[1];
      counts.items[id] = (counts.items[id] ?? 0) + 1;
      const fixtureName = `hn-item-${id}.json`;
      let content;
      try {
        content = readFixture(fixtureName);
      } catch {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `no fixture for item ${id}` }));
        return;
      }
      res.writeHead(200);
      res.end(content);
      return;
    }

    // /api/v1/search_by_date or /api/v1/search — match by tags param
    if (url.pathname === '/api/v1/search' || url.pathname === '/api/v1/search_by_date') {
      const tags = url.searchParams.get('tags');
      const restrict = url.searchParams.get('restrictSearchableAttributes');

      if (restrict === 'title') {
        counts.titleSearch += 1;
        res.writeHead(200);
        res.end(readFixture('hn-european-title-search.json'));
        return;
      }
      if (tags === 'front_page') {
        counts.frontPage += 1;
        res.writeHead(200);
        res.end(readFixture('hn-front-page.json'));
        return;
      }
      if (tags === 'show_hn') {
        counts.showHn += 1;
        res.writeHead(200);
        res.end(readFixture('hn-show-hn.json'));
        return;
      }
      if (tags === 'story') {
        counts.newStories += 1;
        res.writeHead(200);
        res.end(readFixture('hn-new.json'));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify({ hits: [] }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate local HN mock server port');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    counts,
    close: () => server.close(),
  };
}
