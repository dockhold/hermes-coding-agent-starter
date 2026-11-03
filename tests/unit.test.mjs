// Unit tests for agent/lib.mjs. Run: node --test tests/*.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import * as lib from '../agent/lib.mjs';

const KEY = 'sk-or-v1-FAKEKEYFORTESTS00000000000000';
const GH = 'github_pat_FAKETOKENFORTESTS000000000000';
const DH = 'dh_FAKEDOCKHOLDTOKEN0000';
const VARS = "on this app's Variables tab and restart.";
const PROVIDERS = JSON.parse(fs.readFileSync(new URL('../agent/providers.json', import.meta.url), 'utf8'));

const base = (extra = {}) => ({
  DATA_DIR: '/data',
  AGENT_API_KEY: KEY,
  GITHUB_TOKEN: GH,
  AGENT_REPO: 'octo-org/website',
  AGENT_MODEL: 'anthropic/claude-sonnet-4.6',
  ...extra,
});
const config = (extra = {}) => {
  const r = lib.parseConfig(base(extra), PROVIDERS);
  assert.equal(r.error, undefined, r.error);
  return r.config;
};
const refusal = (env) => {
  const r = lib.parseConfig(env, PROVIDERS);
  assert.ok(r.error, 'expected a refusal');
  assert.ok(!r.error.includes('\n'), 'a refusal is one line');
  for (const s of [KEY, GH, DH]) assert.ok(!r.error.includes(s), 'a refusal never quotes a secret');
  return r.error;
};

