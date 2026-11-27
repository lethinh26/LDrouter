// CI only. The companion launcher establishes network and PID namespaces
// before ANY client execution. This never performs a real login or API call.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFile, readlink, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';
const { Headers, Request, Response } = globalThis;

const CODEX_VERSION = '0.172.0';
const CLAUDE_VERSION = '2.1.326';
const CODEX_ORIGIN = 'https://chatgpt.com';
const CLAUDE_ORIGIN = 'https://api.anthropic.com';
const CODEX_PATH = '/backend-api/codex';
const CODEX_BEARER = 'fixture-codex-env-key-only';
const CLAUDE_UPSTREAM_KEY = 'sk-ant-api-fixture-cli-only';
const CODEX_A = 'fixture-codex-a';
const CODEX_B = 'fixture-codex-b';
const CODEX_HIDDEN = 'fixture-codex-hidden';
const CODEX_ALIAS = 'native-cli-fixture';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_PUBLIC = 'claude-cli/' + CLAUDE_MODEL;
const CODEX_ANSWER = 'CODEX_CLI_FIXTURE_OK';
const CLAUDE_ANSWER = 'CLAUDE_CLI_FIXTURE_OK';
const CODEX_PROMPT = 'Reply with ' + CODEX_ANSWER + '. Do not use tools.';
const CLAUDE_PROMPT = 'Reply with ' + CLAUDE_ANSWER + '. Do not use tools.';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const [root, prefix] = process.argv.slice(2);
const maxOutput = 32 * 1024 * 1024;

function parseCliJson(value, stage) {
  try { return JSON.parse(value); } catch { throw new Error('Invalid CLI JSON: ' + stage); }
}

// Fail closed even if invoked directly. Verify actual kernel state, not just
// an environment sentinel.
assert(process.platform === 'linux' && process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true',
  'Use the CI namespace launcher');
assert(typeof process.getuid === 'function' && process.getuid() !== 0, 'Clients must not run as root');
assert(process.env.LD_CLI_PARENT_NET && process.env.LD_CLI_PARENT_PID, 'Missing namespace provenance');
assert.notEqual(await readlink('/proc/self/ns/net'), process.env.LD_CLI_PARENT_NET, 'Host network namespace');
assert.notEqual(await readlink('/proc/self/ns/pid'), process.env.LD_CLI_PARENT_PID, 'Host PID namespace');
assert.equal(process.pid, 1, 'Fixture must be the isolated PID namespace init');
const networkDevices = (await readFile('/proc/net/dev', 'utf8')).split('\n')
  .filter(line => line.includes(':')).map(line => line.split(':')[0].trim());
assert.deepEqual(networkDevices, ['lo'], 'Non-loopback network device exists');
const status = await readFile('/proc/self/status', 'utf8');
assert(/^CapEff:\s+0+$/m.test(status) && /^CapBnd:\s+0+$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status),
  'Fixture must have no capabilities and no privilege escalation');
assert(root && prefix && path.isAbsolute(root) && path.isAbsolute(prefix));
assert.equal(process.cwd(), root);
assert.equal(process.env.HOME, root);
assert.deepEqual(await readdir(root), [], 'Fixture root must be newly created and empty');

const binaries = Object.fromEntries(['codex', 'claude'].map(name => [name, path.join(prefix, 'node_modules', '.bin', name)]));
for (const [pkg, version] of [['@openai/codex', CODEX_VERSION], ['@anthropic-ai/claude-code', CLAUDE_VERSION]]) {
  const manifest = JSON.parse(await readFile(path.join(prefix, 'node_modules', pkg, 'package.json'), 'utf8'));
  assert.equal(manifest.name, pkg);
  assert.equal(manifest.version, version, 'Install the pinned official client packages');
}

// Explicit environment allowlist: no proxy, credentials, auth files, agent
// sockets or project config are inherited. Each client has its own empty cwd.
async function clientHome(name) {
  const home = path.join(root, name, 'home');
  const cwd = path.join(root, name, 'work');
  const tmp = path.join(root, name, 'tmp');
  const runtime = path.join(home, 'xdg-runtime');
  const xdg = Object.fromEntries(['CONFIG', 'CACHE', 'DATA', 'STATE'].map(
    kind => ['XDG_' + kind + '_HOME', path.join(home, 'xdg-' + kind.toLowerCase())]));
  for (const dir of [home, cwd, tmp, runtime, ...Object.values(xdg)]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: tmp, LANG: 'C.UTF-8', TERM: 'dumb',
    CI: 'true', NO_COLOR: '1', ...xdg, XDG_RUNTIME_DIR: runtime,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + path.join(runtime, 'absent-bus'),
  };
  return { home, cwd, env };
}

