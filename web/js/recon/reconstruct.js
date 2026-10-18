// 视图通 · 拍照重建 ②：三视图 → 三维候选 → 反算三视图逐线校验
// 思路：先由程序生成可靠的候选（外轮廓拉伸求交 + 圆孔识别 + 隐藏结构挖切搜索），
// 每个候选都用几何引擎反算三视图，与识图结果逐线比对打分；仍不吻合时交给大模型提出修改，再校验。
import { VIEW_KEYS, VN, r1, distPtSeg, extractJSON } from '../util.js';
import { buildMesh, analyze } from '../engine.js';
import { outerContour, pointInPoly, allSegs } from './drawing.js';

const AXIS_OF_VIEW = { front: 'y', top: 'z', left: 'x' };

// ---------- 比对打分 ----------
function samples(seg, step) {
  const L = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
  const n = Math.max(1, Math.round(L / step));
  const out = [];
  for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; out.push({ p: [seg.a[0] + (seg.b[0] - seg.a[0]) * t, seg.a[1] + (seg.b[1] - seg.a[1]) * t], w: L / n, seg, t }); }
  return out;
}

export function genSegs(model, v) {
  return model.views[v].lines.map(l => ({ a: l.a, b: l.b, t: l.vis ? 'solid' : 'dashed' }));
}

// 返回 { score, perView: {front: {score, missing, extra, typeErr}}, diffs: [{view, kind, a, b, t}] }
export function compare(model, drawing, tol) {
  const step = tol / 2;
  const res = { perView: {}, diffs: [] };
  let M = 0, D = 0;
  for (const v of VIEW_KEYS) {
    const dv = drawing.views[v]; if (!dv.present) continue;
    const target = allSegs(dv), gen = genSegs(model, v);
    let matched = 0, tLen = 0, eLen = 0, miss = 0, terr = 0;
    const runs = [];
    for (const s of target) {
      const sm = samples(s, step);
      let cur = null;
      for (const q of sm) {
        tLen += q.w;
        let dS = Infinity, dA = Infinity;
        for (const g of gen) { const d = distPtSeg(q.p, g.a, g.b); if (d < dA) dA = d; if (g.t === s.t && d < dS) dS = d; }
        let kind = null;
        if (dS < tol) matched += q.w;
        else if (dA < tol) { matched += q.w * 0.4; terr += q.w; kind = 'type'; }
        else { miss += q.w; kind = 'missing'; }
        if (kind && cur && cur.kind === kind && cur.seg === s) cur.b = q.p;
        else if (kind) { cur = { view: v, kind, a: q.p, b: q.p, t: s.t, seg: s }; runs.push(cur); }
        else cur = null;
      }
    }
    for (const g of gen) {
      const sm = samples(g, step); let cur = null;
      for (const q of sm) {
        let dA = Infinity;
        for (const s of target) { const d = distPtSeg(q.p, s.a, s.b); if (d < dA) dA = d; }
        if (dA > tol) {
          eLen += q.w;
          if (cur && cur.seg === g) cur.b = q.p; else { cur = { view: v, kind: 'extra', a: q.p, b: q.p, t: g.t, seg: g }; runs.push(cur); }
        } else cur = null;
      }
    }
    const score = matched / Math.max(1e-6, tLen + eLen);
    res.perView[v] = { score, missing: miss, extra: eLen, typeErr: terr, total: tLen };
    M += matched; D += tLen + eLen;
    // 把采样点连成的小段延长半个步长，便于显示
    for (const r of runs) {
      const L = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
      if (L < tol * 0.6 && r.kind !== 'type') continue;
      const ux = L ? (r.b[0] - r.a[0]) / L : 0, uy = L ? (r.b[1] - r.a[1]) / L : 0;
      res.diffs.push({ view: v, kind: r.kind, t: r.t, a: [r.a[0] - ux * step / 2, r.a[1] - uy * step / 2], b: [r.b[0] + ux * step / 2, r.b[1] + uy * step / 2], src: r.kind === 'extra' ? null : r.seg });
    }
  }
  res.score = M / Math.max(1e-6, D);
  return res;
}

