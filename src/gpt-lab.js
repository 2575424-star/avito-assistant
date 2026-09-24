// Dedicated Egor laboratory. Reuses isolated lab execution and existing key profiles.
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');
const lab = require('./lab');
const history = require('./history');
const dir = path.join(__dirname, 'gpt-lab');
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
const questions = JSON.parse(read('cases.json'));
const keys = ['gpt_egor_formal', 'gpt_egor_friendly'];
const titles = ['Егор · формальный', 'Егор · неформальный'];
const now = () => Math.floor(Date.now() / 1000);
keys.forEach((key, i) => db.prepare('INSERT OR IGNORE INTO agent_versions(key,version,title,base_prompt,strategy,status,created) VALUES(?,?,?,?,?,?,?)')
  .run(key, 'egor-1', titles[i], read('common.md'), read(i ? 'friendly.md' : 'formal.md'), 'lab_only', now()));
for (const c of questions) db.prepare('INSERT OR IGNORE INTO lab_cases(id,set_name,version,title,facts,client_turns,turn_mode,expected,created) VALUES(?,?,?,?,?,?,?,?,?)')
  .run(c.id, 'gpt_egor', c.version, c.title, JSON.stringify(c.facts), JSON.stringify(c.client_turns), c.turn_mode, JSON.stringify(c.expected), now());

function versions() { return keys.map(key => db.prepare("SELECT id,key,title,version FROM agent_versions WHERE key=? AND version='egor-1'").get(key)); }
function config() {
  const profiles = lab.profiles();
  const models = ['gpt-6-sol', 'gpt-6-luna'].map(name => {
    const matches = lab.models().filter(m => m.model === name);
    const model = matches.find(m => profiles.some(p => p.id === m.key_profile_id && p.has_key && p.provider === 'openai')) || matches[0];
    const profile = profiles.find(p => p.id === model?.key_profile_id);
    return { id: model?.id, model: name, label: name.endsWith('sol') ? 'GPT-6 Sol' : 'GPT-6 Luna', profile: profile?.name || '', ready: Boolean(profile?.has_key && profile.provider === 'openai') };
  });
  return { strategies: versions(), models, questions };
}
function start(body) {
  const ids = [...new Set(Array.isArray(body.caseIds) ? body.caseIds : [])];
  if (!ids.length || ids.length > 16 || ids.some(id => !questions.some(q => q.id === id))) throw new Error('Выберите от 1 до 16 контрольных вопросов');
  const c = config();
  if (c.models.some(m => !m.ready)) throw new Error('Подключите отдельный профиль OpenAI к Sol и Luna в настройках существующей лаборатории');
  if (new Set(c.models.map(m => lab.models().find(x => x.id === m.id).key_profile_id)).size !== 2) throw new Error('Для раздельного учёта назначьте Sol и Luna разные профили ключей');
  return lab.start({ caseIds: ids, versionIds: c.strategies.map(v => v.id), modelIds: c.models.map(m => m.id), repeats: 1, concurrency: 2, limitUsd: 25 }, (_, fn) => history.startJob('gpt_lab', fn));
}
function results(batch) {
  const batches = db.prepare("SELECT DISTINCT r.batch, MAX(r.created) created FROM lab_runs r JOIN agent_versions v ON v.id=r.version_id WHERE v.key IN (?,?) GROUP BY r.batch ORDER BY created DESC, r.batch DESC LIMIT 50").all(...keys);
  const selected = batch || batches[0]?.batch || null;
  const runs = selected ? lab.runs({ batch: selected, limit: 1000 }).filter(r => keys.includes(r.v_key)).map(r => ({ id:r.id, case_id:r.case_id, v_key:r.v_key, model:r.model, turns:r.turns.map(t => ({client:t.client,reply:t.reply,error:t.error})), status:r.status,error:r.error,correction:r.correction,comment:r.comment,critical:r.critical })) : [];
  return { batch:selected, batches, runs, choices:selected ? db.prepare('SELECT * FROM gpt_lab_choices WHERE batch=?').all(selected) : [] };
}
function review(id, body) {
  const row = db.prepare('SELECT r.*,v.key FROM lab_runs r JOIN agent_versions v ON v.id=r.version_id WHERE r.id=?').get(Number(id));
  if (!row || !keys.includes(row.key)) throw new Error('Ответ не найден');
  if (body.choose) {
    if (row.status !== 'ok') throw new Error('Нельзя выбрать незавершённый ответ');
    db.prepare('INSERT INTO gpt_lab_choices(batch,case_id,run_id) VALUES(?,?,?) ON CONFLICT(batch,case_id) DO UPDATE SET run_id=excluded.run_id').run(row.batch,row.case_id,row.id);
  } else lab.rate(id, { correction:String(body.correction || '').slice(0,10000), comment:String(body.comment || '').slice(0,3000), critical:Boolean(body.critical) });
}
module.exports = { config,start,results,review };
