/**
 * Local mock Codex-backend model server for CI determinism.
 *
 * The Workforce live-model path calls:
 *   POST ${CODEX_BACKEND_BASE_URL}/responses
 * with a JSON body and expects a text/event-stream (SSE) response.
 *
 * Set the following env vars to redirect live model calls here without any paid
 * or external credential:
 *   CODEX_BACKEND_BASE_URL=<this server url>/backend-api/codex
 *   CODEX_OAUTH_CREDENTIAL=dummy-mock-credential
 *
 * Request shape expected by the Workforce live adapter:
 *   { model, input:[{type:"message",role:"user",content:[{type:"input_text",text:...}]}],
 *     stream:true, max_output_tokens, tools:[], instructions:"" }
 *
 * Response shape (SSE):
 *   data: {"type":"response.output_text.delta","delta":"..."}\n\n
 *   data: {"type":"response.completed"}\n\n
 *   data: [DONE]\n\n
 */
import http from 'node:http';

function extractPromptText(body) {
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const messages = Array.isArray(parsed.input) ? parsed.input : [];
    for (const msg of messages) {
      const parts = Array.isArray(msg.content) ? msg.content : [];
      for (const part of parts) {
        if (part.type === 'input_text' && typeof part.text === 'string') {
          return part.text;
        }
      }
    }
  } catch {
    // ignore parse errors
  }
  return '';
}

function makeDeterministicDelta(promptText) {
  // Digest-summarization path: return compact JSON with theme + story notes.
  if (promptText.includes('"id"') && promptText.includes('"title"') && promptText.includes('"why"')) {
    return JSON.stringify({
      theme: 'Background coding agents and multi-agent coordination are the leading signals this cycle.',
      stories: [
        { id: 1001, why: 'Adds background agents to Claude Code; direct relevance to coding-agent runtime isolation.' },
        { id: 1002, why: 'Demonstrates durable memory patterns for long-running agentic workflows.' },
        { id: 1003, why: 'Proposes a handoff protocol between heterogeneous agents — worth tracking for MCP.' },
      ],
    });
  }

  // Q&A / conversational path.
  return 'Based on the recent HN digest, story #1 covers Claude Code background coding agents. The HN community highlighted sandbox isolation and retry semantics as key implementation challenges.';
}

function writeSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function createModelMockServer() {
  const counts = {
    total: 0,
    requests: [],
  };

  const server = http.createServer((req, res) => {
    // Only handle POST /backend-api/codex/responses
    if (req.method !== 'POST' || req.url !== '/backend-api/codex/responses') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `No mock route for ${req.method} ${req.url}` }));
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      counts.total += 1;
      counts.requests.push({ method: req.method, path: req.url, bodyLength: rawBody.length });

      const promptText = extractPromptText(rawBody);
      const delta = makeDeterministicDelta(promptText);

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      // Emit text delta, then completion, then DONE.
      writeSSE(res, { type: 'response.output_text.delta', delta });
      writeSSE(res, { type: 'response.completed' });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate local model mock server port');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    // CODEX_BACKEND_BASE_URL should be set to `${codexBase}` so the adapter
    // calls `${codexBase}/responses`.
    codexBase: `${baseUrl}/backend-api/codex`,
    mockCredential: 'dummy-mock-oauth-credential',
    counts,
    close: () => server.close(),
  };
}