// No shell or inherited stdin. Bound output and subprocess duration; terminate
// the exact child process group on failure. PID namespace teardown covers any
// descendants that escape a process group.
function runCli(name, args, context, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaries[name], args, {
      cwd: context.cwd, env: context.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bytes = 0, failure = null;
    const stdout = [];
    let diagnostic = '';
    function stop(reason) {
      failure ??= reason;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    const timer = setTimeout(() => stop('timed out'), timeoutMs);
    function collect(chunk, retain) {
      bytes += chunk.length;
      if (bytes > maxOutput) stop('exceeded output limit');
      else if (retain) stdout.push(chunk);
    }
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => {
      collect(chunk, false);
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096);
    });
    child.on('error', error => { failure ??= 'spawn error: ' + error.code; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        // Classify common errors without printing raw output (which can
        // contain credentials, provider payloads, or catalog templates).
        const category = /unknown (argument|option)|unexpected argument|unrecognized option/i.test(diagnostic) ? 'unsupported CLI option'
          : /authentication|unauthorized|401|403/i.test(diagnostic) ? 'authentication/authorization'
            : /connection|network|timed out|failed to connect/i.test(diagnostic) ? 'network/timeout'
              : /parse|deserializ|invalid json/i.test(diagnostic) ? 'protocol parsing' : 'other CLI failure';
        reject(new Error(name + ' ' + args[0] + ': ' + (failure ?? ('exit=' + code + ', signal=' + signal)) + ' (' + category + ')'));
      } else resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

const bundledClient = await clientHome('bundled');
bundledClient.env.CODEX_HOME = path.join(bundledClient.home, '.codex');
const codexVersion = await runCli('codex', ['--version'], bundledClient);
assert(codexVersion.trim().endsWith(CODEX_VERSION), 'Unexpected Codex binary version');
const claude = await clientHome('claude');
claude.env.CLAUDE_CONFIG_DIR = path.join(claude.home, '.claude');
const claudeVersion = await runCli('claude', ['--version'], claude);
assert(claudeVersion.trim().startsWith(CLAUDE_VERSION), 'Unexpected Claude binary version');

// Use the exact pinned binary's bundled catalog shape, not a guessed schema.
// No credentials or provider config are supplied to this diagnostic command.
const bundled = parseCliJson(await runCli('codex', ['debug', 'models', '--bundled'], bundledClient), 'bundled catalog');
const template = bundled.models?.find(model => model.visibility === 'list' && model.supported_in_api === true
  && Number.isSafeInteger(model.context_window) && model.context_window > 0
  && Array.isArray(model.supported_reasoning_levels) && model.supported_reasoning_levels.length > 0);
assert(template, 'Pinned Codex bundled catalog has no usable API model');
const catalog = [CODEX_A, CODEX_B, CODEX_HIDDEN].map((slug, priority) => ({
  ...template, slug, display_name: slug, description: 'Synthetic test model', priority, upgrade: null,
}));

function sse(events, requestId) {
  return new Response(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''),
    { headers: { 'content-type': 'text/event-stream', 'x-request-id': requestId } });
}

function codexReply(model) {
  const item = { type: 'message', id: 'msg_cli_codex', role: 'assistant', status: 'completed', phase: 'final_answer',
    content: [{ type: 'output_text', text: CODEX_ANSWER, annotations: [] }] };
  const response = { id: 'resp_cli_codex', object: 'response', created_at: 0, model, status: 'in_progress', output: [] };
  return sse([
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: CODEX_ANSWER },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: CODEX_ANSWER },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...response, status: 'completed', end_turn: true, output: [item],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } },
  ].map((event, sequence_number) => ({ ...event, sequence_number })), 'fixture-codex-upstream');
}

function claudeReply(model) {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 };
  const message = { id: 'msg_cli_claude', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: CLAUDE_ANSWER }],
    stop_reason: 'end_turn', stop_sequence: null, usage };
  return sse([
    { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: CLAUDE_ANSWER } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ], 'fixture-claude-upstream');
}

