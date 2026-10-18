// 视图通 · 练习生成与错因诊断
// 题目全部由当前模型的几何计算自动生成，答案可验证。
import { distPtSeg } from './util.js';
import { VIEWS, VIEW_KEYS, queryLineAt, occluderOf, findFace } from './engine.js';
import { describeLine } from './tutor.js';

const VN = v => VIEWS[v].name;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const segLen = l => Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]);
const mid = l => [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2];

function onBoxLine(model, view, l) {
  const [bmin, bmax] = model.bbox;
  const box = view === 'front' ? [bmin[0], bmax[0], bmin[2], bmax[2]] : view === 'top' ? [bmin[0], bmax[0], bmin[1], bmax[1]] : [-bmax[1], -bmin[1], bmin[2], bmax[2]];
  return [[0, 0], [0, 1], [1, 2], [1, 3]].some(([k, b]) => Math.abs(l.a[k] - box[b]) < 1e-3 && Math.abs(l.b[k] - box[b]) < 1e-3);
}

// 单个视图的小图（练习选项用）
export function viewThumb(model, view, { hide = [], flip = [] } = {}) {
  const vw = model.views[view];
  const [bmin, bmax] = model.bbox;
  const box = view === 'front' ? [bmin[0], bmax[0], bmin[2], bmax[2]] : view === 'top' ? [bmin[0], bmax[0], bmin[1], bmax[1]] : [-bmax[1], -bmin[1], bmin[2], bmax[2]];
  const m = Math.max(box[1] - box[0], box[3] - box[2]) * 0.12;
  const X = u => (u - box[0] + m).toFixed(2), Y = v => (box[3] - v + m).toFixed(2);
  let d = '';
  vw.lines.forEach((l, i) => {
    if (hide.includes(i)) return;
    const vis = flip.includes(i) ? !l.vis : l.vis;
    d += `<line x1="${X(l.a[0])}" y1="${Y(l.a[1])}" x2="${X(l.b[0])}" y2="${Y(l.b[1])}" stroke="currentColor" stroke-width="${vis ? 0.9 : 0.45}" ${vis ? 'stroke-linecap="round"' : 'stroke-dasharray="2.4 1.3"'}/>`;
  });
  for (const c of vw.center) d += `<line x1="${X(c.a[0])}" y1="${Y(c.a[1])}" x2="${X(c.b[0])}" y2="${Y(c.b[1])}" stroke="currentColor" stroke-width="0.3" stroke-dasharray="6 1.2 1 1.2" opacity=".6"/>`;
  return `<svg viewBox="0 0 ${(box[1] - box[0] + 2 * m).toFixed(2)} ${(box[3] - box[2] + 2 * m).toFixed(2)}" xmlns="http://www.w3.org/2000/svg">${d}</svg>`;
}

export const TYPES = {
  match: { name: '找对应', desc: '视图中高亮一条线，在三维模型上点出它对应的棱或面' },
  vis: { name: '判虚实', desc: '判断视图中的一条线应画实线还是虚线' },
  error: { name: '找错线', desc: '视图里有一处画错了（漏线或虚实错误），把它找出来' },
  third: { name: '补第三视图', desc: '只给两个视图，从三个候选里选出正确的第三视图' },
};