describe('config: refusals, one line each', () => {
  it('no App storage', () => {
    const { DATA_DIR, ...noData } = base();
    assert.equal(refusal(noData), lib.STORAGE_LINE);
    assert.equal(refusal(base({ DATA_DIR: '' })), lib.STORAGE_LINE);
    assert.equal(refusal(base({ DATA_DIR: 'data' })), lib.STORAGE_LINE);
  });
  it('no model key', () => {
    assert.equal(refusal(base({ AGENT_API_KEY: '' })), `AGENT_API_KEY is missing or empty. Add it as a secret ${VARS}`);
  });
  it('no GitHub token', () => {
    assert.equal(refusal(base({ GITHUB_TOKEN: '  ' })), `GITHUB_TOKEN is missing or empty. Add it as a secret ${VARS}`);
  });
  it('neither secret', () => {
    assert.equal(
      refusal(base({ AGENT_API_KEY: '', GITHUB_TOKEN: '' })),
      `AGENT_API_KEY and GITHUB_TOKEN are missing or empty. Add them as secrets ${VARS}`,
    );
  });
  it('malformed secrets, without quoting them', () => {
    assert.match(refusal(base({ AGENT_API_KEY: 'sk or with spaces' })), /^AGENT_API_KEY is not an API key/);
    assert.match(refusal(base({ GITHUB_TOKEN: `${GH}-x` })), /^GITHUB_TOKEN is not a GitHub token/);
    assert.match(refusal(base({ GITHUB_TOKEN: 'short' })), /^GITHUB_TOKEN is not a GitHub token/);
    assert.match(refusal(base({ DOCKHOLD_API_TOKEN: 'has space inside' })), /^DOCKHOLD_API_TOKEN is not an API token/);
  });
  it('AGENT_REPO missing or not owner/name', () => {
    assert.equal(refusal(base({ AGENT_REPO: '' })), `AGENT_REPO is missing. Set it to your repository as owner/name ${VARS}`);
    for (const bad of ['website', 'octo-org/', '/website', 'octo-org/website/extra', 'https://github.com/a/b',
      '-octo/website', 'octo--org/website', 'octo-org/..', 'octo-org/web site', 'octo-org/website.git', 'a/b;rm']) {
      assert.match(refusal(base({ AGENT_REPO: bad })), /^AGENT_REPO must be a repository as owner\/name/, bad);
    }
  });
  it('AGENT_POLL_MINUTES, AGENT_TASK_MINUTES and AGENT_MAX_TURNS out of range', () => {
    for (const bad of ['0', '1441', 'ten', '1.5', '-5', '10m']) {
      assert.equal(refusal(base({ AGENT_POLL_MINUTES: bad })), `AGENT_POLL_MINUTES must be a whole number from 1 to 1440. Fix it ${VARS}`);
      assert.equal(refusal(base({ AGENT_TASK_MINUTES: bad })), `AGENT_TASK_MINUTES must be a whole number from 1 to 1440. Fix it ${VARS}`);
    }
    for (const bad of ['0', '501', 'many', '9.5']) {
      assert.equal(refusal(base({ AGENT_MAX_TURNS: bad })), `AGENT_MAX_TURNS must be a whole number from 1 to 500. Fix it ${VARS}`);
    }
  });
  it('AGENT_MODEL missing or malformed', () => {
    assert.match(refusal(base({ AGENT_MODEL: '' })), /^AGENT_MODEL is missing/);
    assert.match(refusal(base({ AGENT_MODEL: '--yolo' })), /^AGENT_MODEL must be/);
    assert.match(refusal(base({ AGENT_MODEL: 'gpt 5' })), /^AGENT_MODEL must be/);
  });
  it('AGENT_PROVIDER unknown, or one that signs in through a browser', () => {
    for (const bad of ['nope', '--yolo', 'Open Router', 'copilot', 'nous', 'bedrock']) {
      assert.match(refusal(base({ AGENT_PROVIDER: bad })), /^AGENT_PROVIDER must be a model provider/, bad);
    }
  });
  it('AGENT_BASE_URL only for custom, and only https', () => {
    assert.match(refusal(base({ AGENT_PROVIDER: 'custom' })), /^AGENT_PROVIDER is custom, so AGENT_BASE_URL must be/);
    for (const bad of ['http://llm.example.com/v1', 'https://llm.example.com/v1?x=1', 'https://user:pw@llm.example.com', 'ftp://x', 'https://a b']) {
      assert.match(refusal(base({ AGENT_PROVIDER: 'custom', AGENT_BASE_URL: bad })), /^AGENT_PROVIDER is custom/, bad);
    }
    assert.match(refusal(base({ AGENT_BASE_URL: 'https://llm.example.com/v1' })), /^AGENT_BASE_URL is only for AGENT_PROVIDER custom/);
  });
  it('AGENT_TOOLSETS and AGENT_LABEL malformed', () => {
    for (const bad of ['--yolo', 'file,\nterminal', ',,', 'File', 'file;rm', Array(21).fill('file').join(',')]) {
      assert.match(refusal(base({ AGENT_TOOLSETS: bad })), /^AGENT_TOOLSETS must be/, bad);
    }
    assert.match(refusal(base({ AGENT_LABEL: 'a,b' })), /^AGENT_LABEL must be/);
    assert.match(refusal(base({ AGENT_LABEL: 'x'.repeat(51) })), /^AGENT_LABEL must be/);
  });
  it('test-only addresses are refused unless local', () => {
    assert.match(refusal(base({ CODING_AGENT_TEST_GITHUB_API: 'https://evil.example' })), /tests only/);
    assert.match(refusal(base({ CODING_AGENT_TEST_GITHUB_API: 'http://127.0.0.1.evil.example' })), /tests only/);
    assert.match(refusal(base({ CODING_AGENT_TEST_GIT_URL: 'https://evil.example/r.git' })), /tests only/);
  });
  it('PORT that is not a port', () => {
    assert.match(refusal(base({ PORT: 'abc' })), /^PORT is set by Dockhold/);
    assert.match(refusal(base({ PORT: '65536' })), /^PORT is set by Dockhold/);
    assert.equal(config({ PORT: '0' }).port, 0, 'PORT 0 (any free port) is for the tests');
  });
});