export function diffText(diffs, limit = 12) {
  const K = { missing: '缺少', extra: '多出', type: '虚实不对：应为' };
  const T = { solid: '实线', dashed: '虚线' };
  const lines = diffs
    .map(d => ({ ...d, L: Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) }))
    .sort((a, b) => b.L - a.L).slice(0, limit)
    .map(d => `${VN[d.view]}：${K[d.kind]}${d.kind === 'type' ? T[d.t] : T[d.t] || '线'}，从 (${r1(d.a[0])}, ${r1(d.a[1])}) 到 (${r1(d.b[0])}, ${r1(d.b[1])})`);
  return lines.join('\n');
}

// ---------- 候选生成 ----------
export function contoursOf(drawing) {
  const out = {};
  for (const v of VIEW_KEYS) if (drawing.views[v].present) out[v] = outerContour(drawing.views[v], Math.max(0.3, drawing.tol * 0.4));
  return out;
}

// 外轮廓沿各自投射方向拉伸后求交（“视觉外壳”），是与已知视图外形一致的最大形体
export function hullOps(drawing, contours) {
  const { x: L, y: W, z: H } = drawing.dims;
  const e = 0.5;
  const ops = [];
  if (contours.front) ops.push({ op: ops.length ? 'int' : 'add', type: 'prism', axis: 'y', from: -e, to: W + e, poly: contours.front.map(p => [p[0], p[1]]) });
  if (contours.top) ops.push({ op: ops.length ? 'int' : 'add', type: 'prism', axis: 'z', from: -e, to: H + e, poly: contours.top.map(p => [p[0], p[1]]) });
  if (contours.left) ops.push({ op: ops.length ? 'int' : 'add', type: 'prism', axis: 'x', from: -e, to: L + e, poly: contours.left.map(p => [-p[0], p[1]]) });
  // 只有两个视图时，第三个方向用包围盒限制
  ops.push({ op: 'int', type: 'box', min: [0, 0, 0], max: [L, W, H] });
  return ops;
}

// 圆孔：视图中位于外轮廓内部的圆 → 沿该视图投射方向的圆柱孔；深度由另外两个视图里位于 c±r 处的线决定
export function holeOps(drawing, contours) {
  const ops = [];
  const { x: L, y: W, z: H } = drawing.dims;
  const tol = drawing.tol;
  const full = { x: [0, L], y: [0, W], z: [0, H] };
  for (const v of VIEW_KEYS) {
    const dv = drawing.views[v]; if (!dv.present || !contours[v]) continue;
    for (const c of dv.circles) {
      if (!pointInPoly(c.c, contours[v])) continue;
      // 圆与外轮廓相切或相交时视为外形的一部分，不当孔
      if (contours[v].some((p, i) => { const q = contours[v][(i + 1) % contours[v].length]; return distPtSeg(c.c, p, q) < c.r - tol * 0.3; })) continue;
      const axis = AXIS_OF_VIEW[v];
      // 截面圆心：y 轴 → (x,z)；z 轴 → (x,y)；x 轴 → (y,z)
      const cc = v === 'left' ? [-c.c[0], c.c[1]] : [c.c[0], c.c[1]];
      const ranges = [];
      const near = (val, target) => Math.abs(val - target) < tol;
      const take = (view, uk, vk, posK, posVals, rangeMap) => {
        const dw = drawing.views[view]; if (!dw.present) return;
        for (const s of dw.segs) {
          if (s.t === 'center') continue;
          if (!near(s.a[posK], s.b[posK])) continue; // 需与轴线平行
          if (!posVals.some(pv => near(s.a[posK], pv))) continue;
          const k = 1 - posK;
          ranges.push(rangeMap([Math.min(s.a[k], s.b[k]), Math.max(s.a[k], s.b[k])]));
        }
      };
      if (axis === 'y') {
        take('top', 0, 1, 0, [cc[0] - c.r, cc[0] + c.r], r => r);                 // 俯视图竖线 u=x，范围是 y
        take('left', 0, 1, 1, [cc[1] - c.r, cc[1] + c.r], r => [-r[1], -r[0]]);   // 左视图横线 v=z，范围 u=-y
      } else if (axis === 'z') {
        take('front', 0, 1, 0, [cc[0] - c.r, cc[0] + c.r], r => r);               // 主视图竖线 u=x，范围 z
        take('left', 0, 1, 0, [-(cc[1] - c.r), -(cc[1] + c.r)], r => r);          // 左视图竖线 u=-y，范围 z
      } else {
        take('front', 0, 1, 1, [cc[1] - c.r, cc[1] + c.r], r => r);               // 主视图横线 v=z，范围 x
        take('top', 0, 1, 1, [cc[0] - c.r, cc[0] + c.r], r => r);                 // 俯视图横线 v=y，范围 x
      }
      let [t0, t1] = full[axis];
      if (ranges.length) { t0 = Math.min(...ranges.map(r => r[0])); t1 = Math.max(...ranges.map(r => r[1])); }
      // 贴着外表面的一端多切出一点，避免布尔运算留下薄片
      const [f0, f1] = full[axis];
      if (Math.abs(t0 - f0) < tol) t0 = f0 - 1;
      if (Math.abs(t1 - f1) < tol) t1 = f1 + 1;
      if (t1 - t0 < tol) continue;
      ops.push({ op: 'sub', type: 'cyl', axis, c: cc, r: c.r, from: t0, to: t1 });
    }
  }
  // 同轴同半径的重复孔只留一个（不同视图可能都识别到同一个孔的圆）
  const uniq = [];
  for (const o of ops) if (!uniq.some(q => q.axis === o.axis && Math.abs(q.r - o.r) < tol && Math.hypot(q.c[0] - o.c[0], q.c[1] - o.c[1]) < tol && Math.abs(q.from - o.from) < tol && Math.abs(q.to - o.to) < tol)) uniq.push(o);
  return uniq;
}

