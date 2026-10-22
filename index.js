#!/usr/bin/env node
/**
 * relay-probe - test any OpenAI-compatible / Anthropic-compatible API endpoint
 *
 * Zero dependencies. Node 18+ (uses native fetch).
 *
 * Usage:
 *   npx relay-probe check  --url https://api.example.com --key sk-xxx --model claude-sonnet-4-5
 *   npx relay-probe tokens --url ... --key ... --model ...
 *   npx relay-probe bench  --url ... --key ... --model ... --n 10 --concurrency 3
 *   npx relay-probe all    --url ... --key ...
 *   npx relay-probe compare --targets targets.txt   (name | url | key | model)
 */

const VERSION = '0.3.0';
const fs = require('node:fs');

// ---------- args ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'check';

const URL_ARG = args.url || process.env.RELAY_URL;
const KEY_ARG = args.key || process.env.RELAY_KEY;
const MODEL_ARG = args.model || process.env.RELAY_MODEL || 'claude-sonnet-4-5';
const N = parseInt(args.n || '5', 10);
const CONC = parseInt(args.concurrency || '1', 10);
const TIMEOUT = parseInt(args.timeout || '30000', 10);
const JSON_OUT = !!args.json;
const PROTOCOL = String(args.protocol || 'auto').toLowerCase(); // auto | openai | anthropic

// ---------- colors ----------

const useColor = process.stdout.isTTY && !args['no-color'];
const c = {
  dim: s => useColor ? `\x1b[2m${s}\x1b[0m` : s,
  green: s => useColor ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: s => useColor ? `\x1b[33m${s}\x1b[0m` : s,
  red: s => useColor ? `\x1b[31m${s}\x1b[0m` : s,
  cyan: s => useColor ? `\x1b[36m${s}\x1b[0m` : s,
  bold: s => useColor ? `\x1b[1m${s}\x1b[0m` : s,
};

// ---------- url helpers ----------

/**
 * Normalize a base URL into { root, openai, anthropic }.
 * Accepts forms like:
 *   https://api.example.com
 *   https://api.example.com/
 *   https://api.example.com/v1
 *   https://api.example.com/v1/
 */
function normalizeBase(input) {
  let s = String(input).trim().replace(/\/+$/, '');
  const hadV1 = /\/v1$/.test(s);
  const root = hadV1 ? s.slice(0, -3) : s;
  return {
    root,
    openai: `${root}/v1`,
    anthropic: root,
    hadV1,
  };
}

/**
 * Send a chat request in the given protocol.
 *   openai    -> POST {base}/v1/chat/completions,  Authorization: Bearer
 *   anthropic -> POST {base}/v1/messages,          x-api-key + anthropic-version
 */
async function chatProto(proto, base, key, model, content, { maxTokens = 64, timeout = TIMEOUT } = {}) {
  if (proto === 'anthropic') {
    return callJson(`${base.root}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      }),
      timeout,
    });
  }
  return callJson(`${base.openai}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens,
    }),
    timeout,
  });
}

/** Extract a text reply and usage from either protocol's response shape. */
function extractReply(json, proto) {
  if (!json) return { text: '', usage: null, model: null };
  if (proto === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    return {
      text,
      usage: json.usage
        ? {
            pin: json.usage.input_tokens,
            pout: json.usage.output_tokens,
            ptotal: (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0),
            cached: json.usage.cache_read_input_tokens,
          }
        : null,
      model: json.model || null,
    };
  }
  const choice = json.choices && json.choices[0];
  const text = (choice && choice.message && choice.message.content) || '';
  const u = json.usage;
  return {
    text,
    usage: u
      ? { pin: u.prompt_tokens, pout: u.completion_tokens, ptotal: u.total_tokens,
          cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
                  (u.input_tokens_details && u.input_tokens_details.cache_read_input_tokens) }
      : null,
    model: json.model || null,
  };
}

/** Decide which protocol to use. */
async function detectProtocol(base, key) {
  if (PROTOCOL === 'openai' || PROTOCOL === 'anthropic') {
    record('protocol', 'ok', PROTOCOL + ' (forced via --protocol)');
    return PROTOCOL;
  }
  // auto: try the cheapest signal first
  const r = await callJson(`${base.openai}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    timeout: 12000,
  });
  if (r.status === 200 || r.status === 401) {
    record('protocol', 'ok', 'openai (detected: /v1/models responded ' + r.status + ')');
    return 'openai';
  }
  // try an anthropic-shaped probe
  const a = await callJson(`${base.root}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ARG, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    timeout: 12000,
  });
  if (a.status && a.status !== 404) {
    record('protocol', 'ok', 'anthropic (detected: /v1/messages responded ' + a.status + ')');
    return 'anthropic';
  }
  record('protocol', 'warn', 'could not detect; assuming openai');
  return 'openai';
}

