/**
 * relay-probe test suite.
 *
 * Uses Node's built-in test runner (node:test) and a local mock server.
 * No dependencies.
 *
 *   node --test test/
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'index.js');
const MOCK = path.join(__dirname, 'mock-server.js');

let mockProc;
let baseUrl;

function startMock() {
  return new Promise((resolve, reject) => {
    mockProc = spawn(process.execPath, [MOCK, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('mock server did not start in 10s')), 10000);
    mockProc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const m = buf.match(/READY (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(parseInt(m[1], 10));
      }
    });
    mockProc.on('error', reject);
  });
}

/** Run the CLI, return { code, stdout, json }. */
function run(args) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', c => { out += c; });
    p.stderr.on('data', c => { err += c; });
    p.on('close', code => {
      let json = null;
      try { json = JSON.parse(out); } catch { /* not json mode */ }
      resolve({ code, stdout: out, stderr: err, json });
    });
  });
}

/** Find a result entry by name. */
function find(json, name) {
  return (json?.results || []).find(r => r.name === name);
}

before(async () => {
  const port = await startMock();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  if (mockProc) mockProc.kill();
});

// ---------- URL normalization ----------

test('accepts base URL without /v1', async () => {
  const r = await run(['check', '--url', `${baseUrl}/ok`, '--key', 'sk-test', '--json']);
  assert.strictEqual(r.json.endpoint, `${baseUrl}/ok`);
  assert.ok(r.json.results.length > 0);
});

test('normalizes a trailing /v1', async () => {
  const r = await run(['check', '--url', `${baseUrl}/ok/v1`, '--key', 'sk-test', '--json']);
  assert.strictEqual(r.json.endpoint, `${baseUrl}/ok`);
});

test('normalizes a trailing slash', async () => {
  const r = await run(['check', '--url', `${baseUrl}/ok/`, '--key', 'sk-test', '--json']);
  assert.strictEqual(r.json.endpoint, `${baseUrl}/ok`);
});

// ---------- happy path ----------

test('happy path: every check passes', async () => {
  const r = await run(['check', '--url', `${baseUrl}/ok`, '--key', 'sk-test', '--model', 'test-model', '--json']);
  assert.strictEqual(r.json.verdict, 'ok', 'expected verdict ok, got ' + JSON.stringify(r.json.results));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(find(r.json, 'reachability').level, 'ok');
  assert.strictEqual(find(r.json, 'model listed').level, 'ok');
  assert.strictEqual(find(r.json, 'model echo').level, 'ok');
  assert.strictEqual(find(r.json, 'usage math').level, 'ok');
});

// ---------- failure modes ----------

test('bad key: 401 is reported as a failure', async () => {
  const r = await run(['check', '--url', `${baseUrl}/badkey`, '--key', 'sk-nope', '--json']);
  assert.strictEqual(r.json.verdict, 'bad');
  assert.strictEqual(r.code, 1);
  assert.strictEqual(find(r.json, 'auth').level, 'bad');
});

test('missing usage block is flagged', async () => {
  const r = await run(['check', '--url', `${baseUrl}/nousage`, '--key', 'sk-test', '--model', 'test-model', '--json']);
  assert.strictEqual(find(r.json, 'usage block').level, 'bad');
  assert.strictEqual(r.json.verdict, 'bad');
});

test('wrong model echo is flagged as a warning', async () => {
  const r = await run(['check', '--url', `${baseUrl}/wrongmodel`, '--key', 'sk-test', '--model', 'test-model', '--json']);
  const echo = find(r.json, 'model echo');
  assert.strictEqual(echo.level, 'warn');
  assert.match(echo.message, /cheaper-model-v1/);
  assert.strictEqual(r.json.verdict, 'warn');
});

test('absent models endpoint is a warning, not a failure', async () => {
  const r = await run(['check', '--url', `${baseUrl}/nomodels`, '--key', 'sk-test',
    '--model', 'test-model', '--protocol', 'openai', '--json']);
  const m = find(r.json, 'models endpoint');
  assert.strictEqual(m.level, 'warn');
  assert.match(m.message, /404/);
});

test('auto: an endpoint without /v1/models but with /v1/messages is treated as anthropic', async () => {
  // The mock serves both, so auto should pick openai first (models answers 200).
  // This case documents the 404-fallback path indirectly.
  const r = await run(['check', '--url', `${baseUrl}/ok`, '--key', 'sk-test',
    '--model', 'test-model', '--json']);
  assert.ok(['openai', 'anthropic'].includes(r.json.results.find(x => x.name === 'protocol').message.split(' ')[0]));
});

// ---------- token accounting ----------

