// Pure functions for the Hermes coding agent starter: config checks, issue
// selection, the agent's command line, config and environment, the push
// guard, the status page. No I/O and no process state here, so every rule is unit
// tested in tests/unit.test.mjs.

const VARS_TAB = "on this app's Variables tab and restart.";

export const STORAGE_LINE =
  'This app keeps its work on App storage. Turn on App storage in the Size tab; the app restarts on its own.';

// Only issues opened by people with write access run. On a public repository
// anyone can open an issue, and the agent does what an issue says.
export const TRUSTED_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Outcomes after which an issue is not picked up again. A failed task runs
// again when someone puts the label back.
const DONE_OUTCOMES = new Set(['pr', 'no-changes']);

export const AGENT_BRANCH_RE = /^agent\/issue-[0-9]+$/;

// GitHub owner: letters, digits and single hyphens, up to 39 characters.
// Repository: letters, digits, '.', '_', '-', up to 100 characters.
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;
// Model names: OpenRouter's owner/model:variant, plain ids, dated ids.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const TOOLSET_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const BASE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;
const GITHUB_TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const PRINTABLE_RE = /^[\x21-\x7e]{8,4096}$/;
const BRANCH_NAME_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;

// Hardening limits, not settings.
const MAX_LABEL = 50;
const MAX_TOOLSETS = 20;
const MAX_TURNS = 500;
const MAX_MINUTES = 1440;
export const MAX_SUMMARY = 3000;
const MAX_TITLE = 200;
export const MAX_AGENTS_MD = 64 * 1024;
// An issue whose task was cut short this many times by the app stopping (a
// crash, running out of memory) is not put back again on its own.
export const MAX_INTERRUPTED_RUNS = 3;

export const DEFAULTS = Object.freeze({
  AGENT_LABEL: 'agent',
  AGENT_POLL_MINUTES: '10',
  AGENT_PROVIDER: 'openrouter',
  AGENT_TOOLSETS: 'file,terminal,todo',
  AGENT_MAX_TURNS: '90',
  AGENT_TASK_MINUTES: '60',
});

// The provider name for an OpenAI-compatible endpoint the user names in
// AGENT_BASE_URL. Every other provider comes from the list the image build
// wrote from Hermes itself (agent/providers.json).
export const CUSTOM_PROVIDER = 'custom';

// Test-only addresses. The tests point the program at a fake GitHub API on
// the loopback address and at a local git repository. Nothing else may be
// set here: a user cannot send the GitHub token anywhere through these.
const TEST_API_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/;
const TEST_GIT_RE = /^file:\/\/\/[A-Za-z0-9._/-]+$/;

function value(env, name) {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
}

function wholeNumber(env, name, max) {
  const raw = value(env, name) || DEFAULTS[name];
  const n = /^[0-9]{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= max)) {
    return { error: `${name} must be a whole number from 1 to ${max}. Fix it ${VARS_TAB}` };
  }
  return { value: n };
}

function checkSecrets(env) {
  const missing = ['AGENT_API_KEY', 'GITHUB_TOKEN'].filter((n) => !value(env, n));
  if (missing.length === 1) {
    return `${missing[0]} is missing or empty. Add it as a secret ${VARS_TAB}`;
  }
  if (missing.length === 2) {
    return `AGENT_API_KEY and GITHUB_TOKEN are missing or empty. Add them as secrets ${VARS_TAB}`;
  }
  if (!PRINTABLE_RE.test(value(env, 'AGENT_API_KEY'))) {
    return 'AGENT_API_KEY is not an API key: it has spaces or unusual characters. Check its value under Secrets in the dashboard sidebar and restart.';
  }
  if (!GITHUB_TOKEN_RE.test(value(env, 'GITHUB_TOKEN'))) {
    return 'GITHUB_TOKEN is not a GitHub token: it may only hold letters, digits and underscores. Check its value under Secrets in the dashboard sidebar and restart.';
  }
  const dockhold = value(env, 'DOCKHOLD_API_TOKEN');
  if (dockhold && !PRINTABLE_RE.test(dockhold)) {
    return 'DOCKHOLD_API_TOKEN is not an API token: it has spaces or unusual characters. Check its value under Secrets in the dashboard sidebar and restart.';
  }
  return '';
}

