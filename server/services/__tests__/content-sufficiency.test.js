// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const previousPath = process.env.EAGLEYE_DB_PATH;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r0-sufficiency-'));
process.env.EAGLEYE_DB_PATH = path.join(directory, 't.db');

const { getDB, closeDB } = require('../../db/connection');
const { CONFIG_KEY, getSwitches, setSwitches } = require('../runtime-switches');
const {
  CONTENT_STATES,
  BLOCKING_STATES,
  classifyContentState,
  shouldBlockDeepEnrich,
  isSufficiencyGateEnabled,
  deepEnrichSkipReason,
  isDigestInclusionBlocked,
} = require('../content-sufficiency');

const fullBody = 'We introduce a new mixture-of-experts training recipe with strong benchmark gains. '.repeat(4);

const titleOnly = { id: 'i1', title: 'OpenAI previews o5', content_text: null, original_summary: null };
const duplicateTitleBody = { id: 'i1d', title: 'OpenAI previews o5', content_text: 'OpenAI previews o5' };
const abstractOnly = { id: 'i2', title: 'DeepSeek ships V4', original_summary: 'DeepSeek released V4 weights with open licensing today.', content_text: null };
const withBody = { id: 'i3', title: 'MoE recipe', content_text: fullBody, original_summary: null };
const emptyItem = {};
const wallItem = { id: 'i5', title: 'Some tweet', content_text: 'Log in or sign up to see the conversation' };
const zhWallItem = { id: 'i5z', title: '会员内容', original_summary: '请先登录后查看全文' };
const junkItem = { id: 'i6', title: 'Blocked', content_text: '<div><script>var x=1;</script></div>' };
const antiBotItem = { id: 'i6b', title: 'Blocked', content_text: 'Just a moment... Enable JavaScript and cookies to continue' };
const ellipsisPartial = { id: 'i7', title: 'Truncated', content_text: fullBody.slice(0, 180) + '…' };
const payloadPartial = { id: 'i8', title: 'Flagged', content_text: fullBody, source_payload: JSON.stringify({ truncated: true }) };
const longLoginMention = { id: 'i9', title: 'Auth guide', content_text: 'This guide explains OAuth. ' + 'Sign in to your account to rotate API keys safely. '.repeat(12) };

const stateFixtures = {
  TITLE_ONLY: titleOnly,
  ABSTRACT_ONLY: abstractOnly,
  FULL: withBody,
  UNKNOWN: emptyItem,
  LOGIN_WALL: wallItem,
  UNREADABLE: junkItem,
  PARTIAL: ellipsisPartial,
};

function writeRawSwitchValue(value) {
  getDB().prepare("INSERT OR REPLACE INTO user_data (key, user_id, value) VALUES (?, '', ?)").run(CONFIG_KEY, value);
}

beforeAll(() => {
  getDB().exec([
    'CREATE TABLE IF NOT EXISTS user_data (',
    '  key TEXT NOT NULL,',
    "  user_id TEXT NOT NULL DEFAULT '',",
    '  value TEXT,',
    '  PRIMARY KEY (key, user_id)',
    '  )',
  ].join('\n'));
});

