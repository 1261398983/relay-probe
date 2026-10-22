/**
 * Mock [OI]-compatible server for relay-probe tests.
 *
 * Writes nothing to disk. Start with: node test/mock-server.js <port>
 * Prints "READY <port>" on stdout once listening.
 *
 * Behaviour is switched by the path prefix:
 *   /ok/*        — everything works, honest token counts
 *   /badkey/*    — always 401
 *   /inflate/*   — reports prompt_tokens 3x too high
 *   /nousage/*   — omits usage block
 *   /wrongmodel/*— echoes a different model name than requested
 *   /nomodels/*  — /v1/models returns 404
 */

const http = require('http');

const PORT = parseInt(process.argv[2] || '0', 10);

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const mode = url.split('/')[1] || 'ok';

  // root
  if (url === '/' || url === '') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('mock relay');
  }

  // /v1/models
  if (url.endsWith('/models')) {
    if (mode === 'badkey') return send(res, 401, { error: { message: 'bad key' } });
    if (mode === 'nomodels') return send(res, 404, { error: { message: 'not found' } });
    return send(res, 200, {
      object: 'list',
      data: [
        { id: 'test-model', object: 'model' },
        { id: 'test-model-lite', object: 'model' },
        { id: 'other-model', object: 'model' },
      ],
    });
  }

  // /v1/chat/completions
  if (url.endsWith('/chat/completions')) {
    if (mode === 'badkey') return send(res, 401, { error: { message: 'bad key' } });

    const raw = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(raw || '{}'); } catch { /* ignore */ }

    const requestedModel = parsed.model || 'test-model';

    // Streaming
    if (parsed.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: {"choices":[{"delta":{"content":"1"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"2"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Estimate prompt tokens from the message content length (~4 chars/token)
    const content = (parsed.messages || [])
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join(' ');
    const honestPrompt = Math.max(1, Math.round(content.length / 4));

    let promptTokens = honestPrompt;
    if (mode === 'inflate') promptTokens = honestPrompt * 3;

    const body = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: mode === 'wrongmodel' ? 'cheaper-model-v1' : requestedModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'OK' },
          finish_reason: 'stop',
        },
      ],
    };

    if (mode !== 'nousage') {
      body.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: 2,
        total_tokens: promptTokens + 2,
      };
    }

    return send(res, 200, body);
  }

  send(res, 404, { error: { message: 'unknown path: ' + url } });
});

server.listen(PORT, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log('READY ' + actual);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
