'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { claudeRemoteMirrors } = require('../../src/shared/claudeRemoteMirrors');
const { collectUsageOnce, tokscaleCommand, localTodayKey, configFingerprint } = require('../../src/shared/collector');
const { captureSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');

const id = '11111111-2222-4333-8444-555555555555';
const nativeBinary = process.env.TOKEN_MONITOR_TOKSCALE_CLAUDE_WSL_CLI;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-remote-mirrors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, '.claude/projects');
  const mirror = path.join(projects, `ssh-${id}`);
  fs.mkdirSync(mirror, { recursive: true });
  fs.mkdirSync(path.join(projects, 'ssh-my-project'));
  return { root, projects, mirror, options: {
    homeDir: root, env: {}, mirrorStatePath: path.join(root, 'selection.json'), claudeRemoteMirrorsExcluded: true
  } };
}

test('explicit mirror selection is narrow, durable, reversible, and respects the configured Claude root', (t) => {
  const { root, projects, mirror, options } = fixture(t);
  assert.deepEqual(claudeRemoteMirrors({ ...options, claudeRemoteMirrorsExcluded: false }), { dirs: [], sessionKeys: [] });
  const selected = claudeRemoteMirrors(options);
  assert.deepEqual(selected, { root: projects, dirs: [mirror], sessionKeys: [`claude:${id}`] });
  fs.rmSync(projects, { recursive: true });
  assert.deepEqual(claudeRemoteMirrors(options), selected, 'deleted mirrors remain excluded from retained source caches');
  assert.deepEqual(claudeRemoteMirrors({ ...options, env: { CLAUDE_CONFIG_DIR: path.join(root, 'other') } }).dirs, []);
  assert.equal(tokscaleCommand({ claudeExcludedDirs: [mirror] }).env.TOKSCALE_EXCLUDED_CLAUDE_DIRS, JSON.stringify([mirror]));
  assert.equal(tokscaleCommand().env.TOKSCALE_EXCLUDED_CLAUDE_DIRS, undefined);
});

test('remote ownership disables built-in WSL, protects session archive projection and refuses an unsupported binary', async (t) => {
  const { options } = fixture(t);
  const common = {
    ...options, platform: 'win32', clients: 'claude', deviceId: 'host', allTimeSince: '2020-01-01',
    projectsEnabled: false, historyEnabled: false,
    collectWslUsage: () => assert.fail('remote ownership must disable WSL scanning'),
    probeWslState: () => assert.fail('remote ownership must not probe WSL')
  };
  await assert.rejects(collectUsageOnce({ ...common, runTokscale: async () => ({ entries: [] }) }), /lacks Claude source exclusions/);
  let captured;
  let calls = 0;
  const scan = { ...common, runTokscale: async () => { calls += 1; return { claudeSourceExclusions: true, entries: [] }; },
    onAnchorComputed: value => { captured = value; } };
  const result = await collectUsageOnce(scan);
  const anchor = { dateKey: localTodayKey(), ...captured.windowsPeriods, excludedSessionKeys: captured.excludedSessionKeys };
  calls = 0;
  await collectUsageOnce({ ...scan, todayOnlyAnchor: anchor });
  assert.equal(calls, 1, 'unchanged exclusions keep the Today-only fast path');
  fs.mkdirSync(path.join(options.homeDir, '.claude/projects/ssh-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'));
  calls = 0;
  await collectUsageOnce({ ...scan, todayOnlyAnchor: anchor });
  assert.equal(calls, 3, 'new exclusions rebuild old days instead of applying only a Today delta');
  assert.deepEqual(result.excludedSessionKeys, [`claude:${id}`]);
  assert.equal(result.wslStatus.state, 'disabled');
  const archive = captureSessionUsageArchive(null, { allTime: { sessions: {
    [`claude:${id}`]: { client: 'claude', sessionId: id, totalTokens: 100 },
    'claude:local': { client: 'claude', sessionId: 'local', totalTokens: 20 }
  } } });
  const visible = applySessionUsageArchive(result, archive);
  assert.equal(visible.allTime.totalTokens, 20);
  assert.equal(visible.allTime.sessions[`claude:${id}`], undefined);
  assert.equal(applySessionUsageArchive({ ...result, excludedSessionKeys: [] }, archive).allTime.totalTokens, 120, 'disabling exclusion restores retained data');
});