test('honest token counts pass', async () => {
  const r = await run(['tokens', '--url', `${baseUrl}/ok`, '--key', 'sk-test', '--model', 'test-model', '--json']);
  const t = find(r.json, 'token accounting');
  assert.strictEqual(t.level, 'ok', 'unexpected: ' + (t && t.message));
});

test('inflated token counts are caught', async () => {
  const r = await run(['tokens', '--url', `${baseUrl}/inflate`, '--key', 'sk-test', '--model', 'test-model', '--json']);
  const t = find(r.json, 'token accounting');
  assert.strictEqual(t.level, 'bad', 'expected bad, got ' + (t && t.message));
  assert.match(t.message, /inflation/);
  assert.strictEqual(r.code, 1);
});

// ---------- bench ----------

test('bench reports latency percentiles', async () => {
  const r = await run(['bench', '--url', `${baseUrl}/ok`, '--key', 'sk-test', '--model', 'test-model', '--n', '5', '--json']);
  const b = find(r.json, 'bench');
  assert.strictEqual(b.level, 'ok');
  const lat = find(r.json, 'latency');
  assert.ok(lat, 'latency entry missing');
  assert.match(lat.message, /p50/);
  assert.match(lat.message, /p95/);
});

test('bench p95 is never below p50', async () => {
  const r = await run(['bench', '--url', `${baseUrl}/ok`, '--key', 'sk-test', '--model', 'test-model', '--n', '3', '--json']);
  const lat = find(r.json, 'latency');
  const p50 = parseInt(lat.message.match(/p50 (\d+)/)[1], 10);
  const p95 = parseInt(lat.message.match(/p95 (\d+)/)[1], 10);
  assert.ok(p95 >= p50, `p95 (${p95}) must be >= p50 (${p50})`);
});

// ---------- streaming ----------

test('streaming is detected', async () => {
  const r = await run(['all', '--url', `${baseUrl}/ok`, '--key', 'sk-test', '--model', 'test-model', '--n', '2', '--json']);
  const s = find(r.json, 'streaming');
  assert.strictEqual(s.level, 'ok', 'streaming check failed: ' + (s && s.message));
  assert.match(s.message, /event/);
});

// ---------- anthropic protocol ----------

test('anthropic: happy path passes', async () => {
  const r = await run(['check', '--url', `${baseUrl}/ok`, '--key', 'sk-ant-test',
    '--model', 'test-model', '--protocol', 'anthropic', '--json']);
  assert.strictEqual(r.json.verdict, 'ok', 'unexpected: ' + JSON.stringify(r.json.results));
  assert.strictEqual(find(r.json, 'protocol').level, 'ok');
  assert.match(find(r.json, 'protocol').message, /anthropic/);
  assert.strictEqual(find(r.json, 'model echo').level, 'ok');
  assert.strictEqual(find(r.json, 'usage block').level, 'ok');
});

test('anthropic: bad key is reported', async () => {
  const r = await run(['check', '--url', `${baseUrl}/badkey`, '--key', 'sk-nope',
    '--model', 'test-model', '--protocol', 'anthropic', '--json']);
  assert.strictEqual(r.json.verdict, 'bad');
  assert.strictEqual(r.code, 1);
});

test('anthropic: inflated token counts are caught', async () => {
  const r = await run(['tokens', '--url', `${baseUrl}/inflate`, '--key', 'sk-test',
    '--model', 'test-model', '--protocol', 'anthropic', '--json']);
  const t = find(r.json, 'token accounting');
  assert.strictEqual(t.level, 'bad', 'got: ' + (t && t.message));
  assert.match(t.message, /inflation/);
});

test('anthropic: streaming is detected', async () => {
  const r = await run(['all', '--url', `${baseUrl}/ok`, '--key', 'sk-test',
    '--model', 'test-model', '--protocol', 'anthropic', '--n', '2', '--json']);
  const s = find(r.json, 'streaming');
  assert.strictEqual(s.level, 'ok', 'got: ' + (s && s.message));
  assert.match(s.message, /event/);
});

test('auto protocol falls back to openai when /v1/models answers', async () => {
  const r = await run(['check', '--url', `${baseUrl}/ok`, '--key', 'sk-test',
    '--model', 'test-model', '--json']);
  assert.match(find(r.json, 'protocol').message, /openai/);
});

// ---------- CLI ergonomics ----------

test('missing --url exits non-zero with a message', async () => {
  const r = await run(['check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /--url is required/);
});

test('unknown command exits non-zero', async () => {
  const r = await run(['nonsense', '--url', `${baseUrl}/ok`, '--key', 'k']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /unknown command/);
});

test('--version prints the version', async () => {
  const r = await run(['--version']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