export function makeExercise(model, type) {
  type = type || pick(Object.keys(TYPES));
  for (let tries = 0; tries < 40; tries++) {
    const view = pick(VIEW_KEYS);
    const lines = model.views[view].lines.map((l, i) => ({ ...l, i })).filter(l => segLen(l) > 4);
    if (!lines.length) continue;
    if (type === 'match') {
      const hid = lines.filter(l => !l.vis);
      const l = hid.length && Math.random() < 0.5 ? pick(hid) : pick(lines);
      const q = queryLineAt(model, view, mid(l), 0.6);
      if (!q) continue;
      return { type, view, line: l, accept: { curves: q.sources, faces: q.faces },
        prompt: `${VN(view)}中高亮的这条${l.vis ? '实线' : '虚线'}，对应三维模型上的哪条棱或哪个面？请在左侧三维模型上点出来（可以旋转、打开透视）。` };
    }
    if (type === 'vis') {
      const l = pick(lines);
      return { type, view, line: l, answer: l.vis,
        prompt: `${VN(view)}中标出的这条线，应该画成粗实线还是细虚线？` };
    }
    if (type === 'third') {
      // 隐去一个视图，干扰项：改一条线的虚实 / 去掉一条线
      const cand = lines.filter(l => !onBoxLine(model, view, l));
      if (cand.length < 1) continue;
      const opts = [{ ok: true, hide: [], flip: [] }];
      const pickL = () => cand[Math.floor(Math.random() * cand.length)];
      const a = pickL(); opts.push({ ok: false, hide: [], flip: [a.i], why: `这一项把一条${a.vis ? '实线画成了虚线' : '虚线画成了实线'}` });
      let b = pickL(), guard = 0; while (b === a && cand.length > 1 && guard++ < 10) b = pickL();
      opts.push({ ok: false, hide: [b.i], flip: [], why: `这一项漏画了一条${b.vis ? '实线' : '虚线'}` });
      opts.sort(() => Math.random() - 0.5);
      return { type, view, line: a, opts, prompt: `已知另外两个视图，下面哪一个是正确的${VN(view)}？中间图纸里的${VN(view)}已经隐去。` };
    }
    if (type === 'error') {
      const mode = Math.random() < 0.5 ? 'flip' : 'missing';
      // 优先选内部线和虚线：外轮廓线出错太容易发现
      const [bmin, bmax] = model.bbox;
      const box = view === 'front' ? [bmin[0], bmax[0], bmin[2], bmax[2]] : view === 'top' ? [bmin[0], bmax[0], bmin[1], bmax[1]] : [-bmax[1], -bmin[1], bmin[2], bmax[2]];
      const onBox = l => [[0, 0], [0, 1], [1, 2], [1, 3]].some(([k, b]) => { const v = box[b]; return Math.abs(l.a[k] - v) < 1e-3 && Math.abs(l.b[k] - v) < 1e-3; });
      const weighted = lines.flatMap(l => Array((onBox(l) ? 1 : 3) + (l.vis ? 0 : 2)).fill(l));
      const l = pick(weighted);
      return { type, view, line: l, mode,
        hideLines: mode === 'missing' ? [{ view, i: l.i }] : [],
        flipLines: mode === 'flip' ? [{ view, i: l.i }] : [],
        prompt: `下面的三视图中有一处画错了。请在图纸上点出错误的位置。` };
    }
  }
  return null;
}