function checkRepo(env) {
  const repo = value(env, 'AGENT_REPO');
  if (!repo) return { error: `AGENT_REPO is missing. Set it to your repository as owner/name ${VARS_TAB}` };
  const name = repo.split('/')[1] || '';
  if (!REPO_RE.test(repo) || name === '.' || name === '..' || name.endsWith('.git')) {
    return { error: `AGENT_REPO must be a repository as owner/name, for example octo-org/website. Fix it ${VARS_TAB}` };
  }
  return { value: repo };
}

// Names the model key may never be written under, whatever a provider list
// says: the agent's fixed environment, and names that steer the loader,
// Python, Hermes or git. A key under HERMES_HOME, for example, would point
// Hermes at a folder in the checkout.
const RESERVED_KEY_ENV = new Set(['PATH', 'HOME', 'LANG', 'AGENT_API_KEY', 'DOCKHOLD_API_TOKEN', 'GITHUB_TOKEN']);
const RESERVED_KEY_ENV_PREFIX = /^(LD_|PYTHON|HERMES_|GIT_|UV_|NODE_)/;

export function keyEnvAllowed(name) {
  return typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(name)
    && !RESERVED_KEY_ENV.has(name) && !RESERVED_KEY_ENV_PREFIX.test(name);
}

// Finds the provider by name or alias in the list from the image build.
// Returns { name, keyEnv } or null.
export function resolveProvider(providers, raw) {
  if (raw === CUSTOM_PROVIDER) return { name: CUSTOM_PROVIDER, keyEnv: '' };
  for (const [name, p] of Object.entries(providers || {})) {
    if (name === raw || (Array.isArray(p.aliases) && p.aliases.includes(raw))) {
      return keyEnvAllowed(p.env) ? { name, keyEnv: p.env } : null;
    }
  }
  return null;
}

function checkProvider(env, providers) {
  const raw = (value(env, 'AGENT_PROVIDER') || DEFAULTS.AGENT_PROVIDER).toLowerCase();
  const provider = PROVIDER_RE.test(raw) ? resolveProvider(providers, raw) : null;
  if (!provider) {
    return { error: `AGENT_PROVIDER must be a model provider Hermes signs in to with an API key, such as openrouter, anthropic, gemini or deepseek, or custom with AGENT_BASE_URL for any OpenAI-compatible endpoint. Fix it ${VARS_TAB}` };
  }
  const baseUrl = value(env, 'AGENT_BASE_URL');
  if (provider.name === CUSTOM_PROVIDER) {
    if (!BASE_URL_RE.test(baseUrl)) {
      return { error: `AGENT_PROVIDER is custom, so AGENT_BASE_URL must be the endpoint's https:// address, for example https://llm.example.com/v1. Fix it ${VARS_TAB}` };
    }
  } else if (baseUrl) {
    return { error: `AGENT_BASE_URL is only for AGENT_PROVIDER custom. Remove it ${VARS_TAB}` };
  }
  return { value: { provider: provider.name, keyEnv: provider.keyEnv, baseUrl: provider.name === CUSTOM_PROVIDER ? baseUrl : '' } };
}

function checkAgentVars(env) {
  const label = value(env, 'AGENT_LABEL') || DEFAULTS.AGENT_LABEL;
  if (label.length > MAX_LABEL || label.includes(',') || /[\x00-\x1f\x7f]/.test(label)) {
    return { error: `AGENT_LABEL must be a label name of 1 to ${MAX_LABEL} characters with no comma. Fix it ${VARS_TAB}` };
  }
  const model = value(env, 'AGENT_MODEL');
  if (!model) {
    return { error: `AGENT_MODEL is missing. Set it to a model your provider offers, as the provider names it ${VARS_TAB}` };
  }
  if (!MODEL_RE.test(model)) {
    return { error: `AGENT_MODEL must be a model name as your provider writes it, with no spaces. Fix it ${VARS_TAB}` };
  }
  const toolsetsRaw = value(env, 'AGENT_TOOLSETS') || DEFAULTS.AGENT_TOOLSETS;
  const toolsets = toolsetsRaw.split(',').map((t) => t.trim()).filter(Boolean);
  if (/[\x00-\x1f\x7f]/.test(toolsetsRaw) || toolsets.length === 0 || toolsets.length > MAX_TOOLSETS || !toolsets.every((t) => TOOLSET_RE.test(t))) {
    return { error: `AGENT_TOOLSETS must be a comma-separated list of Hermes toolsets, such as file,terminal,todo. Fix it ${VARS_TAB}` };
  }
  return { value: { label, model, toolsets } };
}

