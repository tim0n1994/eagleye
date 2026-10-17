/**
 * R0-05 degradation switches: pausing a stage stops only NEW stage work;
 * accepted tasks and reading APIs are unaffected. Defaults stay enabled so a
 * missing or corrupted config can never silently disable the pipeline.
 */

const CONFIG_KEY = 'runtime_switches';

const SWITCH_KEYS = ['collect', 'enrich', 'translate', 'digest', 'research', 'graph', 'sufficiency_gate'];

function defaultSwitches() {
  return Object.fromEntries(SWITCH_KEYS.map(key => [key, true]));
}

function parseStored(raw) {
  let stored;
  try { stored = JSON.parse(raw || '{}') || {}; } catch { stored = {}; }
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/** @param {(key: string) => string | null | undefined} getValue */
function readStoredValue(getValue) {
  try {
    return getValue(CONFIG_KEY);
  } catch {
    return null;
  }
}

/**
 * @param {(key: string) => string | null | undefined} [getValue]
 * @returns {Record<string, boolean>}
 */
function getSwitches(getValue = key => require('../db/user-data').getValue(key)) {
  const stored = parseStored(readStoredValue(getValue));
  return Object.fromEntries(SWITCH_KEYS.map(key => [key, stored[key] !== false]));
}

/** @param {{ getValue?: (key: string) => string | null | undefined, setValue?: (key: string, value: string) => void }} [io] */
function setSwitches(patch, io = {}) {
  const getValue = io.getValue || (key => require('../db/user-data').getValue(key));
  const setValue = io.setValue || ((key, value) => require('../db/user-data').setValue(key, value));
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Switch patch must be an object');
  const validated = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!SWITCH_KEYS.includes(key)) throw new Error('Unknown runtime switch: ' + key);
    if (typeof value !== 'boolean') throw new Error('Runtime switch ' + key + ' must be boolean');
    validated[key] = value;
  }
  const next = { ...getSwitches(getValue), ...validated };
  setValue(CONFIG_KEY, JSON.stringify(next));
  return next;
}

module.exports = { CONFIG_KEY, SWITCH_KEYS, defaultSwitches, getSwitches, setSwitches };