// 挖切搜索候选盒：坐标取自尚未吻合的线，盒子各面落在这些坐标上
function carveBoxes(drawing, diffs, limit = 160) {
  const { x: L, y: W, z: H } = drawing.dims;
  const tol = drawing.tol;
  const X = new Set([0, L]), Y = new Set([0, W]), Z = new Set([0, H]);
  const addV = (set, val, max) => { if (val > tol * 0.5 && val < max - tol * 0.5) set.add(Math.round(val * 2) / 2); };
  for (const d of diffs) {
    if (d.kind === 'extra' || !d.src) continue;
    // 用识图结果里那条线的真实端点，而不是采样点
    for (const p of [d.src.a, d.src.b]) {
      if (d.view === 'front') { addV(X, p[0], L); addV(Z, p[1], H); }
      if (d.view === 'top') { addV(X, p[0], L); addV(Y, p[1], W); }
      if (d.view === 'left') { addV(Y, -p[0], W); addV(Z, p[1], H); }
    }
  }
  // 合并过近的坐标
  const clean = s => { const a = [...s].sort((p, q) => p - q); const o = []; for (const v of a) if (!o.length || v - o[o.length - 1] > tol * 0.8) o.push(v); return o; };
  const xs = clean(X), ys = clean(Y), zs = clean(Z);
  const iv = a => { const r = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) r.push([a[i], a[j]]); return r; };
  const boxes = [];
  for (const [x0, x1] of iv(xs)) for (const [y0, y1] of iv(ys)) for (const [z0, z1] of iv(zs)) {
    // 整个包围盒不算
    if (x0 === 0 && x1 === L && y0 === 0 && y1 === W && z0 === 0 && z1 === H) continue;
    const ex = (v, lo, hi) => v <= lo + 1e-9 ? lo - 1 : v >= hi - 1e-9 ? hi + 1 : v;
    boxes.push({ op: 'sub', type: 'box', min: [ex(x0, 0, L), ex(y0, 0, W), ex(z0, 0, H)], max: [ex(x1, 0, L), ex(y1, 0, W), ex(z1, 0, H)], vol: (x1 - x0) * (y1 - y0) * (z1 - z0) });
  }
  boxes.sort((a, b) => a.vol - b.vol);
  return boxes.length > limit ? boxes.slice(0, limit) : boxes;
}

