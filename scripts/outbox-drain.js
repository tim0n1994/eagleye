#!/usr/bin/env node
/** Drain the transactional outbox in a bounded, idempotent batch. */
'use strict';

const Database = require('better-sqlite3');
const { getDBPath } = require('../server/config');
const { drainIndexOutbox } = require('../server/services/outbox-consumer');

const limit = Number.parseInt(process.env.EAGLEYE_OUTBOX_DRAIN_LIMIT || '5000', 10);
const maxAttempts = Number.parseInt(process.env.EAGLEYE_OUTBOX_MAX_ATTEMPTS || '5', 10);
const db = new Database(getDBPath());
db.pragma('busy_timeout = 30000');

drainIndexOutbox(db, { limit, maxAttempts })
  .then(result => {
    console.log(JSON.stringify({ limit, maxAttempts, dispatched: result.dispatched.length, failed: result.failed }, null, 2));
    if (result.failed.length > 0) process.exitCode = 1;
  })
  .catch(error => {
    console.error(`outbox drain failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