const observed = { codexCatalog: 0, codexResponses: 0, claudeCatalog: 0, claudeMessages: 0, claudeCount: 0 };
const fixtureViolations = [];
// Install the exact method/origin/path allowlist BEFORE loading the built
// app. No real fetch fallback. Only upstream I/O is substituted.
globalThis.fetch = async (input, init) => {
  try {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = JSON.parse(String(init?.body ?? '{}'));
    assert(!url.username && !url.password && !url.hash && init?.redirect === 'error', 'Unsafe upstream destination');
    if (url.origin === CODEX_ORIGIN) {
      assert(headers.get('authorization') === 'Bearer ' + CODEX_BEARER, 'Wrong Codex fixture bearer');
      assert(!headers.has('x-api-key') && !headers.has('chatgpt-account-id'), 'Unexpected Codex credentials');
      if (method === 'GET' && url.pathname === CODEX_PATH + '/models') {
        assert([...url.searchParams.keys()].every(key => key === 'client_version'), 'Unexpected catalog query');
        observed.codexCatalog++;
        return Response.json({ models: catalog });
      }
      if (method === 'POST' && url.pathname === CODEX_PATH + '/responses' && !url.search) {
        observed.codexResponses++;
        assert.equal(body.model, CODEX_A, 'Native combo must start with configured first member');
        assert(body.stream === true && body.store === false && body.previous_response_id == null && body.max_output_tokens == null);
        assert(Array.isArray(body.input) && JSON.stringify(body.input).includes(CODEX_PROMPT), 'Codex prompt not forwarded');
        return codexReply(body.model);
      }
    }
    if (url.origin === CLAUDE_ORIGIN) {
      assert(headers.get('x-api-key') === CLAUDE_UPSTREAM_KEY && !headers.has('authorization'), 'Wrong Claude fixture credential');
      assert.equal(headers.get('anthropic-version'), '2023-06-01');
      if (method === 'GET' && url.pathname === '/v1/models') {
        assert([...url.searchParams.keys()].every(key => key === 'limit'));
        observed.claudeCatalog++;
        return Response.json({ data: [{ id: CLAUDE_MODEL, display_name: 'Fixture Claude', type: 'model' }], has_more: false });
      }
      if (method === 'POST' && url.pathname === '/v1/messages/count_tokens' && !url.search) {
        observed.claudeCount++;
        assert.equal(body.model, CLAUDE_MODEL);
        return Response.json({ input_tokens: 13 });
      }
      if (method === 'POST' && url.pathname === '/v1/messages' && !url.search) {
        observed.claudeMessages++;
        assert.equal(body.model, CLAUDE_MODEL);
        assert(body.stream === true && Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0, 'Expected streaming Messages');
        assert(Array.isArray(body.messages) && JSON.stringify(body.messages).includes(CLAUDE_PROMPT), 'Claude prompt not forwarded');
        assert(!body.tools?.length, 'Claude tools must be disabled');
        return claudeReply(body.model);
      }
    }
    throw new Error('Unmatched upstream method/path');
  } catch {
    // Record even if the gateway catches/retries. Do not reveal request
    // headers, bodies, or arbitrary URLs.
    fixtureViolations.push('Unexpected upstream request or invalid fixture payload');
    throw new Error('CLI smoke fixture refused upstream request');
  }
};