describe('config: defaults and accepted values', () => {
  it('defaults', () => {
    const c = config();
    assert.equal(c.label, 'agent');
    assert.equal(c.pollMinutes, 10);
    assert.equal(c.taskMinutes, 60);
    assert.equal(c.maxTurns, 90);
    assert.equal(c.provider, 'openrouter');
    assert.equal(c.keyEnv, 'OPENROUTER_API_KEY');
    assert.equal(c.baseUrl, '');
    assert.deepEqual(c.toolsets, ['file', 'terminal', 'todo']);
    assert.equal(c.home, '/data/home');
    assert.equal(c.hermesHome, '/data/home/.hermes');
    assert.equal(c.repoDir, '/data/repo');
    assert.equal(c.taskLog, '/data/tasks.jsonl');
    assert.equal(c.apiBase, 'https://api.github.com');
    assert.equal(c.gitUrl, 'https://github.com/octo-org/website.git');
    assert.equal(c.dockholdToken, '');
    assert.equal(c.port, 8080);
  });
  it('values the user sets', () => {
    const c = config({
      AGENT_LABEL: 'ready for agent', AGENT_POLL_MINUTES: '1440', AGENT_TASK_MINUTES: '1', AGENT_MAX_TURNS: '500',
      AGENT_PROVIDER: 'anthropic', AGENT_MODEL: 'claude-sonnet-4-6', AGENT_TOOLSETS: 'file, terminal,web',
      DOCKHOLD_API_TOKEN: DH, PORT: '9000', DATA_DIR: '/data/',
    });
    assert.equal(c.label, 'ready for agent');
    assert.equal(c.pollMinutes, 1440);
    assert.equal(c.taskMinutes, 1);
    assert.equal(c.maxTurns, 500);
    assert.equal(c.provider, 'anthropic');
    assert.equal(c.keyEnv, 'ANTHROPIC_API_KEY');
    assert.equal(c.model, 'claude-sonnet-4-6');
    assert.deepEqual(c.toolsets, ['file', 'terminal', 'web']);
    assert.equal(c.dockholdToken, DH);
    assert.equal(c.port, 9000);
    assert.equal(c.home, '/data/home');
  });
  it('providers by name or alias, any case; custom with an https endpoint', () => {
    for (const name of Object.keys(PROVIDERS)) assert.equal(config({ AGENT_PROVIDER: name }).provider, name);
    assert.equal(config({ AGENT_PROVIDER: 'OR' }).provider, 'openrouter');
    const c = config({ AGENT_PROVIDER: 'custom', AGENT_BASE_URL: 'https://llm.example.com:8443/v1' });
    assert.equal(c.provider, 'custom');
    assert.equal(c.baseUrl, 'https://llm.example.com:8443/v1');
    assert.equal(c.keyEnv, '');
  });
  it('a provider list can never put the key under a name that steers the agent', () => {
    for (const env of ['HERMES_HOME', 'PATH', 'HOME', 'LD_PRELOAD', 'PYTHONPATH', 'GIT_DIR', 'GITHUB_TOKEN', 'AGENT_API_KEY', 'lower', '']) {
      assert.equal(lib.resolveProvider({ evil: { aliases: [], env } }, 'evil'), null, env);
    }
    assert.deepEqual(lib.resolveProvider({ good: { aliases: ['g'], env: 'GOOD_API_KEY' } }, 'g'), { name: 'good', keyEnv: 'GOOD_API_KEY' });
    for (const p of Object.values(PROVIDERS)) assert.ok(lib.keyEnvAllowed(p.env), p.env);
  });
  it('model names as providers write them, and test addresses on the loopback', () => {
    for (const m of ['deepseek-v4-pro', 'meta-llama/llama-3.3-70b-instruct:free', 'gemini-2.5-pro', 'x-ai/grok-4@latest']) {
      assert.equal(config({ AGENT_MODEL: m }).model, m);
    }
    const c = config({ CODING_AGENT_TEST_GITHUB_API: 'http://127.0.0.1:4010', CODING_AGENT_TEST_GIT_URL: 'file:///tmp/r.git' });
    assert.equal(c.apiBase, 'http://127.0.0.1:4010');
    assert.equal(c.gitUrl, 'file:///tmp/r.git');
  });
});

