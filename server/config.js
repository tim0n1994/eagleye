const path = require('path');

const DEFAULT_APP_PORT = 3019;

function getDBPath() {
  const configured = process.env.EAGLEYE_DB_PATH?.trim();
  return configured ? path.resolve(configured) : path.resolve(__dirname, '..', 'eagleye.db');
}

function parsePort(value, fallback = DEFAULT_APP_PORT) {
  const port = parseInt(value, 10);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

module.exports = {
  DEFAULT_APP_PORT,
  parsePort,
  getDBPath,
};