function checkTestOverrides(env) {
  const api = value(env, 'CODING_AGENT_TEST_GITHUB_API');
  const git = value(env, 'CODING_AGENT_TEST_GIT_URL');
  if ((api && !TEST_API_RE.test(api)) || (git && !TEST_GIT_RE.test(git))) {
    return { error: `CODING_AGENT_TEST_GITHUB_API and CODING_AGENT_TEST_GIT_URL are for this repository's tests only. Remove them ${VARS_TAB}` };
  }
  return { value: { api, git } };
}

// PORT 0 means any free port; only the tests use it.
function checkPort(env) {
  const raw = value(env, 'PORT') || '8080';
  const port = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 0 && port <= 65535)) {
    return { error: `PORT is set by Dockhold. Remove it ${VARS_TAB}` };
  }
  return { value: port };
}

// Reads and checks every setting. Returns { config } or { error } where
// error is the one line the app prints before it exits with code 1. No
// line ever contains a secret value.
export function parseConfig(env, providers) {
  const dataDir = value(env, 'DATA_DIR');
  if (!dataDir || !dataDir.startsWith('/')) return { error: STORAGE_LINE };
  const secretError = checkSecrets(env);
  if (secretError) return { error: secretError };
  const steps = {
    repo: checkRepo(env),
    provider: checkProvider(env, providers),
    agent: checkAgentVars(env),
    maxTurns: wholeNumber(env, 'AGENT_MAX_TURNS', MAX_TURNS),
    pollMinutes: wholeNumber(env, 'AGENT_POLL_MINUTES', MAX_MINUTES),
    taskMinutes: wholeNumber(env, 'AGENT_TASK_MINUTES', MAX_MINUTES),
    test: checkTestOverrides(env),
    port: checkPort(env),
  };
  for (const step of Object.values(steps)) if (step.error) return { error: step.error };
  const dir = dataDir.replace(/\/+$/, '') || '/';
  const repo = steps.repo.value;
  return {
    config: {
      dataDir: dir,
      home: `${dir}/home`,
      hermesHome: `${dir}/home/.hermes`,
      repoDir: `${dir}/repo`,
      taskLog: `${dir}/tasks.jsonl`,
      currentFile: `${dir}/current.json`,
      port: steps.port.value,
      repo,
      ...steps.provider.value,
      ...steps.agent.value,
      maxTurns: steps.maxTurns.value,
      pollMinutes: steps.pollMinutes.value,
      taskMinutes: steps.taskMinutes.value,
      apiBase: steps.test.value.api || 'https://api.github.com',
      gitUrl: steps.test.value.git || `https://github.com/${repo}.git`,
      apiKey: value(env, 'AGENT_API_KEY'),
      githubToken: value(env, 'GITHUB_TOKEN'),
      dockholdToken: value(env, 'DOCKHOLD_API_TOKEN'),
    },
  };
}

// Every secret value in play, for redaction and for the check that no
// changed file carries one.
export function secretValues(config) {
  return [config.apiKey, config.githubToken, config.dockholdToken].filter(Boolean);
}

// What the push guard looks for: each secret value, and its base64 form
// (without padding). Exact matches only.
export function secretNeedles(secrets) {
  const needles = [];
  for (const s of secrets) {
    if (!s) continue;
    needles.push(Buffer.from(s), Buffer.from(Buffer.from(s).toString('base64').replace(/=+$/, '')));
  }
  return needles;
}

// A streaming search for any needle. push() takes the next chunk and returns
// true once a needle was seen, across chunk boundaries too.
export function createScanner(needles) {
  const keep = Math.max(0, ...needles.map((n) => n.length)) - 1;
  let tail = Buffer.alloc(0);
  let found = false;
  return {
    push(chunk) {
      if (found) return true;
      const buf = Buffer.concat([tail, chunk]);
      found = needles.some((n) => buf.includes(n));
      tail = keep > 0 ? buf.subarray(Math.max(0, buf.length - keep)) : Buffer.alloc(0);
      return found;
    },
  };
}

export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) if (s) out = out.split(s).join('[hidden]');
  return out;
}

// Issue numbers the task log records as done. Lines that are not valid JSON
// are ignored, so a damaged line never stops the app.
export function doneIssues(taskLogText) {
  const done = new Set();
  for (const line of String(taskLogText || '').split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (Number.isInteger(entry.issue) && DONE_OUTCOMES.has(entry.outcome)) done.add(entry.issue);
    } catch {
      // not a task line
    }
  }
  return done;
}

