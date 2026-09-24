const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'egor-lab-'));
const { db } = require('../src/db');
const llm = require('../src/llm');
const calls=[];
llm.call=async p=>{
  calls.push(p);
  assert.match(p.system,/Егор/); assert.doesNotMatch(p.system,/Ярослав/);
  assert.match(p.system,/Не выдумывай|не выдумывай/);
  return {content:JSON.stringify({reply:'Здравствуйте, меня зовут Егор. Ответ по фактам.',phone:null,handoff:false,skip:false}),usage:{input:100,cached:0,output:20,reasoning:0,known:true},ms:5,api:'responses',params:{}};
};
const gpt=require('../src/gpt-lab');
const history=require('../src/history');
const lab=require('../src/lab');
const sleep=()=>new Promise(r=>setTimeout(r,10));
(async()=>{
  try {
    assert.equal(gpt.config().strategies.length,2);
    assert.equal(gpt.config().questions.length,16);
    assert.equal(lab.strategies().length,4,'existing lab: three strategies + simple');
    assert.throws(()=>gpt.start({caseIds:['GPT01']}),/ключ/);
    for(const [i,m] of lab.models().entries()) {
      const id=Number(db.prepare('INSERT INTO key_profiles(name,provider,api_key,created) VALUES(?,?,?,?)').run('profile'+i,'openai','sk-fake-'+i,1).lastInsertRowid);
      db.prepare('UPDATE lab_models SET key_profile_id=? WHERE id=?').run(id,m.id);
    }
    assert.throws(()=>gpt.start({caseIds:['STD01']}),/контрольных/);
    const before={};for(const t of ['chats','messages','kb'])before[t]=db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const job=gpt.start({caseIds:['GPT01','GPT10']});
    assert.throws(()=>gpt.start({caseIds:['GPT01']}),/выполняется/);
    while(job.running)await sleep();
    assert.equal(job.error,undefined);assert.equal(job.done,8);
    const result=gpt.results(job.batch);
    assert.equal(result.runs.length,8);
    assert.equal(calls.length,16,'4 one-turn plus 4 three-turn conversations');
    assert.deepEqual(new Set(calls.map(p=>p.profile.api_key)),new Set(['sk-fake-1','sk-fake-2']),'Luna and GPT-4o mini, Sol not used');
    for(const r of result.runs.filter(r=>r.case_id==='GPT10'))assert.equal(r.turns.length,3);
    assert.doesNotMatch(JSON.stringify(gpt.config()),/sk-fake/);
    assert.doesNotMatch(JSON.stringify(result),/cost_usd|input_tokens|sk-fake/);
    const first=result.runs[0];gpt.review(first.id,{choose:true});
    assert.equal(gpt.results(job.batch).choices[0].run_id,first.id);
    gpt.review(first.id,{correction:'Уточнить цену',comment:'Нужен прямой ответ',critical:true});
    assert.equal(gpt.results(job.batch).runs.find(r=>r.id===first.id).correction,'Уточнить цену');
    for(const t of Object.keys(before))assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n,before[t]);
    llm.call=async()=>{throw new Error('provider unavailable');};
    const failed=gpt.start({caseIds:['GPT02']});while(failed.running)await sleep();
    assert.ok(failed.cost > 0, 'unknown failed usage reserves the estimated cost');
    for (const row of lab.runs({batch:failed.batch})) {assert.equal(row.usage_known,0);assert.equal(row.cost_usd,null);}
    assert.equal(failed.errors,4);assert.equal(gpt.results(failed.batch).runs.length,4);
    assert.throws(()=>gpt.review(gpt.results(failed.batch).runs[0].id,{choose:true}),/незавершённый/);
    console.log('GPT laboratory: 2x2 routing, keys, histories, reviews, failures and data isolation passed');
  } finally {db.close();fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
