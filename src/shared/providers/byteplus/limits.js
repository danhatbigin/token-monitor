'use strict';
const { normalizeLimitProvider } = require('../../limits/core');
const { abortError } = require('../../probeDeadline');
const { hashKey } = require('../../hashKey');
const { runArkcli } = require('../volcengine/arkcli');

const WINDOWS = [
  [['5h', 'session'], 'session', 'Session', 300],
  [['weekly'], 'weekly', 'Weekly', 10080],
  [['monthly'], 'billing', 'Monthly', 43200]
];

function quotaError() {
  return new Error('BytePlus quota unavailable');
}

function parseBytePlusPlan(body, updatedAt) {
  const item = Array.isArray(body?.items)
    ? body.items.find(entry => entry?.product === 'coding-plan') : null;
  if (!item || item.error || typeof item.subscribed !== 'boolean') throw quotaError();
  if (!item.subscribed) return null;
  if (!Array.isArray(item.periods)) throw quotaError();
  const windows = [];
  for (const [labels, kind, label, windowMinutes] of WINDOWS) {
    const period = item.periods.find(entry => labels.includes(entry?.label));
    if (!period) continue;
    const usedPercent = period.percent;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)
      || usedPercent < 0 || usedPercent > 100) throw quotaError();
    const reset = typeof period.reset_at === 'string' ? Date.parse(period.reset_at) : NaN;
    windows.push({ kind, label, windowMinutes, usedPercent,
      resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null, showMeter: true });
  }
  if (!windows.length) throw quotaError();
  const viewer = body.viewer;
  return normalizeLimitProvider({ provider: 'byteplus', source: 'cli', status: 'ok', updatedAt,
    accountKey: viewer?.account_id
      ? hashKey('byteplus', viewer.account_id, viewer.user_id || '', 'coding-plan') : '',
    windows });
}

async function fetchBytePlusLimits(_options = {}, deps = {}) {
  if (deps.signal?.aborted) throw abortError(deps.signal);
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  const status = value => normalizeLimitProvider({ provider: 'byteplus', source: 'cli',
    status: value, updatedAt, windows: [] });
  try {
    const run = deps.runArkcli || (args => runArkcli(args, { ...deps, arkcliPackageScope: '@byteplus' }));
    const body = await run(['usage', 'plan', '--product', 'coding-plan', '--format', 'json']);
    return [parseBytePlusPlan(body, updatedAt) || status('notConfigured')];
  } catch (error) {
    if (deps.signal?.aborted) throw abortError(deps.signal);
    return [status(error.status === 'notConfigured' ? 'notConfigured' : 'unavailable')];
  }
}

module.exports = { parseBytePlusPlan, fetchBytePlusLimits };
