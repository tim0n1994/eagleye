'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
let worker;
let stopped = false;
function start() {
  if (worker || stopped) return;
  worker = new Worker(path.join(__dirname,'intelligence-worker.js'), {
    workerData:{dbPath:require('../config').getDBPath()}, resourceLimits:{maxOldGenerationSizeMb:128},
  });
  worker.on('error',error => console.warn('[intelligence-index]',error.message));
  worker.on('exit',() => { worker=null; if (!stopped) setTimeout(start,30000).unref(); });
  worker.unref();
}
function stop() { stopped=true; return worker?.terminate(); }
module.exports={start,stop};