// 斜面切割候选：一般位置平面和投影面垂直面在视图里表现为斜线。
// 先找出与三个视图都相容的空间点（类似 Wesley–Markowsky 算法的第一步），
// 再把斜线“抬”成空间棱线，由两条共面的棱线（或一条棱线 + 投射方向）确定切平面。
function onAnySeg(p, segs, tol) { return segs.some(s => distPtSeg(p, s.a, s.b) < tol); }
const proj = { front: p => [p[0], p[2]], top: p => [p[0], p[1]], left: p => [-p[1], p[2]] };
const DIR = { front: [0, 1, 0], top: [0, 0, 1], left: [1, 0, 0] };
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function planeCuts(drawing, diffs, limit = 48) {
  const tol = Math.max(0.6, drawing.tol * 0.5);
  const present = VIEW_KEYS.filter(v => drawing.views[v].present);
  const segsOf = {}; for (const v of present) segsOf[v] = allSegs(drawing.views[v]);
  const vals = { x: new Set(), y: new Set(), z: new Set() };
  for (const v of present) for (const s of drawing.views[v].segs) if (s.t !== 'center') for (const p of [s.a, s.b]) {
    if (v === 'front') { vals.x.add(p[0]); vals.z.add(p[1]); }
    if (v === 'top') { vals.x.add(p[0]); vals.y.add(p[1]); }
    if (v === 'left') { vals.y.add(-p[0]); vals.z.add(p[1]); }
  }
  const verts = [];
  for (const x of vals.x) for (const y of vals.y) for (const z of vals.z) {
    const P = [x, y, z];
    if (present.every(v => onAnySeg(proj[v](P), segsOf[v], tol))) verts.push(P);
  }
  const slanted = [];
  for (const d of diffs) {
    if (!d.src || d.kind === 'extra') continue;
    const s = d.src, dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], L = Math.hypot(dx, dy);
    if (L < tol * 2 || Math.min(Math.abs(dx), Math.abs(dy)) / L < 0.05) continue;
    if (!slanted.some(q => q.s === s)) slanted.push({ v: d.view, s });
  }
  const edges = [];
  for (const { v, s } of slanted) {
    const A = verts.filter(P => Math.hypot(...proj[v](P).map((x, i) => x - s.a[i])) < tol);
    const B = verts.filter(P => Math.hypot(...proj[v](P).map((x, i) => x - s.b[i])) < tol);
    for (const a of A) for (const b of B) if (Math.hypot(...sub3(a, b)) > tol) edges.push({ a, b, v });
  }
  const planes = [];
  const addPlane = (p, n) => {
    n = norm3(n); if (!isFinite(n[0])) return;
    // 只要斜面：法向不能平行于坐标轴
    if (Math.max(...n.map(Math.abs)) > 0.999) return;
    const d = dot3(n, p);
    if (planes.some(q => Math.abs(Math.abs(dot3(q.n, n)) - 1) < 1e-4 && Math.abs(dot3(q.n, q.p) - Math.sign(dot3(q.n, n)) * d) < tol * 0.5)) return;
    planes.push({ p, n });
  };
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i], de = sub3(e.b, e.a);
    addPlane(e.a, cross3(de, DIR[e.v]));                // 投影面垂直面：含该棱且平行于投射方向
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j]; if (f.v === e.v) continue;
      const n = cross3(de, sub3(f.b, f.a));
      if (Math.hypot(...n) < 1e-6) continue;
      const nn = norm3(n);
      if (Math.abs(dot3(nn, sub3(f.a, e.a))) > tol * 0.5) continue; // 不共面
      addPlane(e.a, nn);
    }
  }
  const out = [];
  for (const pl of planes.slice(0, limit / 2)) for (const sg of [1, -1]) out.push({ op: 'sub', type: 'cut', p: pl.p, n: pl.n.map(x => x * sg) });
  return out;
}

// 候选只把界面需要的字段传出后台线程（模型网格、比对用的原始线段不传）
export const slimCand = c => ({ ops: (c.ops || []).map(({ vol, ...o }) => o), name: c.name, score: c.score || 0, error: c.error || null, parts: c.parts || null, tuned: c.tuned || '', perView: c.cmp?.perView || null, diffs: (c.cmp?.diffs || []).map(({ src, ...d }) => d) });