describe('write access and interrupted runs', () => {
  it('every author but the owner is checked; write, maintain and admin may run', () => {
    assert.equal(lib.needsPermissionCheck({ author_association: 'OWNER' }), false);
    for (const a of ['MEMBER', 'COLLABORATOR', 'NONE', undefined]) assert.equal(lib.needsPermissionCheck({ author_association: a }), true);
    for (const ok of [{ permission: 'admin', role_name: 'admin' }, { permission: 'write', role_name: 'maintain' },
      { permission: 'write', role_name: 'write' }, { permission: 'write', role_name: 'custom-dev' }]) {
      assert.equal(lib.hasWriteAccess(ok), true, JSON.stringify(ok));
    }
    for (const no of [{ permission: 'read', role_name: 'triage' }, { permission: 'read', role_name: 'read' },
      { permission: 'none', role_name: '' }, null, {}]) {
      assert.equal(lib.hasWriteAccess(no), false, JSON.stringify(no));
    }
    assert.equal(lib.authorLogin({ user: { login: 'octo-cat' } }), 'octo-cat');
    for (const bad of ['dependabot[bot]', '../x', '', '-a', undefined]) assert.equal(lib.authorLogin({ user: { login: bad } }), '');
  });
  it('counts interrupted runs in a row per issue; any other outcome resets the count', () => {
    const line = (issue, outcome) => JSON.stringify({ issue, outcome });
    const log = [line(5, 'interrupted'), line(6, 'interrupted'), line(5, 'interrupted'), 'junk', line(6, 'pr')].join('\n');
    assert.equal(lib.interruptedStreak(log, 5), 2);
    assert.equal(lib.interruptedStreak(log, 6), 0);
    assert.equal(lib.interruptedStreak(`${log}\n${line(5, 'stopped')}\n${line(5, 'interrupted')}`, 5), 1);
    assert.equal(lib.interruptedStreak('', 5), 0);
    assert.equal(lib.MAX_INTERRUPTED_RUNS, 3);
  });
});

describe('issue selection', () => {
  const issue = (number, extra = {}) => ({ number, title: `t${number}`, author_association: 'OWNER', created_at: `2026-10-0${number}T00:00:00Z`, ...extra });
  it('skips pull requests silently, outsiders and done ones with a reason, oldest first', () => {
    const issues = [
      issue(5), issue(3, { author_association: 'MEMBER' }), issue(4, { author_association: 'COLLABORATOR' }),
      issue(2, { pull_request: { url: 'x' } }), issue(6, { author_association: 'NONE' }),
      issue(7, { author_association: 'CONTRIBUTOR' }), issue(8, { author_association: 'FIRST_TIME_CONTRIBUTOR' }),
      issue(1),
    ];
    const { eligible, skipped } = lib.selectIssues(issues, new Set([1]));
    assert.deepEqual(eligible.map((i) => i.number), [3, 4, 5]);
    assert.deepEqual(skipped.map((s) => s.number).sort(), [1, 6, 7, 8]);
    assert.match(skipped.find((s) => s.number === 6).reason, /without write access \(NONE\)/);
    assert.match(skipped.find((s) => s.number === 1).reason, /already/);
  });
  it('reads done issues from the task log, ignoring failures and damaged lines', () => {
    const log = [
      JSON.stringify({ issue: 1, outcome: 'pr' }),
      JSON.stringify({ issue: 2, outcome: 'no-changes' }),
      JSON.stringify({ issue: 3, outcome: 'failed' }),
      '{not json',
      JSON.stringify({ issue: '4', outcome: 'pr' }),
      '',
    ].join('\n');
    assert.deepEqual([...lib.doneIssues(log)].sort(), [1, 2]);
    assert.equal(lib.doneIssues('').size, 0);
  });
});