// ---------- http ----------

async function callJson(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const ms = Date.now() - t0;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, ms, json, text };
  } catch (err) {
    const ms = Date.now() - t0;
    return {
      ok: false,
      status: 0,
      ms,
      json: null,
      text: '',
      error: err.name === 'AbortError' ? `timeout after ${timeout}ms` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- compare ----------

/**
 * Run `check` against every target in a file and print a comparison table.
 *
 * File format, one target per line, `#` starts a comment:
 *   name | url | key | model
 * Lines with 2 or 3 fields are accepted too (model / key optional).
 */
async function cmdCompare(file) {
  if (!file) {
    console.error(c.red('error:') + ' compare needs --targets <file>');
    console.error(c.dim('  file format: name | url | key | model'));
    process.exitCode = 1;
    return;
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(c.red('error:') + ` cannot read ${file}: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const targets = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const parts = l.split('|').map(s => s.trim());
      return { name: parts[0] || 'unnamed', url: parts[1] || '', key: parts[2] || '', model: parts[3] || '' };
    })
    .filter(t => t.url);

  if (!targets.length) {
    console.error(c.red('error:') + ' no usable targets in ' + file);
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const t of targets) {
    results.length = 0;
    activeProtocol = PROTOCOL === 'auto' ? 'openai' : PROTOCOL;
    const base = normalizeBase(t.url);
    const started = Date.now();
    try {
      await cmdCheck(base, t.key, t.model || t.name);
    } catch (e) {
      record('unexpected', 'bad', e.message);
    }
    const ms = Date.now() - started;
    const bad = results.filter(r => r.level === 'bad').length;
    const warn = results.filter(r => r.level === 'warn').length;
    const reach = results.find(r => r.name === 'reachability');
    const chat = results.find(r => r.name === 'chat completion');
    const lat = chat && chat.level === 'ok' ? (chat.message.match(/(\d+)ms/) || [])[1] : '';
    rows.push({
      name: t.name,
      verdict: bad ? 'FAIL' : warn ? 'WARN' : 'PASS',
      protocol: activeProtocol,
      reach: reach ? (reach.message.match(/HTTP (\d+)/) || [])[1] || '-' : '-',
      latency: lat || '-',
      checks: results.length,
      totalMs: ms,
    });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ command: 'compare', targets: rows }, null, 2));
    process.exitCode = rows.some(r => r.verdict === 'FAIL') ? 1 : 0;
    return;
  }

  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log('');
  console.log(c.bold('relay-probe compare') + c.dim(`  ${rows.length} targets`));
  console.log('');
  console.log('  ' + pad('name', 22) + pad('verdict', 9) + pad('proto', 11) + pad('reach', 7) + padL('chat', 8) + padL('checks', 8));
  console.log('  ' + '-'.repeat(65));
  for (const r of rows) {
    const raw = r.verdict;
    const coloured = r.verdict === 'PASS' ? c.green(raw) : r.verdict === 'WARN' ? c.yellow(raw) : c.red(raw);
    const cell = coloured + ' '.repeat(Math.max(0, 9 - raw.length));
    console.log('  ' + pad(r.name, 22) + cell + pad(r.protocol, 11) + pad(r.reach, 7) + padL(r.latency ? r.latency + 'ms' : '-', 8) + padL(r.checks, 8));
  }
  console.log('');
  process.exitCode = rows.some(r => r.verdict === 'FAIL') ? 1 : 0;
}

// ---------- report helpers ----------

const results = [];
let activeProtocol = 'openai';
function record(name, level, message) {
  results.push({ name, level, message });
}

function printResults() {
  if (JSON_OUT) return;
  const icon = { ok: c.green('[OK]'), warn: c.yellow('[!!]'), bad: c.red('[XX]'), info: c.dim('[--]') };
  for (const r of results) {
    console.log(`  ${icon[r.level]} ${r.name.padEnd(22)} ${r.message}`);
  }
}

// ---------- checks ----------

async function checkReach(base) {
  const r = await callJson(`${base.root}/`, { timeout: 15000 });
  if (r.error) {
    record('reachability', 'bad', `${r.error}`);
    return false;
  }
  record('reachability', 'ok', `HTTP ${r.status} in ${r.ms}ms`);
  return true;
}

async function checkModels(base, key) {
  const r = await callJson(`${base.openai}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    timeout: 20000,
  });

  if (r.status === 401) {
    record('auth', 'bad', '401 - key rejected (expected if you passed a dummy key)');
    return null;
  }
  if (r.status === 404) {
    record('models endpoint', 'warn', '404 - /v1/models not implemented (legal but uncommon)');
    return null;
  }
  if (!r.ok) {
    record('models endpoint', 'warn', `${r.status} ${r.error || ''}`.trim());
    return null;
  }
  const ids = (r.json?.data || []).map(m => m.id).filter(Boolean);
  record('models endpoint', 'ok', `${ids.length} model(s) listed in ${r.ms}ms`);
  return ids;
}

async function checkModelPresent(modelIds, model) {
  if (!modelIds) return;
  if (modelIds.includes(model)) {
    record('model listed', 'ok', model);
    return;
  }
  // try partial match
  const near = modelIds.filter(id => id.includes(model) || model.includes(id));
  if (near.length) {
    record('model listed', 'warn', `exact "${model}" not listed; closest: ${near.slice(0, 3).join(', ')}`);
  } else {
    record('model listed', 'bad', `"${model}" not in the list at all`);
  }
}

async function chat(base, key, model, content, opts = {}) {
  return chatProto(activeProtocol, base, key, model, content, opts);
}

async function checkChat(base, key, model) {
  const r = await chat(base, key, model, 'Reply with exactly: OK', { maxTokens: 16 });

  if (r.error) {
    record('chat completion', 'bad', r.error);
    return null;
  }
  if (!r.ok) {
    const msg =
      (r.json && r.json.error && r.json.error.message) || r.text.slice(0, 120);
    record('chat completion', 'bad', `HTTP ${r.status} - ${msg}`);
    return null;
  }

  const { text, usage, model: echoed } = extractReply(r.json, activeProtocol);
  record('chat completion', 'ok', `${r.ms}ms, ${text.length} chars back`);

  if (!text) {
    record('response shape', 'warn', 'reply text is empty');
  }

  // model echo
  if (echoed) {
    if (echoed === model) {
      record('model echo', 'ok', `response reports "${echoed}"`);
    } else {
      record('model echo', 'warn', `requested "${model}", response reports "${echoed}"`);
    }
  } else {
    record('model echo', 'warn', 'response has no model field');
  }

  // usage
  if (!usage) {
    record('usage block', 'bad', 'no usage{} - cannot verify billing');
  } else {
    const { pin, pout, ptotal } = usage;
    if (typeof pin !== 'number' || typeof pout !== 'number') {
      record('usage block', 'warn', 'usage present but missing input/output counts');
    } else {
      record('usage block', 'ok', `in=${pin} out=${pout}${ptotal !== undefined ? ` total=${ptotal}` : ''}`);
      if (ptotal !== undefined && Math.abs(pin + pout - ptotal) > 2) {
        record('usage math', 'warn', `in+out=${pin + pout} != total=${ptotal}`);
      } else if (ptotal !== undefined) {
        record('usage math', 'ok', 'in + out = total');
      }
      if (usage.cached !== undefined && usage.cached !== null) {
        record('cache accounting', 'ok', `cached tokens reported (${usage.cached})`);
      }
    }
  }

  return r;
}

async function checkTokenAccounting(base, key, model) {
  // 180-word English paragraph - deterministic-ish token count.
  const text = (
    'The quick brown fox jumps over the lazy dog. ' +
    'Pack my box with five dozen liquor jugs. ' +
    'How vexingly quick daft zebras jump. ' +
    'Sphinx of black quartz, judge my vow. ' +
    'Jackdaws love my big sphinx of quartz. ' +
    'The five boxing wizards jump quickly. ' +
    'Bright vixens jump; dozy fowl quack. ' +
    'Quick zephyrs blow, vexing daft Jim. ' +
    'Two driven jocks help fax my big quiz. ' +
    'Waltz, bad nymph, for quick jigs vex. '
  ).repeat(3);

  const r = await chat(base, key, model, text, { maxTokens: 8 });
  if (!r.ok) {
    record('token accounting', 'bad', r.error || `HTTP ${r.status}`);
    return;
  }
  const u = extractReply(r.json, activeProtocol).usage;
  const pin = u ? u.pin : undefined;
  if (typeof pin !== 'number') {
    record('token accounting', 'bad', 'no input token count in usage');
    return;
  }
  // ~10 chars/token for this English text → expected ~90 for 900 chars
  const chars = text.length;
  const expected = Math.round(chars / 4); // English ~ 4 chars/token
  const ratio = pin / expected;
  const pct = Math.round((ratio - 1) * 100);

  if (ratio >= 0.75 && ratio <= 1.3) {
    record('token accounting', 'ok', `reported ${pin}, expected ~${expected} (${pct >= 0 ? '+' : ''}${pct}%)`);
  } else if (ratio > 1.3) {
    record('token accounting', 'bad', `reported ${pin} vs expected ~${expected} - ${pct}% inflation`);
  } else {
    record('token accounting', 'warn', `reported ${pin} vs expected ~${expected} - ${pct}% (undercounting?)`);
  }
}

async function bench(base, key, model, n, concurrency) {
  const lat = [];
  let errors = 0;
  const prompt = 'Say OK.';

  async function one() {
    const r = await chat(base, key, model, prompt, { maxTokens: 8 });
    if (r.ok) lat.push(r.ms);
    else errors++;
  }

  const queue = Array.from({ length: n }, () => one);
  const workers = Array.from({ length: Math.min(concurrency, n) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (job) await job();
    }
  });
  const t0 = Date.now();
  await Promise.all(workers);
  const wall = Date.now() - t0;

  lat.sort((a, b) => a - b);
  const pct = p => lat.length ? lat[Math.min(lat.length - 1, Math.max(0, Math.ceil(lat.length * p) - 1))] : null;

  if (!lat.length) {
    record('bench', 'bad', `${errors}/${n} failed`);
    return;
  }
  record('bench', errors ? 'warn' : 'ok',
    `${lat.length}/${n} ok in ${wall}ms (concurrency ${concurrency})`);
  record('latency', 'ok',
    `min ${lat[0]}ms · p50 ${pct(0.5)}ms · p95 ${pct(0.95)}ms · max ${lat[lat.length - 1]}ms`);
  if (errors) record('errors', 'warn', `${errors}/${n} requests failed`);
}

async function checkStreaming(base, key, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  const t0 = Date.now();
  let firstChunkMs = null;
  let chunks = 0;
  try {
    const isA = activeProtocol === 'anthropic';
    const url = isA ? `${base.root}/v1/messages` : `${base.openai}/chat/completions`;
    const headers = isA
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
      : { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const payload = isA
      ? { model, max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'Count 1 to 5.' }] }
      : { model, max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'Count 1 to 5.' }] };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      record('streaming', 'warn', `HTTP ${res.status} - stream not accepted`);
      return;
    }
    const reader = res.body && res.body.getReader();
    if (!reader) { record('streaming', 'warn', 'no response body'); return; }
    const dec = new TextDecoder();
    const needle = isA ? 'event:' : 'data:';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunkMs === null) firstChunkMs = Date.now() - t0;
      chunks += (dec.decode(value).match(new RegExp(needle, 'g')) || []).length;
    }
    record('streaming', 'ok', `first chunk ${firstChunkMs}ms, ${chunks} event(s)`);
  } catch (e) {
    record('streaming', 'warn', e.name === 'AbortError' ? 'timeout' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- commands ----------

async function cmdCheck(base, key, model) {
  const reachable = await checkReach(base);
  if (!reachable) return;
  activeProtocol = await detectProtocol(base, key);
  if (activeProtocol === 'openai') {
    const ids = await checkModels(base, key);
    await checkModelPresent(ids, model);
  }
  // anthropic protocol has no /v1/models - nothing to check, don't emit a warning
  await checkChat(base, key, model);
}

async function cmdTokens(base, key, model) {
  activeProtocol = await detectProtocol(base, key);
  await checkChat(base, key, model);
  await checkTokenAccounting(base, key, model);
}

async function cmdBench(base, key, model) {
  activeProtocol = await detectProtocol(base, key);
  await bench(base, key, model, N, CONC);
}

async function cmdAll(base, key, model) {
  await checkReach(base);
  activeProtocol = await detectProtocol(base, key);
  if (activeProtocol === 'openai') {
    const ids = await checkModels(base, key);
    await checkModelPresent(ids, model);
  }
  // anthropic protocol has no /v1/models
  await checkChat(base, key, model);
  await checkTokenAccounting(base, key, model);
  await checkStreaming(base, key, model);
  await bench(base, key, model, N, CONC);
}

// ---------- main ----------

function usage() {
  console.log(`
${c.bold('relay-probe')} ${c.dim('v' + VERSION)} - test any OpenAI-compatible API endpoint

${c.bold('Usage')}
  relay-probe <command> --url <endpoint> --key <api-key> [options]

${c.bold('Commands')}
  check     reachability · auth · model list · model echo · usage block
  tokens    token accounting (detects billing inflation)
  bench     latency percentiles, supports concurrency
  all       everything above

${c.bold('Options')}
  --url <url>            endpoint, with or without /v1
  --key <key>            API key (or RELAY_KEY env)
  --model <name>         model to test (default claude-sonnet-4-5)
  --n <count>            requests for bench (default 5)
  --concurrency <n>      parallel requests for bench (default 1)
  --timeout <ms>         per-request timeout (default 30000)
  --protocol <p>         auto | openai | anthropic (default auto)
  --json                 machine-readable output
  --no-color             disable colors

${c.bold('Examples')}
  relay-probe check --url https://api.example.com --key sk-xxx

  relay-probe bench --url https://api.example.com/v1 --key sk-xxx \\
    --model gpt-4o-mini --n 20 --concurrency 5

  # Claude Code style native Anthropic endpoint
  relay-probe check --url https://api.example.com --key sk-ant-xxx \\
    --model claude-sonnet-4-5 --protocol anthropic

  # test several endpoints at once and print a comparison table
  relay-probe compare --targets targets.txt
  # targets.txt:  name | url | key | model

${c.bold('Env vars')}
  RELAY_URL, RELAY_KEY, RELAY_MODEL

${c.dim('Exit codes: 0 = all checks passed, 1 = at least one failure')}
`);
}

async function main() {
  if (args.help || args.h || cmd === 'help') { usage(); return; }
  if (args.version || args.v) { console.log(VERSION); return; }

  // compare mode takes its targets from a file, no --url needed
  if (cmd === 'compare') {
    await cmdCompare(args.targets || args.file);
    return;
  }

  if (!URL_ARG) {
    console.error(c.red('error:') + ' --url is required (or set RELAY_URL)');
    console.error(c.dim('run: relay-probe --help'));
    process.exitCode = 1;
    return;
  }

  const needsKey = cmd !== 'check' || !!KEY_ARG;
  if (cmd !== 'check' && !KEY_ARG) {
    console.error(c.red('error:') + ` --key is required for "${cmd}" (or set RELAY_KEY)`);
    process.exitCode = 1;
    return;
  }

  const base = normalizeBase(URL_ARG);

  if (!JSON_OUT) {
    console.log('');
    console.log(c.bold('relay-probe') + c.dim(` v${VERSION}`));
    console.log(c.dim('  endpoint  ') + base.root + (base.hadV1 ? c.dim('  (trailing /v1 normalized)') : ''));
    console.log(c.dim('  openai    ') + base.openai);
    console.log(c.dim('  protocol  ') + PROTOCOL);
    console.log(c.dim('  model     ') + MODEL_ARG);
    console.log('');
  }

  const t0 = Date.now();
  try {
    if (cmd === 'check') await cmdCheck(base, KEY_ARG, MODEL_ARG);
    else if (cmd === 'tokens') await cmdTokens(base, KEY_ARG, MODEL_ARG);
    else if (cmd === 'bench') await cmdBench(base, KEY_ARG, MODEL_ARG);
    else if (cmd === 'all') await cmdAll(base, KEY_ARG, MODEL_ARG);
    else {
      console.error(c.red('error:') + ` unknown command "${cmd}"`);
      usage();
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    record('unexpected', 'bad', e.message);
  }

  const elapsed = Date.now() - t0;
  const bad = results.filter(r => r.level === 'bad').length;
  const warn = results.filter(r => r.level === 'warn').length;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      endpoint: base.root,
      model: MODEL_ARG,
      command: cmd,
      elapsedMs: elapsed,
      verdict: bad ? 'bad' : warn ? 'warn' : 'ok',
      results,
    }, null, 2));
  } else {
    printResults();
    console.log('');
    const verdict = bad ? c.red('FAILED') : warn ? c.yellow('PASSED WITH WARNINGS') : c.green('ALL PASSED');
    console.log(`  ${verdict}  ${c.dim(`${results.length} checks in ${elapsed}ms`)}`);
    console.log('');
  }

  process.exitCode = bad ? 1 : 0;
}

main();
