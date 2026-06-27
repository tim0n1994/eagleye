const DEFAULT_APP_PORT = 3019;

function parsePort(value, fallback = DEFAULT_APP_PORT) {
  const port = parseInt(value, 10);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

module.exports = {
  DEFAULT_APP_PORT,
  parsePort,
};
