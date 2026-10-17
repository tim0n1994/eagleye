/* global describe, it, expect, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDBPath } = require('../../config');
const { getDB, closeDB } = require('../../db/connection');

const previousPath = process.env.EAGLEYE_DB_PATH;

afterEach(() => {
  closeDB();
  if (previousPath === undefined) delete process.env.EAGLEYE_DB_PATH;
  else process.env.EAGLEYE_DB_PATH = previousPath;
});

describe('isolated database configuration', () => {
  it('keeps the existing default independent of the caller directory', () => {
    delete process.env.EAGLEYE_DB_PATH;
    expect(getDBPath()).toBe(path.resolve(__dirname, '../../../eagleye.db'));
  });

  it('opens the explicitly configured database and preserves it across connections', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-db-path-'));
    process.env.EAGLEYE_DB_PATH = path.join(directory, 'acceptance.sqlite');
    const db = getDB();
    expect(db.name).toBe(process.env.EAGLEYE_DB_PATH);
    db.exec('CREATE TABLE acceptance (value TEXT)');
    db.prepare('INSERT INTO acceptance VALUES (?)').run('isolated');
    closeDB();
    expect(getDB().prepare('SELECT value FROM acceptance').get().value).toBe('isolated');
  });
});
