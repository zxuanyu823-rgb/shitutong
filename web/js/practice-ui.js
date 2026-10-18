// 视图通 · 练习流程：出题、提示、判分
// 以方法的形式挂到 App 上，this 指向 App 实例。
import { $ } from './util.js';
import { VIEWS } from './engine.js';
import { toPaper } from './views2d.js';
import { makeExercise, checkExercise, recordResult, TYPES, viewThumb } from './exercise.js';


export const practiceMethods = {
  startExercise(type) {
    if (this.mode === 'photo' && this.recon?.cur) {
      this.recon.adopt(this.recon.cur);
    }
    this.stopUnfold(); this.select({}); this.showInfo(null);
    const ex = makeExercise(this.model, type);
    if (!ex) { this.say('bot', '这个模型暂时出不了这类题，换一个模型试试。'); return; }
    this.exercise = ex; ex.t0 = performance.now();
    if (ex.type === 'error') this.drawSheet({ hideLines: ex.hideLines, flipLines: ex.flipLines });
    else if (ex.type === 'third') this.drawSheet({ hideLines: this.model.views[ex.view].lines.map((_, i) => ({ view: ex.view, i })), hideCenter: ex.view });
    else if (ex.type === 'vis') this.drawSheet({ hideLines: [{ view: ex.view, i: ex.line.i }] });
    else this.drawSheet();
    const A = toPaper(this.lay, ex.view, ex.line.a), B = toPaper(this.lay, ex.view, ex.line.b);
    if (ex.type === 'third') { const [bmin, bmax] = this.model.bbox; const c = ex.view === 'left' ? [-(bmin[1] + bmax[1]) / 2, (bmin[2] + bmax[2]) / 2] : ex.view === 'front' ? [(bmin[0] + bmax[0]) / 2, (bmin[2] + bmax[2]) / 2] : [(bmin[0] + bmax[0]) / 2, (bmin[1] + bmax[1]) / 2]; const [X, Y] = toPaper(this.lay, ex.view, c); $('#quiz').innerHTML = `<text x="${X}" y="${Y}" text-anchor="middle" class="vlabel" style="font-size:4px;fill:var(--quiz)">?</text>`; this.viewer.setView('iso'); }
    if (ex.type === 'match') $('#quiz').innerHTML = `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" class="quiz" ${ex.line.vis ? '' : 'stroke-dasharray="2.6 1.3"'}/>`;
    if (ex.type === 'vis') $('#quiz').innerHTML = `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" class="quiz-neutral"/><circle cx="${(A[0] + B[0]) / 2}" cy="${(A[1] + B[1]) / 2}" r="3.2" class="quiz-ring"/>`;
    const btns = ex.type === 'third' ? `<div class="thumbs">${ex.opts.map((o, k) => `<button data-k="${k}"><span>${k + 1}</span>${viewThumb(this.model, ex.view, { hide: o.hide, flip: o.flip })}</button>`).join('')}</div><div class="btns"><button data-skip>跳过</button></div>` : ex.type === 'vis' ? `<div class="btns"><button class="primary" data-ans="1">粗实线</button><button class="primary" data-ans="0">细虚线</button><button data-skip>跳过</button></div>` : `<div class="btns"><button data-hint>提示</button><button data-skip>跳过</button></div>`;
    const el = this.say('ex', `${ex.prompt}`, { html: `<div class="ex-type">练习 · ${TYPES[ex.type].name}</div>`, after: btns });
    el.querySelectorAll('[data-ans]').forEach(b => b.onclick = () => this.answerExercise({ vis: b.dataset.ans === '1' }));
    el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => this.answerExercise({ k: +b.dataset.k }));
    el.querySelector('[data-hint]')?.addEventListener('click', () => this.hint());
    el.querySelector('[data-skip]')?.addEventListener('click', () => { this.exercise = null; this.drawSheet(); this.say('bot', '跳过了。想继续就说“再来一题”。'); });
    if (ex.type === 'match') this.viewer.setView('iso');
  },

  hint() {
    const ex = this.exercise; if (!ex) return;
    if (ex.type === 'match') this.say('bot', `提示：这条线在${VIEWS[ex.view].name}里。先看它的位置，再用“长对正、高平齐、宽相等”到另外两个视图里找对应的线或线框。${ex.line.vis ? '' : '它是虚线，说明对应的棱在背面或内部，可以打开“透视”。'}`);
    else if (ex.type === 'error') this.say('bot', `提示：错误在${VIEWS[ex.view].name}里。把三个视图逐条对照，看每条线在另外两个视图里有没有对应，虚实是否合理。`);
  },

  answerExercise(ans) {
    const ex = this.exercise; if (!ex || ex.done) return;
    ex.done = true;
    const res = checkExercise(this.model, ex, ans);
    recordResult(this.model.def.id, ex, res, performance.now() - ex.t0);
    // 揭晓：恢复正确的图纸并高亮
    this.drawSheet();
    this.select(res.reveal || {});
    if (ex.type === 'error' && ans.view) {
      const P = toPaper(this.lay, ans.view, ans.uv);
      $('#quiz').innerHTML = `<circle cx="${P[0]}" cy="${P[1]}" r="3.4" class="${res.ok ? 'mark-ok' : 'mark-bad'}"/>`;
    }
    const el = this.say(res.ok ? 'ok' : 'bad', res.text, { after: `<div class="btns"><button class="primary" data-next>再来一题</button><button data-same>换种题型</button></div>` });
    el.querySelector('[data-next]').onclick = () => this.startExercise(ex.type);
    el.querySelector('[data-same]').onclick = () => { const ks = Object.keys(TYPES); this.startExercise(ks[(ks.indexOf(ex.type) + 1) % ks.length]); };
    this.exercise = null;
  },
};
