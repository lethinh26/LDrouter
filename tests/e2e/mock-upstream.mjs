// Mock upstream LLM provider for E2E tests.
// Serves OpenAI-compatible /v1/models + chat completions so the gateway's
// discovery / probe / routing flows can run genuinely through the admin UI.
import http from 'node:http';

const MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'embedding-model'];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    res.statusCode = 200;
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      object: 'list',
      data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock' })),
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      const model = parsed.model ?? 'gpt-4o-mini';
      if (parsed.stream) {
        res.setHeader('content-type', 'text/event-stream');
        res.write(`data: {"id":"mock-1","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n`);
        res.write(`data: {"id":"mock-1","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[{"index":0,"delta":{"content":"Hello from "},"finish_reason":null}]}\n\n`);
        res.write(`data: {"id":"mock-1","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[{"index":0,"delta":{"content":"mock upstream"},"finish_reason":null}]}\n\n`);
        res.write(`data: {"id":"mock-1","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'mock-1', object: 'chat.completion', created: 0, model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from mock upstream' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: `no mock route ${req.method} ${url.pathname}` } }));
});

const port = Number(process.env.MOCK_PORT ?? 8791);
server.listen(port, '127.0.0.1', () => {
  console.log(`mock-upstream listening on http://127.0.0.1:${port}`);
});