export function evaluate(M, ops, drawing, name = '候选') {
  const def = { id: 'recon-tmp', name, desc: '', points: [], level: '拍照', ops };
  let model;
  try { model = analyze(def, buildMesh(M, def)); } catch (e) { return { ops, name, error: e.message, score: 0 }; }
  const cmp = compare(model, drawing, Math.max(0.8, drawing.tol * 0.7));
  return { ops, name, model, score: cmp.score, cmp };
}

const tick = () => new Promise(r => setTimeout(r, 0));

// 主流程：返回按得分排序的候选
export async function reconstruct(M, drawing, { onStep = () => {}, carve = true, maxCarve = 3, budgetMs = 40000 } = {}) {
  // 复杂的题挖切搜索很费时（手机上更慢），超过时间上限就停下，交给大模型继续
  const t0 = Date.now(), late = () => Date.now() - t0 > budgetMs;
  const contours = contoursOf(drawing);
  const present = VIEW_KEYS.filter(v => drawing.views[v].present);
  const missingC = present.filter(v => !contours[v]);
  if (missingC.length) onStep(`${missingC.map(v => VN[v]).join('、')}没能找到封闭外轮廓，请检查识图结果`);
  const cands = [];
  const hull = hullOps(drawing, contours);
  onStep('外轮廓拉伸求交，得到初始形体');
  const c1 = evaluate(M, hull, drawing, '外形拉伸'); cands.push(c1);
  const holes = holeOps(drawing, contours);
  let best = c1;
  if (holes.length) {
    onStep(`识别到 ${holes.length} 个圆孔，按另两个视图确定深度`);
    const c2 = evaluate(M, [...hull, ...holes], drawing, '外形 + 圆孔'); cands.push(c2);
    if (c2.score > best.score) best = c2;
  }
  await tick();
  // 斜面切割
  for (let round = 0; round < 2 && best.score < 0.985 && best.cmp; round++) {
    const cuts = planeCuts(drawing, best.cmp.diffs);
    if (!cuts.length) break;
    onStep(`发现视图中有斜线，尝试 ${cuts.length / 2} 个可能的切平面`);
    let top = null;
    for (let i = 0; i < cuts.length && !late(); i++) {
      const c = evaluate(M, [...best.ops, cuts[i]], drawing, '');
      if (!top || c.score > top.score) top = c;
      if (i % 8 === 7) await tick();
    }
    if (!top || top.score < best.score + 0.004) break;
    top.name = `斜面切割 ${round + 1} 处`; cands.push(top); best = top;
  }
  if (carve) {
    for (let round = 0; round < maxCarve && best.score < 0.985 && best.cmp; round++) {
      if (late()) { onStep('计算时间较长，挖切搜索先停在这里'); break; }
      const boxes = carveBoxes(drawing, best.cmp.diffs);
      if (!boxes.length) break;
      onStep(`第 ${round + 1} 轮挖切搜索：试 ${boxes.length} 种切除方式`);
      let top = null;
      for (let i = 0; i < boxes.length && !late(); i++) {
        const { vol, ...b } = boxes[i];
        const c = evaluate(M, [...best.ops, b], drawing, '');
        if (!top || c.score > top.score) top = c;
        if (i % 12 === 11) await tick();
      }
      if (!top || top.score < best.score + 0.004) break;
      top.name = `挖切 ${round + 1} 处`;
      cands.push(top); best = top;
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return { cands, contours };
}

// ---------- 交给大模型修正 ----------
export function drawingText(drawing) {
  const out = [];
  const T = { solid: '实线', dashed: '虚线', center: '点画线' };
  const f = p => `(${r1(p[0])},${r1(p[1])})`;
  const coords = { front: '(x,z)', top: '(x,y)', left: '(-y,z)' };
  for (const v of VIEW_KEYS) {
    const dv = drawing.views[v];
    if (!dv.present) { out.push(`${VN[v]}：未给出（需要补画）`); continue; }
    const items = [];
    for (const s of dv.segs) if (s.t !== 'center') items.push(`${T[s.t]} ${f(s.a)}-${f(s.b)}`);
    for (const c of dv.circles) items.push(`${T[c.t]}圆 圆心${f(c.c)} 半径${r1(c.r)}`);
    for (const a of dv.arcs) items.push(`${T[a.t]}圆弧 圆心${f(a.c)} 半径${r1(a.r)} ${Math.round(a.from)}°→${Math.round(a.to)}°`);
    out.push(`${VN[v]} 坐标${coords[v]}：\n  ` + items.join('\n  '));
  }
  return out.join('\n');
}

export const DSL_DOC = `用 JSON 描述形体：{"ops":[...],"explain":"一句话说明形状"}。ops 依次执行，op 为 "add"（叠加）、"sub"（切除）或 "int"（求交）。
坐标：X 向右（长），Y 向后（宽，y=0 是前表面），Z 向上（高），单位与三视图一致。
基本体：
- {"type":"box","min":[x0,y0,z0],"max":[x1,y1,z1]}
- {"type":"prism","axis":"y","from":y0,"to":y1,"poly":[[x,z],...]}  沿 Y 拉伸主视图形状的柱体
- {"type":"prism","axis":"z","from":z0,"to":z1,"poly":[[x,y],...]}  沿 Z 拉伸俯视图形状的柱体
- {"type":"prism","axis":"x","from":x0,"to":x1,"poly":[[y,z],...]}  沿 X 拉伸，截面写在 (y,z) 坐标
- 柱体可加 "circles":[[a,b,r],...]：截面取多边形顶点和这些圆的凸包——带圆角的板、上端为半圆的板、侧面与圆柱相切的支撑板都这样写，切点由程序计算，例如 {"type":"prism","axis":"y","from":20,"to":30,"poly":[[0,8],[60,8]],"circles":[[30,30,15]]}
- {"type":"cyl","axis":"y|z|x","c":[a,b],"r":半径,"from":t0,"to":t1}  圆柱，c 为截面圆心（坐标平面同上）
- {"type":"cut","p":[x,y,z],"n":[nx,ny,nz]}  用过点 p 的平面切掉法向 n 所指的一侧
- {"type":"hull","pts":[[x,y,z],...]}  这些顶点的凸包（凸多面体，如楔块、棱台）
提示：常见做法是把主视图外形沿 Y 拉伸、左视图外形沿 X 拉伸，再用 "int" 求交，然后切孔、切槽。
切除的形体要比实体稍长（伸出外表面 1），避免留下薄片。
叠加的形体之间不能留空隙：肋板要一直连到它支撑的板或圆筒，被挡住、视图里只画成虚线的那一段也是实心的。`;

export function refinePrompt(drawing, best) {
  const parts = [
    '你在根据工程制图三视图（第一角画法）重建三维形体。',
    '【已知三视图（已按长对正、高平齐、宽相等校正）】', drawingText(drawing),
    `【总体尺寸】长 ${r1(drawing.dims.x)}，宽 ${r1(drawing.dims.y)}，高 ${r1(drawing.dims.z)}`,
    '【形体描述语言】', DSL_DOC,
  ];
  if (best) {
    parts.push('【当前最好的方案】', JSON.stringify({ ops: best.ops.map(({ vol, ...o }) => o) }));
    parts.push(`【程序反算三视图后的比对结果】吻合度 ${(best.score * 100).toFixed(1)}%，主要差异：`, diffText(best.cmp?.diffs || []) || '无');
    parts.push('请分析差异的原因（例如缺了哪个槽、孔的深度不对、某个面应是斜面），在当前方案基础上修改。');
  } else parts.push('请给出一个与三视图一致的方案。');
  parts.push('只输出 JSON，不要任何解释。');
  return parts.join('\n');
}

export function parseOps(text) {
  const j2 = extractJSON(String(text), '建模方案');
  const ops = (j2.ops || []).filter(o => o && ['add', 'sub', 'int'].includes(o.op) && ['box', 'prism', 'cyl', 'cut', 'hull'].includes(o.type));
  if (!ops.length) throw new Error('方案里没有可用的形体');
  if (ops[0].op !== 'add') ops[0] = { ...ops[0], op: 'add' };
  return { ops, explain: j2.explain || '' };
}
