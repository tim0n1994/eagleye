/* global process, __dirname, console */
// Synthetic local data only. Refuse an existing database or a non-QA path.
const fs = require('node:fs');
const path = require('node:path');
const qaRoot = path.resolve(__dirname, '../../.gstack/qa-reports');
const target = path.resolve(process.argv[2] || path.join(qaRoot, 'tp-20261108/acceptance.db'));
if (!target.startsWith(qaRoot + path.sep) || fs.existsSync(target)) throw new Error('Choose a NEW database under .gstack/qa-reports');
fs.mkdirSync(path.dirname(target), {recursive: true});
process.env.EAGLEYE_DB_PATH = target;
require('../../server/db/migrate').runMigrations();
const db = require('../../server/db/connection').getDB();
const hash = require('bcryptjs').hashSync('TP-acceptance-only-2026',10);
db.transaction(() => {
  for (const role of ['admin','user']) db.prepare('INSERT INTO users (id,email,password_hash,display_name,role,email_verified) VALUES (?,?,?,?,?,1)').run('qa-'+role,role+'@eagleye.test',hash,'QA '+role,role);
  const source = db.prepare('SELECT id FROM sources LIMIT 1').get().id;
  for (let i=1;i<=8;i++) {
    db.prepare(`INSERT INTO information_items (id,source_id,canonical_url,title,title_zh,original_summary,content_text,published_at,digest_date,score,language) VALUES (?,?,?,?,?,?,?,datetime('now'),date('now'),0.85,'en')`).run('qa-item-'+i,source,'https://example.test/article/'+i,'Eagleye Browser Acceptance '+i,'Eagleye 浏览器验收情报 '+i,'Synthetic intelligence for local acceptance','Synthetic browser acceptance article');
    db.prepare(`INSERT INTO ai_summaries (id,item_id,model_provider,model_name,prompt_version,one_liner,one_liner_zh) VALUES (?,?,'fixture','fixture','v1',?,?)`).run('qa-summary-'+i,'qa-item-'+i,'Browser verification signal','浏览器功能验证信号');
    db.prepare("INSERT INTO signal_scores(item_id,signal_type,alpha_score,evidence_summary) VALUES (?,'origin_signal',0.85,'Synthetic browser acceptance evidence')").run('qa-item-'+i);
  }
})();
require('../../server/db/connection').closeDB();
console.log('Created isolated QA database: '+target);