describe('the agent command line', () => {
  it('one-shot, stream-json, the prompt on stdin, no rules from the checkout', () => {
    const args = lib.buildHermesArgs(config());
    assert.deepEqual(args.slice(0, 3), ['chat', '--query-file', '-']);
    const after = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(after('--format'), 'stream-json');
    assert.equal(after('--provider'), 'openrouter');
    assert.equal(after('--model'), 'anthropic/claude-sonnet-4.6');
    assert.equal(after('--toolsets'), 'file,terminal,todo');
    assert.equal(after('--max-turns'), '90');
    assert.ok(!args.includes('--run-budget'), 'the time budget is in config.yaml');
    assert.equal(after('--source'), 'tool');
    assert.ok(args.includes('--ignore-rules'));
    assert.ok(!args.includes('--yolo'));
    assert.ok(!args.includes('--accept-hooks'));
  });
  it('custom maps to the endpoint entry, never to Hermes own custom provider', () => {
    const c = config({ AGENT_PROVIDER: 'custom', AGENT_BASE_URL: 'https://llm.example.com/v1' });
    const args = lib.buildHermesArgs(c);
    assert.equal(args[args.indexOf('--provider') + 1], lib.ENDPOINT_PROVIDER);
  });
  it('the prompt: instructions, then the issue, marked', () => {
    const p = lib.taskPrompt({ number: 12, title: ' Fix footer ', body: 'Use 2026.\n' });
    assert.match(p, /^You are working on GitHub issue #12/);
    assert.match(p, /Do not commit, push/);
    assert.match(p, /Your final reply becomes the pull request description/);
    assert.ok(p.endsWith('===== The issue =====\nFix footer\n\nUse 2026.\n===== End of the issue =====\n'));
    assert.ok(lib.taskPrompt({ number: 1, title: '--model x', body: null }).includes('===== The issue =====\n--model x\n====='));
  });
  it("the repository's AGENTS.md follows the issue, marked as the repository's own instructions", () => {
    const p = lib.taskPrompt({ number: 1, title: 'Fix', body: 'Body' }, 'Use tabs.\n');
    assert.ok(p.endsWith([
      '===== End of the issue =====',
      '',
      "===== The repository's own instructions (AGENTS.md at the repository root) =====",
      'Use tabs.',
      "===== End of the repository's own instructions =====",
      '',
    ].join('\n')));
    assert.ok(!lib.taskPrompt({ number: 1, title: 'Fix', body: '' }, '  \n').includes('AGENTS.md'));
    assert.match(lib.taskPrompt({ number: 1, title: 'Fix' }, 'x'.repeat(lib.MAX_AGENTS_MD + 10)), /cut at 65536 characters/);
  });
});

describe("Hermes's config.yaml", () => {
  it('without the Dockhold token: refusals on, no installs, no MCP server', () => {
    const y = lib.hermesConfigYaml(config());
    assert.match(y, /^model:\n  provider: "openrouter"\n  default: "anthropic\/claude-sonnet-4.6"\nagent:\n  run_budget_seconds: 3600\napprovals:\n  single_query_mode: deny\n/);
    assert.match(y, /allow_lazy_installs: false/);
    assert.ok(!y.includes('mcp_servers'));
    assert.ok(!y.includes('providers:'));
  });
  it('with the Dockhold token: the server by reference, never the token itself', () => {
    const y = lib.hermesConfigYaml(config({ DOCKHOLD_API_TOKEN: DH }));
    assert.ok(y.includes('mcp_servers:\n  dockhold:\n    url: "https://api.dockhold.eu/mcp"\n    headers:\n      Authorization: "Bearer ${DOCKHOLD_API_TOKEN}"\n'));
    for (const s of [KEY, GH, DH]) assert.ok(!y.includes(s));
  });
  it('a custom endpoint reads its key from the environment', () => {
    const y = lib.hermesConfigYaml(config({ AGENT_PROVIDER: 'custom', AGENT_BASE_URL: 'https://llm.example.com/v1' }));
    assert.ok(y.includes(`  provider: "${lib.ENDPOINT_PROVIDER}"\n`));
    assert.ok(y.includes(`providers:\n  ${lib.ENDPOINT_PROVIDER}:\n    api: "https://llm.example.com/v1"\n    key_env: AGENT_API_KEY\n`));
    assert.ok(!y.includes(KEY));
  });
});

describe('the agent environment', () => {
  const env = { PATH: '/usr/bin', LANG: 'C.UTF-8', GITHUB_TOKEN: GH, AGENT_API_KEY: 'from-env', OTHER: 'x', AGENT_REPO: 'a/b', HERMES_ENABLE_PROJECT_PLUGINS: '1' };
  it("is an allow-list: GITHUB_TOKEN never in it, the key under the provider's own name", () => {
    const child = lib.hermesEnv(env, config());
    assert.deepEqual(Object.keys(child).sort(), ['HERMES_HOME', 'HOME', 'LANG', 'OPENROUTER_API_KEY', 'PATH', 'PYTHONDONTWRITEBYTECODE']);
    assert.equal(child.OPENROUTER_API_KEY, KEY);
    assert.equal(child.HOME, '/data/home');
    assert.equal(child.HERMES_HOME, '/data/home/.hermes');
    assert.ok(!Object.values(child).includes(GH));
    assert.equal(lib.hermesEnv(env, config({ AGENT_PROVIDER: 'anthropic' })).ANTHROPIC_API_KEY, KEY);
  });
  it('custom: the key as AGENT_API_KEY, which config.yaml names', () => {
    const child = lib.hermesEnv(env, config({ AGENT_PROVIDER: 'custom', AGENT_BASE_URL: 'https://llm.example.com/v1' }));
    assert.equal(child.AGENT_API_KEY, KEY);
    assert.ok(!('OPENROUTER_API_KEY' in child));
  });
  it('carries DOCKHOLD_API_TOKEN only when it is set', () => {
    const child = lib.hermesEnv(env, config({ DOCKHOLD_API_TOKEN: DH }));
    assert.equal(child.DOCKHOLD_API_TOKEN, DH);
    assert.ok(!('GITHUB_TOKEN' in child));
  });
});

describe('the push guard', () => {
  it('allows only agent/issue-<n>, never the default branch', () => {
    assert.equal(lib.assertPushBranch('agent/issue-12', 'main'), 'agent/issue-12');
    for (const bad of ['main', 'master', 'agent/issue-', 'agent/issue-12x', 'agent/issue-1/x', 'refs/heads/main',
      'agent/issue-1:refs/heads/main', '+agent/issue-1', 'Agent/issue-1', '', null, undefined]) {
      assert.throws(() => lib.assertPushBranch(bad, 'main'), /refusing to push/, String(bad));
    }
    assert.throws(() => lib.assertPushBranch('agent/issue-7', 'agent/issue-7'), /default branch/);
  });
  it('branch names from issue numbers, and default branch names from outside', () => {
    assert.equal(lib.branchFor(42), 'agent/issue-42');
    assert.throws(() => lib.branchFor(0));
    assert.throws(() => lib.branchFor('7'));
    assert.equal(lib.checkBranchName('main'), 'main');
    assert.equal(lib.checkBranchName('release/2.x'), 'release/2.x');
    for (const bad of ['-main', 'a..b', 'main branch', '', 'x'.repeat(256), undefined]) assert.throws(() => lib.checkBranchName(bad));
  });
  it('the git auth header is basic auth for the token, and the safe config turns hooks off', () => {
    const h = lib.gitAuthHeader(GH);
    assert.equal(h, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${GH}`).toString('base64')}`);
    assert.match(lib.SAFE_GIT_CONFIG, /hooksPath = \/dev\/null/);
    assert.doesNotMatch(lib.SAFE_GIT_CONFIG, /remote|url|include|credential|proxy/i);
  });
});

describe('output: escaping, redaction, summaries', () => {
  it('escapes HTML', () => {
    assert.equal(lib.escapeHtml(`<script>alert("x")</script>&'`), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
  });
  it('the status page escapes every value and never shows a secret', () => {
    const html = lib.renderStatus({
      repo: 'octo-org/website', label: '<b>agent</b>',
      current: { number: 4, title: '<img src=x onerror=alert(1)>', startedAt: Date.UTC(2026, 9, 27) },
      last: { issue: 3, title: 'ok', time: Date.UTC(2026, 9, 26), outcome: 'failed', error: '<i>boom</i>' },
      nextPollAt: 0, lastPollError: '"><svg onload=1>',
    });
    assert.ok(html.includes('octo-org/website'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<b>agent'));
    assert.ok(!html.includes('<svg'));
    assert.ok(html.includes('&lt;i&gt;boom&lt;/i&gt;'));
    for (const s of [KEY, GH, DH]) assert.ok(!html.includes(s));
  });
  it('links only a real pull request address', () => {
    const page = (prUrl) => lib.renderStatus({ repo: 'a/b', label: 'agent', current: null, last: { issue: 1, title: 't', time: 1, outcome: 'pr', prUrl }, nextPollAt: 1, lastPollError: '' });
    assert.ok(page('https://github.com/a/b/pull/9').includes('<a href="https://github.com/a/b/pull/9">'));
    assert.ok(!page('javascript:alert(1)').includes('<a href'));
  });
  it('the push guard finds a secret or its base64, across chunk boundaries, and nothing else', () => {
    const needles = lib.secretNeedles([KEY, '', GH]);
    assert.equal(needles.length, 4);
    const scan = (...chunks) => {
      const s = lib.createScanner(needles);
      return chunks.map((c) => s.push(Buffer.from(c))).at(-1);
    };
    assert.equal(scan(`a ${KEY} b`), true);
    assert.equal(scan('x'.repeat(10), KEY.slice(0, 7), KEY.slice(7), 'tail'), true);
    assert.equal(scan(Buffer.from(GH).toString('base64')), true);
    const b64 = Buffer.from(KEY).toString('base64');
    assert.equal(scan(b64.slice(0, 5), b64.slice(5)), true);
    assert.equal(scan(KEY.slice(0, -1), 'Z'), false);
    assert.equal(scan('nothing here', 'at all'), false);
  });
  it('redacts secret values', () => {
    assert.equal(lib.redact(`key ${KEY} and ${GH} twice ${KEY}`, [KEY, GH, '']), 'key [hidden] and [hidden] twice [hidden]');
    assert.deepEqual(lib.secretValues(config({ DOCKHOLD_API_TOKEN: DH })), [KEY, GH, DH]);
  });
  it('logs tool names only, never their input or output', () => {
    assert.equal(lib.describeEvent({ type: 'tool_use', name: 'terminal', input: { command: `echo ${KEY}` } }), 'tool terminal');
    assert.equal(lib.describeEvent({ type: 'tool_result', name: 'terminal', output: KEY, is_error: false }), null);
    assert.equal(lib.describeEvent({ type: 'tool_result', name: 'patch', output: KEY, is_error: true }), 'tool patch returned an error');
    assert.equal(lib.describeEvent({ type: 'text', text: KEY }), null);
    assert.equal(lib.describeEvent({ type: 'result', exit_code: 0, tokens: { total: 1234, input: 1000, output: 234 } }), 'agent finished, 1,234 tokens (1,000 in, 234 out)');
    assert.equal(lib.describeEvent({ type: 'system', subtype: 'init', model: 'm', session_id: 's' }), 'agent started (model m)');
  });
  it('names why a run failed', () => {
    const c = config();
    assert.equal(lib.failureReason({ result: { exit_code: 0, text: 'ok' }, exitCode: 0, timedOut: false, config: c }), '');
    assert.match(lib.failureReason({ result: null, exitCode: 0, timedOut: true, config: c }), /after 60 minutes/);
    assert.match(lib.failureReason({ result: null, exitCode: 1, timedOut: false, config: c }), /exited with code 1/);
    assert.match(lib.failureReason({ result: { exit_code: 1, error: 'iteration budget' }, exitCode: 1, timedOut: false, config: c }), /exit code 1: iteration budget/);
    assert.match(lib.failureReason({ result: { exit_code: 130 }, exitCode: 130, timedOut: false, config: c }), /exit code 130: no reason given/);
  });
  it('pull request body and commit message', () => {
    const body = lib.prBody({ summary: 'x'.repeat(4000), issueNumber: 9, tokens: { total: 5, input: 3, output: 2 }, model: 'deepseek-v4-pro' });
    assert.match(body, /Closes #9/);
    assert.match(body, /Model: deepseek-v4-pro\. Used for this task: 5 tokens \(3 in, 2 out\)/);
    assert.match(body, /cut at 3000 characters/);
    assert.equal(lib.commitMessage({ title: 'Fix\nthe   footer', number: 9 }), 'Fix the footer (#9)');
    assert.equal(lib.formatTokens(undefined), 'unknown');
  });
});
