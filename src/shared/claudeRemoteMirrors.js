'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sharedDataDir, writeJsonAtomic } = require('./config');
const { claudeSessionRoots } = require('./providers/claude/paths');

const MIRROR_NAME = /^ssh-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function claudeRemoteMirrorRoot(options = {}) {
  return path.resolve(claudeSessionRoots({ homeDir: options.homeDir || os.homedir(), env: options.env }).projects);
}

// This is an explicit SSH-mirror policy, not automatic proof of WSL ownership.
// Keep selections after a mirror disappears, since Tokscale and the session
// archive retain observed usage. No transcript content is stored here.
function claudeRemoteMirrors(options = {}) {
  if (options.claudeRemoteMirrorsExcluded !== true) return { dirs: [], sessionKeys: [] };
  const root = claudeRemoteMirrorRoot(options);
  const file = options.mirrorStatePath || path.join(sharedDataDir(), 'claude-remote-mirrors.json');
  let state = { roots: {} };
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state?.roots || typeof state.roots !== 'object') throw new Error('invalid mirror selection state');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const previous = Array.isArray(state.roots[root]) ? state.roots[root].filter(name => MIRROR_NAME.test(name)) : [];
  const names = new Set(previous);
  try {
    for (const name of fs.readdirSync(root)) if (MIRROR_NAME.test(name)) names.add(name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (names.size !== previous.length && options.anchorPersistenceEnabled !== false) {
    state.roots[root] = [...names].sort();
    writeJsonAtomic(file, state);
  }
  return {
    root,
    dirs: [...names].sort().map(name => path.join(root, name)),
    sessionKeys: [...names].sort().map(name => `claude:${name.slice(4).toLowerCase()}`)
  };
}

module.exports = { claudeRemoteMirrors, claudeRemoteMirrorRoot };
