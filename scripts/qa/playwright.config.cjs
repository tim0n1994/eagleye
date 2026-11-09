/* global process, __dirname */
const path = require('node:path');
const runtime = process.env.TP_BROWSER_ROOT || path.join(require('node:os').homedir(), '.local/share/tp-browser');
const reportDir = path.resolve(process.env.TP_QA_REPORT_DIR || path.join(__dirname, '../../.gstack/qa-reports/tp-20261108'));
const { defineConfig } = require(path.join(runtime, 'node_modules/@playwright/test'));
module.exports = defineConfig({
  testDir: __dirname, testMatch: 'eagleye.spec.cjs', workers: 1, fullyParallel: false,
  retries: 1, failOnFlakyTests: true, timeout: 30000,
  outputDir: path.join(reportDir, 'results'),
  reporter: [['list'], ['html', {outputFolder: path.join(reportDir, 'report'),open:'never'}], ['json',{outputFile:path.join(reportDir, 'results.json')}]],
  use: {baseURL:process.env.TP_BASE_URL || 'http://127.0.0.1:18766',channel:'chromium',headless:true,viewport:{width:1440,height:900},screenshot:'only-on-failure',trace:'on-first-retry',video:'off'},
});
