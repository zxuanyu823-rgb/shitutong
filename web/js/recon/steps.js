// 视图通 · 拍照建模的步骤列表和计时（ReconPanel 的混入方法）
import { $, esc } from '../util.js';
import { progress } from '../native.js';

const STEPS = [
  ['vision', '识图：照片 → 三视图线条（含自检）'],
  ['search', '联网检索：相似题目与解析'],
  ['align', '三等对齐：长对正、高平齐、宽相等纠错'],
  ['build', '重建：生成三维候选'],
  ['check', '校验：反算三视图逐线比对'],
  ['photo', 'AI 照片复核：辅助判断与原照片的差异'],
  ['refine', '修正：大模型根据差异改方案'],
];
const STEP_NAMES = { vision: '识图', search: '联网检索', align: '三等对齐', build: '重建', check: '校验', photo: 'AI 照片复核', refine: '修正' };
const dur = ms => { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t} 秒` : `${Math.floor(t / 60)} 分 ${String(t % 60).padStart(2, '0')} 秒`; };

export { STEPS, STEP_NAMES, dur };

export const stepMethods = {
  startClock() {
    clearInterval(this.clockTick);
    this.clock = { t0: Date.now(), end: null, steps: {} };
    const el = $('#reconTimer'); if (el) { el.hidden = false; el.className = 'recon-timer run'; }
    const tick = () => {
      if (!this.clock || this.clock.end) return;
      if (el) el.textContent = `已用时 ${dur(Date.now() - this.clock.t0)}`;
      document.querySelectorAll('#reconSteps .st-run .dur').forEach(n => { const c = this.clock.steps[n.dataset.k]; if (c) n.textContent = dur(Date.now() - c.start); });
    };
    tick(); this.clockTick = setInterval(tick, 1000);
  },
  stopClock() {
    clearInterval(this.clockTick);
    if (!this.clock || this.clock.end) return this.clock ? this.clock.end - this.clock.t0 : 0;
    this.clock.end = Date.now();
    const total = this.clock.end - this.clock.t0;
    const parts = Object.entries(this.clock.steps).filter(([, c]) => c.end).map(([k, c]) => [STEP_NAMES[k] || k, c.end - c.start]).sort((a, b) => b[1] - a[1]);
    const el = $('#reconTimer');
    if (el) {
      el.className = 'recon-timer done';
      el.innerHTML = `从选图到完成共用时 <b>${dur(total)}</b>${parts.length ? `<small>${parts.slice(0, 3).map(([n, ms]) => `${n} ${dur(ms)}`).join(' · ')}</small>` : ''}`;
    }
    this.renderSteps(this.state);
    return total;
  },
  renderSteps(state) {
    this.state = state;
    $('#reconSteps').innerHTML = STEPS.map(([k, t]) => {
      const s = state[k] || { st: 'idle' };
      const c = this.clock?.steps?.[k];
      const d = c ? `<span class="dur" data-k="${k}">${dur((c.end && s.st !== 'run' ? c.end : Date.now()) - c.start)}</span>` : '';
      return `<li class="st-${s.st}"><span class="dot"></span><div><b>${t}</b>${d}${s.msg ? `<pre>${esc(s.msg)}</pre>` : ''}</div></li>`;
    }).join('');
  },
  // 计时框下面列出每次大模型调用：用途、思考强度、耗时（失败、超时、其中在后台的时间）
  renderCallLog(calls) {
    const el = $('#reconTimer'); if (!el || !calls.length) return;
    const sum = calls.reduce((s, c) => s + c.ms, 0), slow = [...calls].sort((a, b) => b.ms - a.ms)[0];
    const item = c => `${c.label}${c.effort ? `（${c.effort}）` : ''} ${dur(c.ms)}${c.err ? ` <b class="bad">${c.err}</b>` : ''}${c.hidden > 30000 ? `，后台 ${dur(c.hidden)}` : ''}`;
    el.insertAdjacentHTML('beforeend', `<small class="calls">大模型调用 ${calls.length} 次，累计 ${dur(sum)}（有的同时进行），最慢：${slow.label} ${dur(slow.ms)}<br>${calls.map(item).join(' · ')}</small>`);
  },
  setStep(k, st, msg) {
    // 记录每一步的开始、结束时间
    if (this.clock && st !== 'idle') {
      const c = this.clock.steps[k] ||= { start: Date.now(), end: null };
      c.end = st === 'run' ? null : Date.now();
    }
    this.state = { ...this.state, [k]: { st, msg: msg ?? this.state[k]?.msg } }; if (st === 'idle') this.state[k] = { st: 'idle' }; this.renderSteps(this.state);
    if (st === 'run') progress(`${STEP_NAMES[k] || ''}${STEP_NAMES[k] ? '：' : ''}${(msg ?? '').split('\n').filter(Boolean).pop() || '进行中…'}`);
  }
};