// 检查答案，返回 { ok, text, reveal }
export function checkExercise(model, ex, ans) {
  if (ex.type === 'match') {
    const ok = (ans.type === 'curve' && ex.accept.curves.includes(ans.id)) || (ans.type === 'face' && ex.accept.faces.includes(ans.id));
    const d = describeLine(model, ex.view, mid(ex.line));
    const all = [...ex.accept.curves.filter(s => s.startsWith('E')), ...ex.accept.faces];
    let text;
    if (ok) text = `正确！${d ? d.lines.slice(1).join('') : ''}`;
    else {
      text = `不对。你点的是 ${ans.id}${ans.type === 'face' ? ' ' + findFace(model, ans.id).label : ''}，它投影到${VN(ex.view)}后不在这条线上。` +
        `这条线对应的是 ${all.join('、') || '圆柱面的转向轮廓线'}。` + (d ? d.lines.slice(1).join('') : '');
      text += ' 提示：先用“长对正、高平齐、宽相等”在另外两个视图中找到它的对应投影，再确定空间位置。';
    }
    return { ok, text, reveal: { curves: ex.accept.curves, faces: ex.accept.faces }, errorKind: ok ? null : '对应关系错误' };
  }
  if (ex.type === 'vis') {
    const ok = ans.vis === ex.answer;
    let why;
    if (ex.answer) why = `沿${VN(ex.view)}的观察方向看过去，这条线前面没有材料遮挡，所以画粗实线。`;
    else {
      const q = queryLineAt(model, ex.view, mid(ex.line), 0.6);
      const occ = q ? q.sources.map(s => occluderOf(model, ex.view, s)).find(Boolean) : null;
      why = `它被 ${occ ? occ.id + ' ' + occ.label : '前面的实体'} 挡住，所以画细虚线。`;
    }
    const q = queryLineAt(model, ex.view, mid(ex.line), 0.6);
    return { ok, text: (ok ? '正确！' : `不对，应该画${ex.answer ? '粗实线' : '细虚线'}。`) + why,
      reveal: q ? { curves: q.sources, faces: q.faces } : {}, errorKind: ok ? null : (ex.answer ? '把可见线画成虚线' : '漏判遮挡（虚线画成实线）') };
  }
  if (ex.type === 'third') {
    const o = ex.opts[ans.k];
    const ok = !!o?.ok;
    const right = ex.opts.findIndex(x => x.ok);
    const text = ok ? `正确！第 ${right + 1} 个是${VN(ex.view)}。可以在三维模型上对照，看每条线对应哪条棱或哪个面。`
      : `不对，正确的是第 ${right + 1} 个。${o?.why || ''}。用“长对正、高平齐、宽相等”逐条核对另两个视图，就能发现差别。`;
    return { ok, text, reveal: {}, errorKind: ok ? null : (o?.flip?.length ? '补图时虚实判断错误' : '补图时漏线') };
  }
  if (ex.type === 'error') {
    const l = ex.line;
    const ok = ans.view === ex.view && distPtSeg(ans.uv, l.a, l.b) < 2.8;
    const q = queryLineAt(model, ex.view, mid(l), 0.6);
    const what = ex.mode === 'missing'
      ? `${VN(ex.view)}中漏画了一条${l.vis ? '粗实线' : '细虚线'}。`
      : `${VN(ex.view)}中有一条线虚实画反了：它应该是${l.vis ? '粗实线' : '细虚线'}，图中却画成了${l.vis ? '细虚线' : '粗实线'}。`;
    let why = '';
    if (q) {
      const d = describeLine(model, ex.view, mid(l));
      why = d ? d.lines.slice(1).join('') : '';
    }
    let text;
    if (ok) text = `找到了！${what}${why}`;
    else {
      let clicked = '';
      if (ans.view) {
        const d = describeLine(model, ans.view, ans.uv);
        if (d) clicked = `你点的位置是${VN(ans.view)}中的一条线，它是对的：${d.lines.slice(1, 2).join('')}`;
        else clicked = '你点的位置附近没有线。';
      }
      text = `还没找到。${clicked} 正确答案：${what}${why}`;
    }
    return { ok, text, reveal: q ? { curves: q.sources, faces: q.faces } : {}, errorKind: ok ? null : (ex.mode === 'missing' ? '没发现漏线' : '没发现虚实错误') };
  }
}

// 学习记录（存在本机浏览器，用于“学习报告”）
const KEY = 'stt.stats.v1';
export function loadStats() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { total: 0, right: 0, byType: {}, errors: {}, log: [] }; }
  catch { return { total: 0, right: 0, byType: {}, errors: {}, log: [] }; }
}
export function recordResult(modelId, ex, res, ms) {
  const s = loadStats();
  s.total++; if (res.ok) s.right++;
  const t = s.byType[ex.type] || (s.byType[ex.type] = { total: 0, right: 0 });
  t.total++; if (res.ok) t.right++;
  if (res.errorKind) s.errors[res.errorKind] = (s.errors[res.errorKind] || 0) + 1;
  s.log.push({ t: Date.now(), model: modelId, type: ex.type, view: ex.view, ok: res.ok, ms: Math.round(ms), err: res.errorKind });
  if (s.log.length > 500) s.log = s.log.slice(-500);
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  return s;
}
export function resetStats() { try { localStorage.removeItem(KEY); } catch {} }
