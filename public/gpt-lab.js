/* Focused 2×2 comparison; credentials and usage remain on the server. */
async function renderGptLab() {
  const cfg = await api('/api/gpt-lab/config');
  const selected = new Set();
  let batch = '', busy = false, disposed = false, loading = false, lastJobStamp = '';
  view().innerHTML = `<div class="page-head"><h1>Лаборатория GPT</h1></div>
    <p class="muted">Егор, менеджер отдела продаж автосалона InDrive. Два стиля × GPT-6 Luna и GPT-4o mini. Ответы только здесь — клиентам ничего не отправляется.</p>
    <div class="card"><h3>1. Выберите вопросы</h3><p class="small muted">Условия автомобилей учебные. Эталоны помогают оценить ответ, но не передаются модели как подсказка.</p>
    <div class="row">${cfg.models.map(m=>`<span class="badge">${esc(m.label)} · ${m.ready ? 'ключ подключён: '+esc(m.profile) : 'ключ не подключён'}</span>`).join('')}</div>
    <div class="row" style="margin:12px 0"><button class="btn sm" id="gAll">Выбрать все</button><button class="btn sm" id="gNone">Снять выбор</button></div>
    <div class="gpt-questions">${cfg.questions.map(q=>`<label class="gpt-question"><input type="checkbox" value="${esc(q.id)}"><span><b>${esc(q.title)}</b><br><span class="small">${esc(q.client_turns.join(' → '))}</span></span></label>`).join('')}</div>
    <div class="row" style="margin-top:16px"><button class="btn primary" id="gStart">Сгенерировать четыре ответа</button><button class="btn" id="gStop" hidden>Остановить</button><span id="gProgress" role="status"></span></div><p class="small muted" id="gCount">Выберите вопросы</p></div>
    <div class="card" style="margin-top:20px"><div class="row"><h3>2. Сравните и выберите</h3><select id="gBatches" aria-label="История прогонов" style="width:auto"></select></div><div id="gResults"></div></div>`;
  const update = () => { $('#gCount').textContent = `Выбрано вопросов: ${selected.size} · вариантов ответа: ${selected.size*4}. Многоходовые вопросы включают несколько сообщений.`; $('#gStart').disabled = busy || !selected.size || cfg.models.some(m=>!m.ready); };
  $$('.gpt-question input').forEach(x=>x.addEventListener('change',()=>{x.checked?selected.add(x.value):selected.delete(x.value);update();}));
  $('#gAll').onclick=()=>{$$('.gpt-question input').forEach(x=>{x.checked=true;selected.add(x.value);});update();};
  $('#gNone').onclick=()=>{$$('.gpt-question input').forEach(x=>x.checked=false);selected.clear();update();};
  async function refresh() {
    if (disposed || loading || !location.hash.includes('/gpt-lab')) return;
    loading=true;
    try {
      const d=await api('/api/gpt-lab/results'+(batch?'?batch='+encodeURIComponent(batch):''));
      if (disposed || !$('#gResults')) return;
      if(!batch) batch=d.batch || '';
      $('#gBatches').innerHTML=d.batches.map(b=>`<option value="${esc(b.batch)}" ${b.batch===batch?'selected':''}>${esc(new Date(b.created*1000).toLocaleString('ru-RU'))} · ${esc(b.batch)}</option>`).join('');
      // Never overwrite an in-progress reviewer edit during polling.
      if ($('#gResults').querySelector('[data-dirty]') || ($('#gResults').contains(document.activeElement) && document.activeElement.matches('textarea,input'))) return;
      const groups=cfg.questions.filter(q=>d.runs.some(r=>r.case_id===q.id));
      $('#gResults').innerHTML=groups.length?groups.map(q=>`<section class="gpt-result-group"><h3>${esc(q.title)}</h3><p>${esc(q.client_turns.join(' → '))}</p><details><summary>Условия и контрольные ответы</summary><pre class="gpt-facts">${esc(JSON.stringify(q.facts,null,2))}</pre><p><b>Формальный ориентир:</b> ${esc(q.reference.formal)}</p><p><b>Неформальный ориентир:</b> ${esc(q.reference.friendly)}</p><p class="small muted">Это авторские ориентиры, не результаты запуска. Для первого ответа добавляется представление Егора. В многоходовых сценариях ориентир дан для первого хода.</p></details>
      <div class="gpt-answer-grid">${cfg.strategies.flatMap(s=>cfg.models.map(m=>{
        const r=d.runs.find(r=>r.case_id===q.id&&r.v_key===s.key&&r.model===m.model);
        if(!r)return `<article class="gpt-answer"><h4>${esc(s.title)} · ${esc(m.label)}</h4><p class="muted">Ожидается ответ</p></article>`;
        const chosen=d.choices.some(c=>c.run_id===r.id);
        return `<article class="gpt-answer ${chosen?'chosen':''}" data-gr="${r.id}"><h4>${esc(s.title)} · ${esc(m.label)}</h4>${r.turns.map(t=>`<div class="gpt-turn"><p class="small muted">Клиент: ${esc(t.client)}</p><p class="gpt-reply">${esc(t.reply||t.error||'Ответ отсутствует')}</p></div>`).join('')}${r.status!=='ok'?`<p class="notice">${esc(r.error||r.status)}</p>`:''}<button class="btn sm" data-choose ${r.status!=='ok'?'disabled':''}>${chosen?'✓ Выбран':'Выбрать этот ответ'}</button><details><summary>Комментарий и исправление</summary><label>Как ответить лучше<textarea data-correction rows="4">${esc(r.correction||'')}</textarea></label><label>Что изменить<textarea data-comment rows="2">${esc(r.comment||'')}</textarea></label><label><input type="checkbox" data-critical ${r.critical?'checked':''}> Существенная ошибка</label><button class="btn sm" data-save>Сохранить</button></details></article>`;
      })).join('')}</div></section>`).join(''):'<p class="muted">Выберите вопросы и запустите генерацию. Здесь появятся ответы четырёх вариантов.</p>';
      $$('[data-gr]').forEach(el=>{
        $$('textarea,input',el).forEach(input=>input.addEventListener('input',()=>el.setAttribute('data-dirty','1')));
        $('[data-choose]',el).onclick=async()=>{try{await api('/api/gpt-lab/review/'+el.dataset.gr,{body:{choose:true}});await refresh();}catch(e){toast(e.message,true);}};
        $('[data-save]',el).onclick=async()=>{try{await api('/api/gpt-lab/review/'+el.dataset.gr,{body:{correction:$('[data-correction]',el).value,comment:$('[data-comment]',el).value,critical:$('[data-critical]',el).checked}});el.removeAttribute('data-dirty');toast('Правка сохранена для следующего улучшения');}catch(e){toast(e.message,true);}};
      });
    } finally {loading=false;}
  }
  async function poll() {
    if(!location.hash.includes('/gpt-lab')) {disposed=true;return;}
    try{const j=await api('/api/gpt-lab/job');if(disposed||!$('#gProgress'))return;busy=Boolean(j?.running);$('#gStop').hidden=!busy;$('#gProgress').textContent=j?`${j.done||0} / ${j.total||0} · ${j.error||j.note||(busy?'Модели отвечают…':'Готово')}`:'';update();const stamp=JSON.stringify([j?.batch,j?.done,j?.running,j?.error]);if(stamp!==lastJobStamp){lastJobStamp=stamp;if(busy&&!batch)batch=j.batch;await refresh();}}catch(e){if($('#gProgress'))$('#gProgress').textContent=e.message;}
  }
  $('#gStart').onclick=async()=>{busy=true;update();try{const j=await api('/api/gpt-lab/run',{body:{caseIds:[...selected]}});batch=j.batch;await poll();}catch(e){busy=false;update();toast(e.message,true);}};
  $('#gStop').onclick=async()=>{try{await api('/api/gpt-lab/stop',{body:{}});await poll();}catch(e){toast(e.message,true);}};
  $('#gBatches').onchange=e=>{batch=e.target.value;refresh().catch(e=>toast(e.message,true));};
  update();await refresh();await poll();state.timers.push(setInterval(poll,2000));
}
