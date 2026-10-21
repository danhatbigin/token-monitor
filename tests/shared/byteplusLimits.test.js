'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const byteplus = require('../../src/shared/providers/byteplus/limits');

const now = '2026-10-21T08:00:00.000Z';
function response() {
  return { items: [
    { product: 'agent-plan', subscribed: true, periods: [{ label: '5h', percent: 99 }] },
    { product: 'coding-plan', subscribed: true, periods: [
      { label: '5h', percent: 25.5, reset_at: '2026-10-21T18:00:00+07:00' },
      { label: 'weekly', percent: 0 }, { label: 'monthly', percent: 100 }
    ] }
  ] };
}

test('Coding Plan percentages are USED and do not require token totals or identity', () => {
  assert.equal(typeof byteplus.parseBytePlusPlan, 'function');
  const row = byteplus.parseBytePlusPlan(response(), now);
  assert.equal(row.provider, 'byteplus');
  assert.equal(row.status, 'ok');
  assert.deepEqual(row.windows.map(w => [w.kind, w.remainingPercent]), [
    ['session', 74.5], ['weekly', 100], ['billing', 0]
  ]);
  assert.equal(row.windows[0].resetsAt, '2026-10-21T11:00:00.000Z');
  assert.equal(row.windows[1].resetsAt, null);
});

test('session label is supported and unknown windows are ignored', () => {
  const body = response();
  body.items[1].periods = [{ label: 'session', percent: 12 }, { label: 'daily', percent: 99 }];
  const row = byteplus.parseBytePlusPlan(body, now);
  assert.equal(row.windows.length, 1);
  assert.equal(row.windows[0].remainingPercent, 88);
});

test('unsubscribed is distinct from missing, malformed or failed quota', () => {
  const body = response();
  body.items[1].subscribed = false;
  assert.equal(byteplus.parseBytePlusPlan(body, now), null);
  for (const invalid of [null, {}, { items: [] }, { items: [body.items[0]] }]) {
    assert.throws(() => byteplus.parseBytePlusPlan(invalid, now), /BytePlus quota unavailable/);
  }
  for (const percent of [undefined, null, '10', -1, 101, NaN, Infinity]) {
    const malformed = response();
    malformed.items[1].periods[0].percent = percent;
    assert.throws(() => byteplus.parseBytePlusPlan(malformed, now), /BytePlus quota unavailable/);
  }
});

test('registered collector invokes only the read-only Coding Plan command and feeds Edge Dock', async () => {
  const { collectLimitsOnce } = require('../../src/shared/limits/collector');
  const { connectedLimitProviders, buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');
  const calls = [];
  const limits = await collectLimitsOnce({ limitProviders: ['byteplus'] }, {
    now: () => Date.parse(now), runArkcli: async args => { calls.push(args); return response(); }
  });
  assert.deepEqual(calls, [['usage', 'plan', '--product', 'coding-plan', '--format', 'json']]);
  assert.equal(limits.providers[0].provider, 'byteplus');
  assert.equal(limits.providers[0].windows[0].remainingPercent, 74.5);
  assert.deepEqual(connectedLimitProviders({ limits }), ['byteplus']);
  const cells = buildEdgeDockCells({ limits }, { items: [{ type: 'limit', provider: 'byteplus' }] });
  assert.equal(cells[0].remainingPercent, 0);
  const { limitWindowKey } = require('../../src/electron/renderer/edgeDock/items');
  for (const window of limits.providers[0].windows) {
    const selected = buildEdgeDockCells({ limits }, { items: [
      { type: 'limit', provider: 'byteplus', windowKey: limitWindowKey(window) }
    ] });
    assert.equal(selected[0].remainingPercent, window.remainingPercent);
  }
});

test('refresh retains last good quota during failure and replaces it after reset', async t => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  let body = response();
  let time = Date.parse(now);
  const runtime = createLimitsRuntime({ limitProviders: ['byteplus'] }, {
    autoStart: false, now: () => time,
    probeProvider: () => byteplus.fetchBytePlusLimits({}, { now: () => time,
      runArkcli: async () => body })
  });
  t.after(() => runtime.stop());
  await runtime.refresh({}, 'manual');
  assert.equal(runtime.getSnapshot().providers[0].windows[0].remainingPercent, 74.5);
  body = {};
  time += 60000;
  await runtime.refresh({}, 'manual');
  assert.equal(runtime.getSnapshot().providers[0].status, 'unavailable');
  assert.equal(runtime.getSnapshot().providers[0].windows[0].remainingPercent, 74.5);
  body = response();
  body.items[1].periods[0].percent = 0;
  time += 60000;
  await runtime.refresh({}, 'manual');
  assert.equal(runtime.getSnapshot().providers[0].status, 'ok');
  assert.equal(runtime.getSnapshot().providers[0].windows[0].remainingPercent, 100);
});

test('probe errors never expose CLI output; missing CLI is not configured', async () => {
  for (const status of ['notConfigured', 'unavailable']) {
    const rows = await byteplus.fetchBytePlusLimits({}, { runArkcli: async () => {
      throw Object.assign(new Error('secret credential response'), { status });
    } });
    assert.equal(rows[0].status, status);
    assert.ok(!JSON.stringify(rows).includes('secret'));
  }
});

test('aborted refresh propagates cancellation', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(byteplus.fetchBytePlusLimits({}, { signal }), { name: 'AbortError' });
});

test('BytePlus npm installation resolves its native executable', { skip: process.platform !== 'win32' }, t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { resolveArkcliCommand } = require('../../src/shared/providers/volcengine/arkcli');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-byteplus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'node_modules', '@byteplus', 'ark-cli');
  const binary = path.join(pkg, 'bin', 'arkcli-windows-amd64.exe');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '');
  fs.writeFileSync(path.join(root, 'arkcli.cmd'), '');
  assert.equal(resolveArkcliCommand({ PATH: root }, 'win32', 'x64', '@byteplus'), binary);
});