// Splits the open labelled issues into the ones that may run (oldest first)
// and the ones skipped, each with a reason.
export function selectIssues(issues, done) {
  const eligible = [];
  const skipped = [];
  for (const issue of issues || []) {
    if (!issue || !Number.isInteger(issue.number)) continue;
    if (issue.pull_request) continue;
    if (!TRUSTED_AUTHORS.has(issue.author_association)) {
      skipped.push({ number: issue.number, reason: `opened by someone without write access (${String(issue.author_association || 'unknown')})` });
    } else if (done.has(issue.number)) {
      skipped.push({ number: issue.number, reason: 'already has a pull request or a finished run in the task log' });
    } else {
      eligible.push(issue);
    }
  }
  eligible.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.number - b.number);
  return { eligible, skipped };
}

// Issues that ran this many times in a row without finishing, because the
// app stopped mid-task. Counts the trailing "interrupted" entries for the
// issue; any other outcome for it resets the count.
export function interruptedStreak(taskLogText, issueNumber) {
  let streak = 0;
  for (const line of String(taskLogText || '').split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.issue !== issueNumber) continue;
    streak = entry.outcome === 'interrupted' ? streak + 1 : 0;
  }
  return streak;
}

// author_association says MEMBER for any member of the owning organisation,
// write access or not, so every author other than the owner is checked with
// the collaborator permission endpoint. Write, maintain and admin may run.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);

export function needsPermissionCheck(issue) {
  return issue?.author_association !== 'OWNER';
}

export function authorLogin(issue) {
  const login = issue?.user?.login;
  return typeof login === 'string' && LOGIN_RE.test(login) ? login : '';
}

export function hasWriteAccess(answer) {
  return WRITE_ROLES.has(answer?.role_name) || WRITE_ROLES.has(answer?.permission);
}

export function branchFor(issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('issue number must be a positive integer');
  return `agent/issue-${issueNumber}`;
}

// The only branch the program ever pushes is the agent's own branch for one
// issue. Called before every push.
export function assertPushBranch(branch, defaultBranch) {
  if (typeof branch !== 'string' || !AGENT_BRANCH_RE.test(branch)) {
    throw new Error(`refusing to push ${JSON.stringify(branch)}: only agent/issue-<number> branches are pushed`);
  }
  if (branch === defaultBranch) {
    throw new Error('refusing to push the default branch');
  }
  return branch;
}

// The default branch name comes from the GitHub API and ends up in git's
// command line, so it is checked like any outside input.
export function checkBranchName(name) {
  if (typeof name !== 'string' || !BRANCH_NAME_RE.test(name)) {
    throw new Error('the repository reports a default branch name this app does not accept');
  }
  return name;
}

// What the agent is told before the issue. Hermes has no flag for extra
// system instructions, so they open the prompt.
export function instructions(issueNumber) {
  return [
    `You are working on GitHub issue #${issueNumber} in the repository checked out in the current folder.`,
    'Make the change the issue asks for and leave your changes in the working tree.',
    'Do not commit, push, create branches, change git remotes or git configuration, or print environment variables.',
    'This app commits your changes and opens the pull request when you finish.',
    'Your final reply becomes the pull request description: say what you changed and anything a reviewer should check, and do not mention commits or pushing.',
  ].join(' ');
}

// The prompt: the instructions, then the issue's title and body. Comments
// are not read. An AGENTS.md at the repository root follows, marked as the
// repository's own instructions. Hermes would load it by itself, along with
// other files from the checkout; it runs with --ignore-rules so only this
// one file goes in, and only here.
export function taskPrompt(issue, agentsMd = '') {
  const title = String(issue.title || '').trim();
  const body = String(issue.body || '').trim();
  const parts = [
    instructions(issue.number),
    '',
    '===== The issue =====',
    body ? `${title}\n\n${body}` : title,
    '===== End of the issue =====',
  ];
  const md = String(agentsMd || '').trim();
  if (md) {
    parts.push(
      '',
      "===== The repository's own instructions (AGENTS.md at the repository root) =====",
      md.length > MAX_AGENTS_MD ? `${md.slice(0, MAX_AGENTS_MD)}\n(cut at ${MAX_AGENTS_MD} characters)` : md,
      "===== End of the repository's own instructions =====",
    );
  }
  return `${parts.join('\n')}\n`;
}