test('actual CLI: native Windows + remote Agent totals remain exact with warm and deleted mirrors', {
  skip: !nativeBinary && 'set TOKEN_MONITOR_TOKSCALE_CLAUDE_WSL_CLI to the candidate binary'
}, async (t) => {
  const { root, mirror, projects, options } = fixture(t);
  const at = new Date().toISOString();
  const event = (session, key, tokens) => JSON.stringify({ type: 'assistant', sessionId: session, timestamp: at, requestId: `r_${key}`,
    message: { id: `m_${key}`, model: 'claude-sonnet-4-6', usage: { input_tokens: tokens, output_tokens: 0 } } }) + '\n';
  const mirrorFile = path.join(mirror, `${id}.jsonl`);
  fs.writeFileSync(mirrorFile, event(id, 'remote', 100));
  const local = path.join(projects, 'local');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'local.jsonl'), event('local', 'local', 20));
  fs.writeFileSync(path.join(projects, 'ssh-my-project', 'other.jsonl'), event('other', 'other', 40));
  const run = (input = {}, graph = false) => {
    const env = { ...tokscaleCommand(input).env, HOME: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
      TOKSCALE_CONFIG_DIR: path.join(root, 'config'), TOKSCALE_EXTRA_DIRS: '', TOKSCALE_PRICING_CACHE_ONLY: '1' };
    const args = graph ? ['graph', '--client', 'claude', '--no-spinner']
      : ['--json', '--client', 'claude', '--group-by', 'client,workspace,session,model', '--since', '2020-01-01', '--no-spinner'];
    return JSON.parse(execFileSync(nativeBinary, args, { env, encoding: 'utf8', timeout: 30000 }));
  };
  assert.equal(run().totalInput, 160, 'old Windows snapshot includes the remote mirror');
  fs.writeFileSync(mirrorFile, '{"type":"assistant","message":');
  assert.equal(run().totalInput, 160, 'compacted mirror history is retained before exclusion');
  // The root contract must cover mirrors created after App discovery too.
  const selected = claudeRemoteMirrors(options);
  const input = { claudeRemoteMirrorRoot: selected.root };
  assert.equal(run(input).totalInput + 100, 160, 'Windows 60 + Agent 100, not Windows 160 + Agent 100');
  assert.equal(run(input).claudeSourceExclusions, true);
  assert.equal(run(input, true).contributions.reduce((sum, day) => sum + day.totals.tokens, 0), 60);
  fs.rmSync(mirror, { recursive: true });
  assert.equal(run(input).totalInput, 60, 'a warm retained mirror cannot reappear');
  assert.equal(run().totalInput, 160, 'the selection does not erase cached history');
});

test('mirror source transport stays bounded with many sessions', (t) => {
  const { projects, options } = fixture(t);
  for (let index = 0; index < 400; index += 1) {
    fs.mkdirSync(path.join(projects, `ssh-${index.toString(16).padStart(8, '0')}-2222-4333-8444-555555555555`));
  }
  const selected = claudeRemoteMirrors(options);
  assert.ok(JSON.stringify(selected.dirs).length > 32767);
  const env = tokscaleCommand({ claudeRemoteMirrorRoot: selected.root }).env;
  assert.equal(env.TOKSCALE_CLAUDE_REMOTE_MIRROR_ROOT, projects);
  assert.equal(env.TOKSCALE_EXCLUDED_CLAUDE_DIRS, undefined);
  assert.equal(tokscaleCommand().env.TOKSCALE_CLAUDE_REMOTE_MIRROR_ROOT, undefined);
});

test('mirror archive exclusion includes linked child sessions and uppercase UUID directories', (t) => {
  const { projects, options } = fixture(t);
  const uuid = 'abcdefab-1234-5678-abcd-abcdefabcdef';
  fs.mkdirSync(path.join(projects, `SSH-${uuid.toUpperCase()}`));
  const selection = claudeRemoteMirrors(options);
  const archive = captureSessionUsageArchive(null, { allTime: { sessions: {
    [`claude:${uuid}`]: { client: 'claude', sessionId: uuid, totalTokens: 100 },
    'claude:agent-child': { client: 'claude', sessionId: 'agent-child', parentSessionId: uuid, totalTokens: 30 },
    'claude:native': { client: 'claude', sessionId: 'native', totalTokens: 20 }
  } } });
  const visible = applySessionUsageArchive({ allTime: { sessions: {} }, excludedSessionKeys: selection.sessionKeys }, archive);
  assert.equal(visible.allTime.totalTokens, 20);
});

test('mirror policy anchors cannot be reused after the effective Claude root changes', () => {
  const fingerprint = root => configFingerprint('claude', '2020-01-01', true, '', '', null, '', {
    claudeRemoteMirrorsExcluded: true, env: { CLAUDE_CONFIG_DIR: root }
  }, '');
  assert.notEqual(fingerprint('/first'), fingerprint('/second'));
});