const data = path.join(root, 'gateway-data');
Object.assign(process.env, {
  LATEDEV_DATA_DIR: data, LATEDEV_DB_URL: path.join(data, 'fixture.sqlite'),
  LATEDEV_MASTER_KEY: 'a'.repeat(32), LATEDEV_HOST: '127.0.0.1', LATEDEV_PORT: '0',
  LATEDEV_LOG_LEVEL: 'error', NODE_ENV: 'test',
});
const { buildApp } = await import(path.join(repo, 'dist/server/app.js'));
const { getRawDb, closeDb } = await import(path.join(repo, 'dist/server/db/index.js'));
let app;
try {
  app = await buildApp();
  const credentials = { username: 'admin', password: 'fixture-cli-admin-only' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/setup', payload: credentials })).statusCode, 200);
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: credentials });
  assert.equal(login.statusCode, 200);
  const cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie']).split(';')[0];
  const csrf = (await app.inject({ method: 'GET', url: '/api/admin/csrf', headers: { cookie } })).json().csrfToken;
  async function admin(route, payload) {
    const result = await app.inject({ method: 'POST', url: '/api/admin/' + route,
      headers: { cookie, 'x-csrf-token': csrf }, payload });
    assert.equal(result.statusCode, 200, 'Fixture admin request: ' + route);
    return result.json();
  }
  const raw = getRawDb();
  const codexProvider = await admin('providers', { name: 'CLI Codex fixture', slug: 'codex-cli', type: 'openai', providerKind: 'codex' });
  await admin('models/import', { providerId: codexProvider.id, modelIds: [CODEX_A, CODEX_B, CODEX_HIDDEN] });
  const modelId = (provider, slug) => {
    const row = raw.prepare('SELECT id FROM models WHERE provider_id=? AND upstream_model_id=?').get(provider, slug);
    assert(row, 'Missing fixture model');
    return row.id;
  };
  const codexFirst = modelId(codexProvider.id, CODEX_A);
  const combo = await admin('combos', { name: 'CLI Native fixture', comboKind: 'codex_native',
    fallbackOn429: false, slowResponseFallbackEnabled: false, members: [
      { modelId: codexFirst, position: 0 }, { modelId: modelId(codexProvider.id, CODEX_B), position: 1 },
    ] });
  const alias = await admin('aliases', { alias: CODEX_ALIAS, targetKind: 'combo', targetId: combo.id });
  const codexKey = await admin('api-keys', { name: 'Fixture Codex alias only', allowAllModels: false,
    permissions: [{ targetKind: 'alias', targetId: alias.id }] });
  const claudeProvider = await admin('providers', { name: 'CLI Claude fixture', slug: 'claude-cli', type: 'anthropic',
    providerKind: 'claude_code', apiKey: CLAUDE_UPSTREAM_KEY });
  await admin('models/import', { providerId: claudeProvider.id, modelIds: [CLAUDE_MODEL] });
  const claudeId = modelId(claudeProvider.id, CLAUDE_MODEL);
  const claudeKey = await admin('api-keys', { name: 'Fixture Claude only', allowAllModels: false,
    permissions: [{ targetKind: 'model', targetId: claudeId }] });
  assert.equal(observed.claudeCatalog, 1, 'Claude import must discover configured upstream');

  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(base), 'Unexpected gateway listener');
  const codex = await clientHome('codex');
  codex.env.CODEX_HOME = path.join(codex.home, '.codex');
  codex.env.FIXTURE_CODEX_BEARER = CODEX_BEARER;
  codex.env.FIXTURE_GATEWAY_KEY = codexKey.secret;
  await mkdir(codex.env.CODEX_HOME, { mode: 0o700 });
  // Documented API-key custom provider, NOT ChatGPT OAuth. No auth.json or
  // login command. Credentials exist only in this fixture child's environment.
  await writeFile(path.join(codex.env.CODEX_HOME, 'config.toml'), [
    'model = "' + CODEX_ALIAS + '"',
    'model_provider = "fixture"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    '[features]',
    'api_key_model_discovery = true',
    'shell_tool = false',
    'shell_snapshot = false',
    'apps = false',
    'hooks = false',
    'multi_agent = false',
    'remote_plugin = false',
    'goals = false',
    '[model_providers.fixture]',
    'name = "Isolated fixture"',
    'base_url = "' + base + CODEX_PATH + '"',
    'model_catalog_url = "' + base + CODEX_PATH + '/models"',
    'env_key = "FIXTURE_CODEX_BEARER"',
    'env_http_headers = { "X-API-Key" = "FIXTURE_GATEWAY_KEY" }',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n'), { mode: 0o600 });
  const visible = parseCliJson(await runCli('codex', ['debug', 'models'], codex), 'gateway catalog');
  assert(observed.codexCatalog > 0, 'Codex did not fetch gateway catalog');
  assert.deepEqual(visible.models.map(model => model.slug), [CODEX_ALIAS], 'Actual CLI catalog must honor alias-only ACL');
  console.log('PASS Codex CLI catalog (fixture env_key; alias-only ACL)');
  const output = path.join(root, 'codex-answer.txt');
  const events = await runCli('codex', ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '--json', '--color', 'never', '--output-last-message', output, CODEX_PROMPT], codex);
  assert.equal((await readFile(output, 'utf8')).trim(), CODEX_ANSWER);
  assert(events.split('\n').filter(Boolean).map(line => parseCliJson(line, 'Codex event')).some(event => event.type === 'turn.completed'),
    'Codex CLI did not complete a turn');
  assert.equal(observed.codexResponses, 1, 'Unexpected native Responses request count');

  Object.assign(claude.env, {
    ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: claudeKey.secret, ANTHROPIC_MODEL: CLAUDE_PUBLIC,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_PUBLIC, ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_PUBLIC,
    ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_PUBLIC, DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_MAX_RETRIES: '0',
  });
  const result = parseCliJson(await runCli('claude', ['--restricted', '--print', '--output-format', 'json',
    '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence', '--permission-prompts', 'none', '--no-chrome',
    '--max-turns', '1', '--model', CLAUDE_PUBLIC, CLAUDE_PROMPT], claude, 60_000), 'Claude result');
  assert(result.type === 'result' && result.subtype === 'success' && result.is_error === false
    && result.result.trim() === CLAUDE_ANSWER, 'Claude CLI did not return fixture answer');
  assert.equal(observed.claudeMessages, 1, 'Unexpected native Messages request count');

  // Stream EOF can reach the client before the request transaction commits.
  for (let i = 0; i < 100; i++) {
    if (raw.prepare('SELECT count(*) AS n FROM requests WHERE api_key_id IN (?,?)').get(codexKey.id, claudeKey.id).n >= 2
      && raw.prepare('SELECT count(DISTINCT api_key_id) AS n FROM usage_monthly WHERE api_key_id IN (?,?)').get(codexKey.id, claudeKey.id).n === 2) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  function verifyAccounting(key, provider, model, requested, protocol, endpoint, input, outputTokens, cached, total) {
    const requests = raw.prepare('SELECT * FROM requests WHERE api_key_id=?').all(key.id);
    assert.equal(requests.length, 1, 'Expected exactly one accounted generation per client');
    const request = requests[0];
    assert(request.success === 1 && request.http_status === 200 && request.streaming === 1 && request.partial_stream === 0 && request.attempts_count === 1);
    assert(request.final_model_id === model && request.requested_model === requested && request.protocol === protocol && request.endpoint === endpoint);
    assert(request.input_tokens === input && request.output_tokens === outputTokens && request.cache_read_tokens === cached && request.total_tokens === total,
      'Unexpected persisted usage for ' + protocol);
    const attempts = raw.prepare('SELECT * FROM request_attempts WHERE request_id=?').all(request.id);
    assert.equal(attempts.length, 1);
    const attempt = attempts[0];
    assert(attempt.success === 1 && attempt.provider_id === provider && attempt.model_id === model && attempt.stream_started === 1
      && attempt.partial_response === 0 && attempt.input_tokens === input && attempt.output_tokens === outputTokens && attempt.cache_read_tokens === cached);
    // Anthropic cache reads are additional input for quota enforcement;
    // OpenAI cached tokens are already included in reported input.
    const quotaTotal = total + (protocol === 'anthropic' ? cached : 0);
    for (const table of ['usage_daily', 'usage_monthly']) {
      const usage = raw.prepare('SELECT sum(total_tokens) AS total FROM ' + table + ' WHERE api_key_id=?').get(key.id);
      assert.equal(usage.total, quotaTotal, table + ' accounting mismatch');
    }
    const logs = JSON.stringify([requests, attempts]);
    for (const secret of [CODEX_BEARER, CLAUDE_UPSTREAM_KEY, codexKey.secret, claudeKey.secret]) {
      assert(!logs.includes(secret), 'Credential leaked into request history');
    }
    return request;
  }
  const codexRow = verifyAccounting(codexKey, codexProvider.id, codexFirst, CODEX_ALIAS, 'openai', 'responses', 12, 8, 3, 20);
  // The persisted requested name is the alias, while routing records the
  // unwrapped combo target UUID (not the alias UUID).
  assert(codexRow.resolved_target_kind === 'combo' && codexRow.resolved_target_id === combo.id && codexRow.reasoning_tokens === 2);
  assert(codexRow.request_payload_json === null && codexRow.response_payload_json === null, 'Native Codex payload must not be persisted');
  verifyAccounting(claudeKey, claudeProvider.id, claudeId, CLAUDE_PUBLIC, 'anthropic', 'messages', 10, 5, 3, 15);
  assert.deepEqual(fixtureViolations, []);
  assert.deepEqual(await readdir(codex.cwd), [], 'Codex modified isolated workspace');
  assert.deepEqual(await readdir(claude.cwd), [], 'Claude modified isolated workspace');
  console.log('PASS Codex Responses and Claude Messages CLI turns, scoped keys, upstream identity, attempts and SQLite usage');
  console.log('Mock call counts: ' + JSON.stringify(observed));
  console.log('Mock wire/catalog compatibility only, not OAuth or live provider validation.');
} catch (error) {
  console.error('Mock call counts: ' + JSON.stringify(observed));
  console.error('Rejected fixture requests: ' + fixtureViolations.length);
  throw error;
} finally {
  try { await app?.close(); } finally { closeDb(); }
}