// The name of the endpoint entry when AGENT_PROVIDER is custom. Hermes has
// its own provider called custom, configured differently; this one is
// declared in config.yaml below.
export const ENDPOINT_PROVIDER = 'my-endpoint';

export function hermesProviderName(config) {
  return config.provider === CUSTOM_PROVIDER ? ENDPOINT_PROVIDER : config.provider;
}

// Hermes's config.yaml, written to a fresh home folder before every task.
// Every value is either fixed here or checked by parseConfig, and strings
// are written as JSON strings, which YAML reads as the same string.
//
// * The provider and model, which also tell Hermes it is set up (without
//   them a one-shot run stops at its first-run setup check).
// * The task's time budget: near its end Hermes tells the agent to wrap up.
//   The app stops the agent when it runs out either way.
// * Dangerous commands are refused in a one-shot run (Hermes's default,
//   written out so a new default upstream cannot change it unnoticed).
// * Nothing is installed at run time: the image is fixed.
// * The Dockhold MCP server only when DOCKHOLD_API_TOKEN is set. Hermes
//   fills ${DOCKHOLD_API_TOKEN} from its own environment when it connects,
//   so the token is never written to a file.
// * For a custom endpoint, the key is read from AGENT_API_KEY the same way.
export function hermesConfigYaml(config) {
  const q = (v) => JSON.stringify(String(v));
  const lines = [
    'model:',
    `  provider: ${q(hermesProviderName(config))}`,
    `  default: ${q(config.model)}`,
    'agent:',
    `  run_budget_seconds: ${config.taskMinutes * 60}`,
    'approvals:',
    '  single_query_mode: deny',
    '  cron_mode: deny',
    '  unattended_mode: deny',
    'security:',
    '  allow_lazy_installs: false',
  ];
  if (config.provider === CUSTOM_PROVIDER) {
    lines.push(
      'providers:',
      `  ${ENDPOINT_PROVIDER}:`,
      `    api: ${q(config.baseUrl)}`,
      '    key_env: AGENT_API_KEY',
    );
  }
  if (config.dockholdToken) {
    lines.push(
      'mcp_servers:',
      '  dockhold:',
      '    url: "https://api.dockhold.eu/mcp"',
      '    headers:',
      '      Authorization: "Bearer ${DOCKHOLD_API_TOKEN}"',
    );
  }
  return `${lines.join('\n')}\n`;
}

// The agent's command line. The prompt goes in on stdin, never here, so an
// issue title that starts with "-" cannot become an option.
//
// --ignore-rules: Hermes would otherwise add AGENTS.md, .cursorrules and
// similar files from the checkout to its system prompt, and the saved
// memory and skills from its home. The checkout is the repository's
// content, so only its AGENTS.md goes in, inside the prompt (taskPrompt).
// --source tool keeps these runs out of Hermes's own session lists.
export function buildHermesArgs(config) {
  return [
    'chat',
    '--query-file', '-',
    '--format', 'stream-json',
    '--provider', hermesProviderName(config),
    '--model', config.model,
    '--toolsets', config.toolsets.join(','),
    '--max-turns', String(config.maxTurns),
    '--ignore-rules',
    '--source', 'tool',
  ];
}

// The agent's environment is an allow-list. GITHUB_TOKEN is never in it.
// The model key goes in under the name Hermes reads for the provider.
export function hermesEnv(env, config) {
  const child = {
    PATH: env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: config.home,
    HERMES_HOME: config.hermesHome,
    LANG: env.LANG || 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  if (config.provider === CUSTOM_PROVIDER) child.AGENT_API_KEY = config.apiKey;
  else child[config.keyEnv] = config.apiKey;
  if (config.dockholdToken) child.DOCKHOLD_API_TOKEN = config.dockholdToken;
  return child;
}

// The value of the HTTP header git sends to GitHub. Passed to git through
// its environment for one command at a time; never written to .git/config,
// never in a URL, never logged.
export function gitAuthHeader(token) {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

// Written over .git/config before every git command the app runs, so
// nothing the agent put there (hooks, URL rewrites, proxies, helpers) can
// take part in a fetch or push that carries the token.
export const SAFE_GIT_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tfilemode = true',
  '\tbare = false',
  '\tlogallrefupdates = true',
  '\thooksPath = /dev/null',
  '\tfsmonitor = false',
  '[gc]',
  '\tautoDetach = false',
  '[maintenance]',
  '\tautoDetach = false',
  '',
].join('\n');

export function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

export function truncate(text, max) {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max)}\n\n(summary cut at ${max} characters)` : s;
}

// Hermes reports tokens, not money: the price depends on the provider and
// the model. The provider's bill is the record.
export function formatTokens(tokens) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v.toLocaleString('en-US') : '?');
  if (!tokens || typeof tokens !== 'object') return 'unknown';
  return `${n(tokens.total)} tokens (${n(tokens.input)} in, ${n(tokens.output)} out)`;
}

export function commitMessage(issue) {
  return `${oneLine(issue.title, MAX_TITLE) || 'Agent change'} (#${issue.number})`;
}