afterAll(() => {
  closeDB();
  if (previousPath === undefined) delete process.env.EAGLEYE_DB_PATH;
  else process.env.EAGLEYE_DB_PATH = previousPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

afterEach(() => {
  getDB().prepare('DELETE FROM user_data').run();
});

describe('classifyContentState', () => {
  it('maps each fixture to its exact closed-set state', () => {
    expect([...CONTENT_STATES].sort()).toEqual(['ABSTRACT_ONLY', 'FULL', 'LOGIN_WALL', 'PARTIAL', 'TITLE_ONLY', 'UNKNOWN', 'UNREADABLE']);
    for (const [state, fixture] of Object.entries(stateFixtures)) {
      expect(classifyContentState(fixture)).toBe(state);
    }
  });

  it('treats title-duplicating bodies as title-only', () => {
    expect(classifyContentState(duplicateTitleBody)).toBe('TITLE_ONLY');
  });

  it('detects Chinese login walls stored as the abstract', () => {
    expect(classifyContentState(zhWallItem)).toBe('LOGIN_WALL');
  });

  it('detects anti-bot interstitials as unreadable', () => {
    expect(classifyContentState(antiBotItem)).toBe('UNREADABLE');
  });

  it('recognises payload truncation flags as partial', () => {
    expect(classifyContentState(payloadPartial)).toBe('PARTIAL');
  });

  it('keeps long articles mentioning sign-in as full', () => {
    expect(classifyContentState(longLoginMention)).toBe('FULL');
  });

  it('degrades null and malformed items to unknown', () => {
    expect(classifyContentState(null)).toBe('UNKNOWN');
    expect(classifyContentState('nope')).toBe('UNKNOWN');
    expect(classifyContentState({ title: '   ' })).toBe('UNKNOWN');
  });
});

describe('shouldBlockDeepEnrich', () => {
  it('blocks exactly TITLE_ONLY, LOGIN_WALL, and UNREADABLE', () => {
    expect([...BLOCKING_STATES].sort()).toEqual(['LOGIN_WALL', 'TITLE_ONLY', 'UNREADABLE']);
    for (const [state, fixture] of Object.entries(stateFixtures)) {
      expect(shouldBlockDeepEnrich(fixture)).toBe(BLOCKING_STATES.includes(state));
    }
    expect(shouldBlockDeepEnrich(antiBotItem)).toBe(true);
    expect(shouldBlockDeepEnrich(payloadPartial)).toBe(false);
  });
});

describe('sufficiency gate', () => {
  it('defaults to enabled with no stored config and gates wall items', () => {
    expect(isSufficiencyGateEnabled()).toBe(true);
    expect(deepEnrichSkipReason(wallItem)).toBe('content_state=LOGIN_WALL');
    expect(deepEnrichSkipReason(abstractOnly)).toBe(null);
    expect(isDigestInclusionBlocked(titleOnly)).toBe(true);
    expect(isDigestInclusionBlocked(antiBotItem)).toBe(true);
    expect(isDigestInclusionBlocked(withBody)).toBe(false);
  });

  it('retracts the new thresholds when switched off but keeps the pure predicate', () => {
    setSwitches({ sufficiency_gate: false });
    expect(isSufficiencyGateEnabled()).toBe(false);
    expect(deepEnrichSkipReason(wallItem)).toBe(null);
    expect(deepEnrichSkipReason(junkItem)).toBe(null);
    expect(isDigestInclusionBlocked(wallItem)).toBe(false);
    expect(isDigestInclusionBlocked(titleOnly)).toBe(false);
    expect(shouldBlockDeepEnrich(wallItem)).toBe(true);
    setSwitches({ sufficiency_gate: true });
    expect(deepEnrichSkipReason(wallItem)).toBe('content_state=LOGIN_WALL');
  });

  it('falls back to gate-on through pure getValue injection with corrupt config', () => {
    expect(getSwitches(() => 'not-json{{{')).toEqual({
      collect: true, enrich: true, translate: true, digest: true, research: true, graph: true, sufficiency_gate: true,
    });
    expect(getSwitches(() => '"just a string"').sufficiency_gate).toBe(true);
    expect(getSwitches(() => '[true, false]').sufficiency_gate).toBe(true);
    expect(getSwitches(() => JSON.stringify({ sufficiency_gate: false })).sufficiency_gate).toBe(false);
  });

  it('falls back to gate-on when the stored user_data row is corrupted', () => {
    writeRawSwitchValue('not-json{{{');
    expect(isSufficiencyGateEnabled()).toBe(true);
    expect(deepEnrichSkipReason(wallItem)).toBe('content_state=LOGIN_WALL');
    expect(isDigestInclusionBlocked(titleOnly)).toBe(true);
  });

  it('keeps the gate on for stored non-object JSON values', () => {
    writeRawSwitchValue('"just a string"');
    expect(isSufficiencyGateEnabled()).toBe(true);
    writeRawSwitchValue('[true]');
    expect(isSufficiencyGateEnabled()).toBe(true);
    writeRawSwitchValue(JSON.stringify(JSON.stringify({ enrich: false })));
    expect(isSufficiencyGateEnabled()).toBe(true);
    expect(getSwitches().enrich).toBe(false);
  });
});
