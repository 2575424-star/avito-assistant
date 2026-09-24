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
// Preserve egor-1 snapshots; only the selected version advances.
keys.forEach((key, i) => db.prepare('INSERT OR IGNORE INTO agent_versions(key,version,title,base_prompt,strategy,status,created) VALUES(?,?,?,?,?,?,?)')
  .run(key, 'egor-2', titles[i], read('egor-2/common.md'), read(i ? 'egor-2/friendly.md' : 'egor-2/formal.md'), 'lab_only', now()));
// Reuse the former Sol profile for the comparison, without reading or changing its secret.
if (!lab.models().some(m => m.model === 'gpt-4o-mini')) {
  const old = lab.models().find(m => m.model === 'gpt-6-sol' && m.key_profile_id);
  db.prepare('INSERT INTO lab_models(label,model,api,key_profile_id,price_in,price_cached_in,price_out,price_version,created) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('GPT-4o mini', 'gpt-4o-mini', 'responses', old?.key_profile_id || null, 0.15, 0.075, 0.6, 'OpenAI Standard 2026-09-24', now());
}
for (const c of questions) db.prepare('INSERT OR IGNORE INTO lab_cases(id,set_name,version,title,facts,client_turns,turn_mode,expected,created) VALUES(?,?,?,?,?,?,?,?,?)')
  .run(c.id, 'gpt_egor', c.version, c.title, JSON.stringify(c.facts), JSON.stringify(c.client_turns), c.turn_mode, JSON.stringify(c.expected), now());

function versions() { return keys.map(key => db.prepare("SELECT id,key,title,version FROM agent_versions WHERE key=? AND version='egor-2'").get(key)); }
function config() {
  const profiles = lab.profiles();
  const models = ['gpt-6-luna', 'gpt-4o-mini'].map(name => {
    const matches = lab.models().filter(m => m.model === name);
    const model = matches.find(m => profiles.some(p => p.id === m.key_profile_id && p.has_key && p.provider === 'openai')) || matches[0];
    const profile = profiles.find(p => p.id === model?.key_profile_id);
    return { id: model?.id, model: name, label: name === 'gpt-6-luna' ? 'GPT-6 Luna' : 'GPT-4o mini', profile: profile?.name || '', ready: Boolean(profile?.has_key && profile.provider === 'openai') };
  });
  return { strategies: versions(), models, questions };
}
function start(body) {
  const ids = [...new Set(Array.isArray(body.caseIds) ? body.caseIds : [])];
  if (!ids.length || ids.length > 16 || ids.some(id => !questions.some(q => q.id === id))) throw new Error('Выберите от 1 до 16 контрольных вопросов');
  const c = config();
  const names = [...new Set(body.models || ['gpt-6-luna'])];
  if (!names.length || names.some(name => !c.models.some(m => m.model === name))) throw new Error('Выберите Luna и/или GPT-4o mini');
  const selected = c.models.filter(m => names.includes(m.model));
  if (selected.some(m => !m.ready)) throw new Error('Подключите профиль OpenAI к выбранной модели в настройках «Ключи и модели»');
  if (new Set(selected.map(m => lab.models().find(x => x.id === m.id).key_profile_id)).size !== selected.length) throw new Error('Для раздельного учёта назначьте моделям разные профили ключей');
  return lab.start({ caseIds: ids, versionIds: c.strategies.map(v => v.id), modelIds: selected.map(m => m.id), repeats: 1, concurrency: 2, limitUsd: 5 }, (_, fn) => history.startJob('gpt_lab', fn), {
    requestParams: model => ({ reasoning_effort: model.model === 'gpt-6-luna' ? 'none' : null, max_output_tokens: 600 })
  });
}
function results(batch) {
  const batches = db.prepare("SELECT DISTINCT r.batch, MAX(r.created) created FROM lab_runs r JOIN agent_versions v ON v.id=r.version_id WHERE v.key IN (?,?) GROUP BY r.batch ORDER BY created DESC, r.batch DESC LIMIT 50").all(...keys);
  const selected = batch || batches[0]?.batch || null;
  const runs = selected ? lab.runs({ batch: selected, limit: 1000 }).filter(r => keys.includes(r.v_key)).map(r => ({ id:r.id, case_id:r.case_id, v_key:r.v_key, version:r.v_version, model:r.model, turns:r.turns.map(t => ({client:t.client,reply:t.reply,error:t.error})), status:r.status,error:r.error,correction:r.correction,comment:r.comment,critical:r.critical })) : [];
  const active = history.jobState('gpt_lab');
  const modelNames = active?.running && active.batch === selected ? active.models : [...new Set(runs.map(r => r.model))];
  return { batch:selected, batches, runs, models:(modelNames || []).map(model => ({model,label:({'gpt-6-sol':'GPT-6 Sol','gpt-6-luna':'GPT-6 Luna','gpt-4o-mini':'GPT-4o mini'})[model] || model})), choices:selected ? db.prepare('SELECT * FROM gpt_lab_choices WHERE batch=?').all(selected) : [] };
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