export function prBody({ summary, issueNumber, tokens, model }) {
  return [
    truncate(summary, MAX_SUMMARY) || 'The agent gave no summary.',
    '',
    `Closes #${issueNumber}`,
    '',
    `Model: ${oneLine(model, 200)}. Used for this task: ${formatTokens(tokens)}. Your provider's bill is the record.`,
  ].join('\n');
}

// One compact log line for an event of Hermes's stream-json output, or
// null. Tool calls are logged by name only, never their input or output.
export function describeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'system' && event.subtype === 'init') {
    return `agent started (model ${oneLine(event.model, 100)})`;
  }
  if (event.type === 'tool_use') return `tool ${oneLine(event.name, 80)}`;
  if (event.type === 'tool_result' && event.is_error) return `tool ${oneLine(event.name, 80)} returned an error`;
  if (event.type === 'result') {
    const state = event.exit_code === 0 ? 'finished' : `ended with exit code ${oneLine(event.exit_code, 10)}`;
    return `agent ${state}, ${formatTokens(event.tokens)}`;
  }
  return null;
}

// Why a finished run counts as a failure, or '' when it succeeded.
export function failureReason({ result, exitCode, timedOut, config }) {
  if (timedOut) return `the agent was stopped after ${config.taskMinutes} minutes (AGENT_TASK_MINUTES)`;
  if (!result) return `the agent exited with code ${exitCode} before it reported a result`;
  if (result.exit_code !== 0) {
    const why = oneLine(result.error || result.text, 300) || 'no reason given';
    return `the agent ended with exit code ${oneLine(result.exit_code, 10)}: ${why}`;
  }
  return '';
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._/-]+\/pull\/[0-9]+$/;

function when(ms) {
  return ms ? new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'not yet';
}

function lastResultHtml(last) {
  if (!last) return 'none yet';
  if (last.prUrl && PR_URL_RE.test(last.prUrl)) {
    return `pull request <a href="${escapeHtml(last.prUrl)}">${escapeHtml(last.prUrl)}</a>`;
  }
  if (last.outcome === 'no-changes') return 'finished with no changes';
  return `failed: ${escapeHtml(last.error || 'unknown error')}`;
}

// The status page. Every value is escaped. The state object holds no
// secrets, and nothing here reads one.
export function renderStatus(state) {
  const cur = state.current;
  const last = state.last;
  const rows = [
    ['Repository', escapeHtml(state.repo)],
    ['Label', escapeHtml(state.label)],
    ['Current task', cur ? `#${escapeHtml(cur.number)} ${escapeHtml(cur.title)} (since ${when(cur.startedAt)})` : 'idle'],
    ['Last task', last ? `#${escapeHtml(last.issue)} ${escapeHtml(last.title)} at ${when(last.time)}` : 'none yet'],
    ['Last result', lastResultHtml(last)],
    ['Next poll', cur ? 'after the current task' : when(state.nextPollAt)],
    ['Last poll error', state.lastPollError ? escapeHtml(state.lastPollError) : 'none'],
  ];
  const body = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Hermes coding agent</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:46rem;padding:0 1rem;color:#1b1b1b;background:#fff}
th{text-align:left;padding:.4rem 1rem .4rem 0;vertical-align:top;white-space:nowrap}td{padding:.4rem 0;word-break:break-word}
@media (prefers-color-scheme:dark){body{color:#e8e8e8;background:#141414}a{color:#8ab4f8}}</style></head>
<body><h1>Hermes coding agent</h1>
<table>
${body}
</table>
<p>Follow each run in the app's Activity tab and in the pull requests it opens.</p>
</body></html>
`;
}
