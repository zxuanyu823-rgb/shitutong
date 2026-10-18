// 视图通 · 形体分析建模：大模型按“形体分析法”把组合体分成几个部分（认），
// 坐标吸附到量好的图线上、相切和切点由程序计算、每个部分的范围由程序在附近试几个值挑最吻合的（算）。
import { VIEW_KEYS, VN, r1, extractJSON } from '../util.js';
import { evaluate, contoursOf, holeOps } from './reconstruct.js';

const AXIS_OF = { front: 'y', top: 'z', left: 'x' };          // 投射方向 = 部分的“范围”方向
const VIEW_OF_AXIS = { y: 'front', z: 'top', x: 'left' };
const UV = { front: ['x', 'z'], top: ['x', 'y'], left: ['y', 'z'] }; // 各视图的“友好坐标”
const f = p => `(${r1(p[0])}, ${r1(p[1])})`;

// 内部坐标里左视图横坐标是 -y；给大模型看的、它写回来的都用 (y, z)
const fr = (v, p) => (v === 'left' ? [-p[0], p[1]] : [p[0], p[1]]);
const frArc = (v, a) => (v === 'left' ? { from: (540 - a.to) % 360, to: (540 - a.from) % 360 || 360 } : { from: a.from, to: a.to });

export function axisValues(d) {
  const S = { x: new Set([0]), y: new Set([0]), z: new Set([0]) };
  for (const ax of ['x', 'y', 'z']) if (d.dims[ax] != null) S[ax].add(r1(d.dims[ax]));
  for (const v of VIEW_KEYS) {
    const vw = d.views[v]; if (!vw.present) continue;
    const [a, b] = UV[v];
    for (const s of vw.segs) if (s.t !== 'center') for (const p of [s.a, s.b]) { const q = fr(v, p); S[a].add(r1(q[0])); S[b].add(r1(q[1])); }
    for (const c of [...vw.circles, ...vw.arcs]) {
      const q = fr(v, c.c);
      for (const k of [-1, 0, 1]) { S[a].add(r1(q[0] + k * c.r)); S[b].add(r1(q[1] + k * c.r)); }
    }
  }
  const out = {};
  for (const ax of ['x', 'y', 'z']) {
    const lo = -0.01, hi = (d.dims[ax] ?? Infinity) + 0.01;
    out[ax] = [...S[ax]].filter(x => x >= lo && x <= hi).sort((p, q) => p - q);
  }
  return out;
}

export function partsDrawingText(d) {
  const T = { solid: '实线', dashed: '虚线', center: '点画线' };
  const head = { front: '主视图 坐标(x, z)', top: '俯视图 坐标(x, y)，图上越往上 y 越大（越靠后）', left: '左视图 坐标(y, z)，图上越往左 y 越大（越靠后）' };
  const out = [];
  for (const v of VIEW_KEYS) {
    const vw = d.views[v];
    if (!vw.present) { out.push(`${VN[v]}：题目未给出`); continue; }
    const items = [];
    for (const s of vw.segs) if (s.t !== 'center') items.push(`${T[s.t]} ${f(fr(v, s.a))}-${f(fr(v, s.b))}`);
    for (const c of vw.circles) items.push(`${T[c.t]}圆 圆心${f(fr(v, c.c))} 半径${r1(c.r)}`);
    for (const a of vw.arcs) { const g = frArc(v, a); items.push(`${T[a.t]}圆弧 圆心${f(fr(v, a.c))} 半径${r1(a.r)} ${Math.round(g.from)}°→${Math.round(g.to)}°`); }
    out.push(`${head[v]}：\n  ` + items.join('\n  '));
  }
  return out.join('\n');
}

const RULES = `【坐标约定】X 向右（长），Y 向后（宽，y=0 是最前面），Z 向上（高）。
- 主视图坐标 (x, z)：在主视图里描轮廓的部分，range 写它的前后范围 [y1, y2]。
- 俯视图坐标 (x, y)：在俯视图里描轮廓的部分，range 写它的上下范围 [z1, z2]。
- 左视图坐标 (y, z)：在左视图里描轮廓的部分，range 写它的左右范围 [x1, x2]。

【怎么分解（形体分析法）】
1. 先对照三个视图读懂形体：它由哪些部分叠加而成（底板、竖板、支撑板、肋板、圆筒、凸台……），又挖切掉了哪些部分（孔、槽、缺口、切角……）。
2. 每个部分选一个反映它实形的视图（在那个视图里它是一个封闭线框或一个圆），用该视图的坐标写出轮廓 loop（按顺序的顶点），再从另外两个视图读出它沿投射方向的范围 range。
3. 圆柱、圆筒、凸台、圆孔：在显示为圆的视图里写 circle:[圆心坐标1, 圆心坐标2, 半径]，range 是沿轴线的范围。圆筒 = 外圆柱叠加 + 内孔挖切，分两个部分写。
4. 带圆角的板、上端是半圆的板、侧面与圆柱相切的支撑板：loop 只写直线部分的顶点，再在 circles 里列出相切的圆 [[圆心1, 圆心2, 半径], ...]，程序取它们的凸包、自动算切点。不要自己算切点。
5. 斜面、三角形肋板、切角：在斜线积聚成直线的那个视图里用多边形 loop 表示。
6. 贯通的孔、槽，range 写 "通"。
7. 叠加的部分之间不能悬空、留缝：肋板、支撑板要一直连到它支撑的底板、竖板或圆筒，被圆筒等挡住、在视图里只画成虚线的那一段也是实心的，要画进轮廓里。
8. 坐标尽量直接取图线数据里出现过的数值。叠加的部分写在前面，挖切的写在后面。

【输出格式】只输出 JSON：
{"explain":"一句话说明形体","parts":[
 {"name":"底板","op":"add","view":"top","loop":[[0,0],[60,0],[60,30],[0,30]],"range":[0,8]},
 {"name":"圆头竖板","op":"add","view":"front","loop":[[15,8],[45,8]],"circles":[[30,30,15]],"range":[20,30]},
 {"name":"竖板圆孔","op":"sub","view":"front","circle":[30,30,8],"range":"通"},
 {"name":"底板通孔","op":"sub","view":"top","circle":[10,10,4],"range":"通"}
]}
（以上只是格式示例，与本题无关。op 只能是 add 或 sub；view 只能是 front、top、left。）`;

export function partsPrompt(d, { photo = false, refs = '' } = {}) {
  const ax = axisValues(d);
  return [
    '你在用“形体分析法”读一道组合体三视图题（第一角画法：主视图在左上，俯视图在主视图正下方，左视图在主视图正右方）。你只需要把形体分解成几个部分，精确的几何由程序计算。',
    '【程序从照片量出的三视图图线】' + (photo ? '（可能有漏读、误读，以图1 照片为准）' : ''), partsDrawingText(d),
    `【各方向出现过的坐标值】\n  x：${ax.x.join('、')}\n  y：${ax.y.join('、')}\n  z：${ax.z.join('、')}`,
    `【总体尺寸】长 ${r1(d.dims.x)}，宽 ${r1(d.dims.y)}，高 ${r1(d.dims.z)}`,
    RULES,
    refs ? `【联网检索到的相似题目资料，仅供参考，以照片为准】\n${refs}` : '',
    photo ? '图1 是题目照片。请先看懂照片里的形体，再结合上面的坐标写出各部分。只输出 JSON。' : '只输出 JSON。',
  ].filter(Boolean).join('\n');
}

export function diffTextFriendly(diffs, limit = 12) {
  const K = { missing: '缺少', extra: '多出', type: '虚实不对：应为' };
  const T = { solid: '实线', dashed: '虚线' };
  return diffs
    .map(x => ({ ...x, L: Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]) }))
    .sort((a, b) => b.L - a.L).slice(0, limit)
    .map(x => `${VN[x.view]}：${K[x.kind]}${T[x.t] || '线'}，从 ${f(fr(x.view, x.a))} 到 ${f(fr(x.view, x.b))}`)
    .join('\n');
}

export function partsRefinePrompt(d, cand, { photo = false, issues = [] } = {}) {
  const ax = axisValues(d);
  const pv = Object.entries(cand.perView || {}).map(([v, p]) => `${VN[v]} ${(p.score * 100).toFixed(0)}%`).join('，');
  return [
    '你在用“形体分析法”读一道组合体三视图题（第一角画法）。下面是你之前的分解方案，程序已经把坐标对齐到图线上、并微调过各部分的范围，按它建模后反算三视图与题目比对，还有差异。',
    '【题目三视图图线】', partsDrawingText(d),
    `【各方向出现过的坐标值】\n  x：${ax.x.join('、')}\n  y：${ax.y.join('、')}\n  z：${ax.z.join('、')}`,
    `【总体尺寸】长 ${r1(d.dims.x)}，宽 ${r1(d.dims.y)}，高 ${r1(d.dims.z)}`,
    '【当前方案】', JSON.stringify({ parts: (cand.parts || []).map(cleanPart) }),
    `【比对结果】图线吻合度 ${((cand.score || 0) * 100).toFixed(1)}%${pv ? `（${pv}）` : ''}，主要差异：`, diffTextFriendly(cand.diffs || []) || '无',
    issues.length ? '【对照照片发现的问题】\n' + issues.map(x => '- ' + x).join('\n') : '',
    RULES,
    photo ? '图1 是题目照片，图2 是当前方案反算出的三视图。' : '',
    '请找出差异的原因（漏了哪个部分、哪个部分的轮廓或范围不对、叠加和挖切弄反了……），修改后输出完整的 JSON。只输出 JSON。',
  ].filter(Boolean).join('\n');
}

// ---------- 解析大模型的回答 ----------
const VIEW_ALIAS = { front: 'front', top: 'top', left: 'left', 主视图: 'front', 主视: 'front', 正视图: 'front', 俯视图: 'top', 俯视: 'top', 左视图: 'left', 左视: 'left', 侧视图: 'left' };
const num = x => (typeof x === 'string' ? parseFloat(x) : x);
const pt2 = p => (Array.isArray(p) && p.length >= 2 ? [num(p[0]), num(p[1])] : p && typeof p === 'object' ? [num(p.x ?? p.u ?? p[0]), num(p.y ?? p.z ?? p.v ?? p[1])] : null);
const circ = q => {
  if (Array.isArray(q) && q.length >= 3) return [num(q[0]), num(q[1]), num(q[2])];
  if (q && typeof q === 'object') { const c = pt2(q.c || q.center); const r = num(q.r ?? q.radius ?? (q.d ? q.d / 2 : NaN)); return c ? [c[0], c[1], r] : null; }
  return null;
};
const finite = a => Array.isArray(a) && a.every(Number.isFinite);

export function parseParts(text) {
  const raw = extractJSON(String(text), '形体分析结果');
  const list = Array.isArray(raw.parts) ? raw.parts : Array.isArray(raw) ? raw : [];
  const parts = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const view = VIEW_ALIAS[String(p.view || '').trim()] || null; if (!view) continue;
    const op = /sub|挖|切|孔|槽|减/.test(String(p.op || '')) ? 'sub' : 'add';
    let range = p.range;
    if (typeof range === 'string' && /通|through|all|贯/.test(range)) range = 'through';
    else if (Array.isArray(range) && range.length >= 2) { range = [num(range[0]), num(range[1])]; if (!finite(range)) range = 'through'; }
    else range = 'through';
    const out = { name: String(p.name || (op === 'sub' ? '挖切' : '叠加')).slice(0, 20), op, view, range };
    const c = circ(p.circle);
    if (c && finite(c) && c[2] > 0) out.circle = c;
    else {
      out.loop = (Array.isArray(p.loop) ? p.loop : []).map(pt2).filter(finite);
      const cs = (Array.isArray(p.circles) ? p.circles : []).map(circ).filter(q => q && finite(q) && q[2] > 0);
      if (cs.length) out.circles = cs;
      if (out.loop.length < 3 && !(out.circles && out.loop.length + out.circles.length * 2 >= 3)) continue;
    }
    parts.push(out);
  }
  if (!parts.some(p => p.op === 'add')) throw new Error('形体分析结果里没有可用的叠加部分');
  return { parts, explain: String(raw.explain || '') };
}

const cleanPart = p => {
  const o = { name: p.name, op: p.op, view: p.view };
  if (p.circle) o.circle = p.circle.map(r1);
  else { o.loop = p.loop.map(q => q.map(r1)); if (p.circles?.length) o.circles = p.circles.map(q => q.map(r1)); }
  o.range = p.range === 'through' ? '通' : p.range.map(r1);
  return o;
};

// ---------- 吸附 + 转成建模步骤 ----------
function nearest(vals, x, tol) {
  let best = x, bd = tol;
  for (const v of vals) { const dd = Math.abs(v - x); if (dd <= bd) { bd = dd; best = v; } }
  return best;
}

function viewCircles(d, v) {
  const vw = d.views[v]; if (!vw?.present) return [];
  return [...vw.circles, ...vw.arcs].map(c => { const q = fr(v, c.c); return [q[0], q[1], c.r]; });
}

// 把各部分的坐标对齐到图线上的坐标（大模型的读数常差一点点，几何上差一点就会多出一堆线）
export function snapParts(parts, d) {
  const vals = axisValues(d);
  const size = Math.max(d.dims.x || 0, d.dims.y || 0, d.dims.z || 0) || 1;
  const tol = Math.max(0.6, size * 0.015);
  const out = parts.map(p => {
    const [a, b] = UV[p.view], ax = AXIS_OF[p.view];
    const known = viewCircles(d, p.view);
    const snapC = q => {
      let best = null, bd = Infinity;
      for (const k of known) { const dc = Math.hypot(k[0] - q[0], k[1] - q[1]), dr = Math.abs(k[2] - q[2]); if (dc < tol && dr < tol && dc + dr < bd) { bd = dc + dr; best = k; } }
      return best ? [...best] : [nearest(vals[a], q[0], tol), nearest(vals[b], q[1], tol), q[2]];
    };
    const o = { ...p };
    if (p.circle) o.circle = snapC(p.circle);
    else {
      o.loop = p.loop.map(q => [nearest(vals[a], q[0], tol), nearest(vals[b], q[1], tol)]);
      if (p.circles) o.circles = p.circles.map(snapC);
    }
    if (p.range !== 'through') { const r = [nearest(vals[ax], p.range[0], tol), nearest(vals[ax], p.range[1], tol)].sort((x, y) => x - y); o.range = r[1] - r[0] > 1e-6 ? r : 'through'; }
    return o;
  });
  // 支撑板相切的圆和圆筒用同一个圆：两处数值稍有出入，相切处就会缺一块或鼓一块
  const cyl = out.filter(p => p.circle && p.op === 'add');
  for (const p of out) if (p.circles) p.circles = p.circles.map(q => {
    const m = cyl.find(c => c.view === p.view && Math.hypot(c.circle[0] - q[0], c.circle[1] - q[1]) < tol * 2 && Math.abs(c.circle[2] - q[2]) < tol * 2);
    return m ? [...m.circle] : q;
  });
  return out;
}

// 挖切轮廓贴着外表面的边往外推 1（避免布尔运算留下薄片）。只推“沿着外表面”的边：
// 端点相连的斜边沿原来的方向延长出去，倒角、V 形槽的斜度不变；只是顶点碰到外表面的不动
function pushOut(loop, hi) {
  const n = loop.length, side = (p, k) => (Math.abs(p[k]) < 0.06 ? -1 : Math.abs(p[k] - hi[k]) < 0.06 ? 1 : 0);
  const res = loop.map(p => [...p]);
  for (let i = 0; i < n; i++) {
    const P = loop[i], prev = loop[(i + n - 1) % n], next = loop[(i + 1) % n];
    for (const k of [0, 1]) {
      const s = side(P, k); if (!s) continue;
      const alongPrev = side(prev, k) === s, alongNext = side(next, k) === s;
      if (!alongPrev && !alongNext) continue;
      const Q = alongPrev ? next : prev, target = P[k] + s;
      if (alongPrev && alongNext) { res[i][k] = target; continue; }
      // 另一条边垂直于外表面：直接推；斜着：沿这条边的方向延长到 target
      if (Math.abs(Q[k] - P[k]) < 1e-9 || Math.abs(Q[1 - k] - P[1 - k]) < 1e-9) res[i][k] = target;
      else { const t = (target - Q[k]) / (P[k] - Q[k]); res[i] = [Q[0] + (P[0] - Q[0]) * t, Q[1] + (P[1] - Q[1]) * t]; res[i][k] = target; }
    }
  }
  return res;
}

export function partsToOps(parts, d) {
  const dim = ax => d.dims[ax] || 0;
  const ops = [];
  const ordered = [...parts.filter(p => p.op === 'add'), ...parts.filter(p => p.op === 'sub')];
  for (const p of ordered) {
    const [a, b] = UV[p.view], ax = AXIS_OF[p.view];
    let [t0, t1] = p.range === 'through' ? [-1, dim(ax) + 1] : p.range;
    // 挖切体贴着外表面的一端多切出 1，避免布尔运算留下薄片
    const out = (x, axis) => (p.op !== 'sub' ? x : Math.abs(x) < 0.06 ? -1 : Math.abs(x - dim(axis)) < 0.06 ? dim(axis) + 1 : x);
    if (p.op === 'sub') { t0 = out(t0, ax); t1 = out(t1, ax); }
    if (p.circle) {
      ops.push({ op: p.op, type: 'cyl', axis: ax, c: [p.circle[0], p.circle[1]], r: p.circle[2], from: t0, to: t1 });
    } else {
      const op = { op: p.op, type: 'prism', axis: ax, from: t0, to: t1, poly: p.op === 'sub' ? pushOut(p.loop, [dim(a), dim(b)]) : p.loop.map(q => [...q]) };
      if (p.circles?.length) op.circles = p.circles.map(q => [q[0], q[1], q[2]]);
      ops.push(op);
    }
  }
  if (ops.length && ops[0].op !== 'add') ops[0] = { ...ops[0], op: 'add' };
  return ops;
}

// ---------- 程序微调：每个部分的范围在相邻坐标里试，也试去掉某个部分、补上程序识别到的圆孔 ----------
export async function buildFromParts(M, parts0, d, { name = '形体分析', budgetMs = 25000, maxEvals = 90, onStep = () => {} } = {}) {
  const t0 = Date.now();
  const vals = axisValues(d);
  let evals = 0;
  const run = parts => { evals++; const c = evaluate(M, partsToOps(parts, d), d, name); c.parts = parts; return c; };
  let parts = snapParts(parts0, d);
  let best = run(parts);
  if (best.error) {
    // 整体建不出来时逐个去掉可疑部分
    for (let i = 0; i < parts.length && best.error; i++) { const q = parts.filter((_, k) => k !== i); if (q.some(p => p.op === 'add')) { const c = run(q); if (!c.error) { best = c; parts = q; } } }
    if (best.error) return best;
  }
  const start = best.score;
  // 程序自己识别到的圆孔，作为可以补上的部分
  const holes = holeOps(d, contoursOf(d)).map(h => ({ name: '圆孔（程序识别）', op: 'sub', view: VIEW_OF_AXIS[h.axis], circle: [h.c[0], h.c[1], h.r], range: [h.from, h.to] }));
  const out = () => Date.now() - t0 > budgetMs || evals >= maxEvals;
  // 补一截：叠加部件朝外的面往外长到下一个坐标值（比如肋板只写了圆筒前面的三角，压在圆筒下面的那段漏了）
  const extendMoves = ps => {
    const idx = ps.map((p, j) => (p.op === 'add' ? j : -1)).filter(j => j >= 0);
    return gapExtensions(partsToOps(ps, d), d, best.cmp?.diffs || [], vals).filter(g => g.i < idx.length).map(g => {
      const j = idx[g.i], o = g.op;
      return q => q.map((pp, k) => (k !== j ? pp : o.type === 'prism' && !pp.circles ? { ...pp, loop: o.poly.map(v => [...v]), range: [o.from, o.to] } : { ...pp, range: [o.from, o.to] }));
    });
  };
  const moves = ps => {
    const list = [];
    ps.forEach((p, i) => {
      const ax = AXIS_OF[p.view], V = vals[ax];
      if (p.range !== 'through') {
        const [a, b] = p.range;
        const nb = (x, dir) => { const s = dir < 0 ? V.filter(v => v < x - 1e-6) : V.filter(v => v > x + 1e-6); return dir < 0 ? s[s.length - 1] : s[0]; };
        for (const [k, x] of [[0, nb(a, -1)], [0, nb(a, 1)], [1, nb(b, -1)], [1, nb(b, 1)]]) {
          if (x == null) continue;
          const r = [...p.range]; r[k] = x; if (r[1] - r[0] < 1e-6) continue;
          list.push(q => q.map((pp, j) => (j === i ? { ...pp, range: r } : pp)));
        }
        if (p.op === 'sub') list.push(q => q.map((pp, j) => (j === i ? { ...pp, range: 'through' } : pp)));
      }
      // 圆孔的深度：按另两个视图里孔的轮廓线（程序识别）来定
      if (p.op === 'sub' && p.circle) for (const h of holes) {
        if (h.view !== p.view || Math.hypot(h.circle[0] - p.circle[0], h.circle[1] - p.circle[1]) > 2.5 || Math.abs(h.circle[2] - p.circle[2]) > 1.5) continue;
        if (p.range !== 'through' && Math.abs(p.range[0] - h.range[0]) < 0.3 && Math.abs(p.range[1] - h.range[1]) < 0.3) continue;
        list.push(q => q.map((pp, j) => (j === i ? { ...pp, range: h.range } : pp)));
      }
      if (ps.filter(x => x.op === 'add').length > 1 || p.op === 'sub') list.push(q => q.filter((_, j) => j !== i));
    });
    for (const h of holes) {
      const dup = ps.some(p => p.circle && p.view === h.view && Math.hypot(p.circle[0] - h.circle[0], p.circle[1] - h.circle[1]) < 0.5 && Math.abs(p.circle[2] - h.circle[2]) < 0.5);
      if (!dup) list.push(q => [...q, h]);
    }
    return list;
  };
  for (let pass = 0, grown = 0; pass < 6 && best.score < 0.995 && !out(); pass++) {
    let improved = false;
    for (const mv of moves(parts)) {
      if (out()) break;
      const q = mv(parts); const c = run(q);
      if (!c.error && c.score > best.score + 0.003) { best = c; parts = q; improved = true; onStep(`微调后吻合度 ${(c.score * 100).toFixed(1)}%`); }
    }
    // 范围、孔都调不动了，再试着把某个部件往外长一截（几种长法都试，留最好的）
    if (!improved && grown < 2) {
      let pick = null;
      for (const mv of extendMoves(parts)) {
        if (out()) break;
        const q = mv(parts); const c = run(q);
        if (!c.error && c.score > (pick ? pick.c.score : best.score + 0.003)) pick = { c, q };
      }
      if (pick) { best = pick.c; parts = pick.q; improved = true; grown++; onStep(`补齐后吻合度 ${(best.score * 100).toFixed(1)}%`); }
    }
    if (!improved) break;
  }
  best.name = name;
  best.tuned = best.score > start + 0.003 ? `程序微调：${(start * 100).toFixed(1)}% → ${(best.score * 100).toFixed(1)}%` : '';
  return best;
}

// ---------- 补齐：叠加体朝外的面没贴着该贴的东西 ----------
// 某个面在图上的投影正好是一条“多出来的线”，或者把它往外长一段、长出来的块的轮廓正好落在“缺少的线”上，
// 就试着把形体沿这个面的法线方向长到下一个坐标值（或者碰到别的形体），由反算三视图的吻合度决定要不要。
const rng = (p, q) => [Math.min(p, q), Math.max(p, q)];
const EPS = 0.02;
const projBox = (B, w) => (w === 'front' ? [B.x, B.z] : w === 'top' ? [B.x, B.y] : [[-B.y[1], -B.y[0]], B.z]);

// 去掉多边形里共线的中间点（留着它，布尔运算时可能在面上多切出一道棱，视图里多一条线）
function dropCollinear(P) {
  let Q = P.map(v => [...v]);
  for (let changed = true; changed && Q.length > 3;) {
    changed = false;
    for (let j = 0; j < Q.length && Q.length > 3; j++) {
      const a = Q[(j + Q.length - 1) % Q.length], b = Q[j], c = Q[(j + 1) % Q.length];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cr) < 1e-6 * (1 + Math.hypot(c[0] - a[0], c[1] - a[1])) || Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) { Q.splice(j, 1); changed = true; j--; }
    }
  }
  return Q;
}

// 叠加体朝外的面：k 法线方向的坐标轴，x 面所在的坐标，s 朝外的方向，E 面在另两个方向上的范围，grow(x1) 把形体本身长到 x1
function facesOf(o) {
  const F = [];
  if (o.type === 'box') {
    ['x', 'y', 'z'].forEach((k, j) => {
      const E = {}; ['x', 'y', 'z'].forEach((m, jj) => { if (m !== k) E[m] = [o.min[jj], o.max[jj]]; });
      for (const s of [-1, 1]) F.push({ k, x: s < 0 ? o.min[j] : o.max[j], s, E, grow: x1 => { const q = { ...o, min: [...o.min], max: [...o.max] }; (s < 0 ? q.min : q.max)[j] = x1; return q; } });
    });
    return F;
  }
  if (o.type !== 'prism' && o.type !== 'cyl') return F;
  const A = o.axis, [a, b] = UV[VIEW_OF_AXIS[A]], [lo, hi] = rng(o.from, o.to);
  const pts = o.type === 'cyl' ? [[o.c[0] - o.r, o.c[1] - o.r], [o.c[0] + o.r, o.c[1] + o.r]]
    : [...o.poly, ...(o.circles || []).flatMap(q => [[q[0] - q[2], q[1] - q[2]], [q[0] + q[2], q[1] + q[2]]])];
  const bb = { [a]: rng(Math.min(...pts.map(q => q[0])), Math.max(...pts.map(q => q[0]))), [b]: rng(Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[1]))) };
  // 两个端面：沿轴线加长
  for (const s of [-1, 1]) F.push({ k: A, x: s < 0 ? lo : hi, s, E: bb, grow: x1 => ({ ...o, from: s < 0 ? x1 : lo, to: s > 0 ? x1 : hi }) });
  // 截面上最靠外的横边、竖边：截面多边形往外拉出一块（只拉最外侧的边，拉出来的部分不会和截面自己重叠）
  if (o.type === 'prism' && !o.circles?.length && o.poly.length >= 3) {
    const P = o.poly, n = P.length;
    for (let j = 0; j < n; j++) {
      const p = P[j], q = P[(j + 1) % n];
      for (const c of [0, 1]) {
        if (Math.abs(p[c] - q[c]) > 1e-6 || Math.abs(p[1 - c] - q[1 - c]) < 0.5) continue;
        const vs = P.map(v => v[c]), s = p[c] >= Math.max(...vs) - 1e-6 ? 1 : p[c] <= Math.min(...vs) + 1e-6 ? -1 : 0;
        if (!s) continue;
        F.push({ k: c ? b : a, x: p[c], s, E: { [c ? a : b]: rng(p[1 - c], q[1 - c]), [A]: [lo, hi] }, grow: x1 => {
          const p2 = [...p], q2 = [...q]; p2[c] = x1; q2[c] = x1;
          return { ...o, poly: dropCollinear([...P.slice(0, j + 1), p2, q2, ...P.slice(j + 1)]) };
        } });
      }
    }
  }
  return F;
}

function bboxOf(o) {
  if (o.type === 'box') return { x: [o.min[0], o.max[0]], y: [o.min[1], o.max[1]], z: [o.min[2], o.max[2]] };
  if (o.type !== 'prism' && o.type !== 'cyl') return null;
  const f = facesOf(o)[0];
  return f ? { ...f.E, [o.axis]: rng(o.from, o.to) } : null;
}

export function gapExtensions(ops, d, diffs, vals = axisValues(d), limit = 8) {
  const tolD = Math.max(0.8, d.tol * 0.7);
  const D = diffs.map(x => ({ ...x, len: Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]), horiz: Math.abs(x.a[1] - x.b[1]) < tolD, vert: Math.abs(x.a[0] - x.b[0]) < tolD }));
  if (!D.length) return [];
  const overlap = (p, q, R) => Math.max(0, Math.min(Math.max(p, q), R[1]) - Math.max(Math.min(p, q), R[0]));
  // 长出来的块的轮廓线上有“缺少的线”
  const missingOn = B => {
    let L = 0;
    for (const x of D) {
      if (x.kind === 'extra') continue;
      const [U, V] = projBox(B, x.view), inU = q => q >= U[0] - tolD && q <= U[1] + tolD, inV = q => q >= V[0] - tolD && q <= V[1] + tolD;
      if (x.horiz && V.some(v => Math.abs(x.a[1] - v) < tolD) && inU(x.a[0]) && inU(x.b[0])) L += x.len;
      else if (x.vert && U.some(u => Math.abs(x.a[0] - u) < tolD) && inV(x.a[1]) && inV(x.b[1])) L += x.len;
    }
    return L;
  };
  // 这个面本身的投影上有“多出来的线”
  const extraOn = f => {
    const B = { ...f.E, [f.k]: [f.x, f.x] }; let L = 0;
    for (const x of D) {
      if (x.kind !== 'extra') continue;
      const [U, V] = projBox(B, x.view);
      if (x.vert && U[1] - U[0] < 1e-6 && Math.abs(x.a[0] - U[0]) < tolD) L += overlap(x.a[1], x.b[1], V);
      else if (x.horiz && V[1] - V[0] < 1e-6 && Math.abs(x.a[1] - V[0]) < tolD) L += overlap(x.a[0], x.b[0], U);
    }
    return L;
  };
  const boxes = ops.map(o => (o.op === 'add' ? bboxOf(o) : null));
  const out = [];
  ops.forEach((o, i) => {
    if (o.op !== 'add') return;
    for (const f of facesOf(o)) {
      if (!f.s) continue;
      const V = vals[f.k] || [], lim = d.dims[f.k] ?? Infinity;
      const beyond = x => (f.s > 0 ? x > f.x + 0.3 && x <= lim + 0.01 : x < f.x - 0.3 && x >= -0.01);
      const next = (f.s > 0 ? V.filter(beyond) : V.filter(beyond).reverse()).slice(0, 5);
      // 往外长到碰上别的叠加体为止（比如肋板长到支撑板的前面）
      let touch = null;
      boxes.forEach((B, j) => {
        if (!B || j === i || !Object.keys(f.E).every(m => B[m][0] < f.E[m][1] - 0.3 && B[m][1] > f.E[m][0] + 0.3)) return;
        const x = f.s > 0 ? B[f.k][0] : B[f.k][1];
        if (beyond(x) && (touch == null || Math.abs(x - f.x) < Math.abs(touch - f.x))) touch = x;
      });
      const ex = extraOn(f);
      for (const x1 of touch != null && !next.some(v => Math.abs(v - touch) < 0.05) ? [...next, touch] : next) {
        const L = ex + missingOn({ ...f.E, [f.k]: rng(f.x, x1) });
        if (L <= tolD) continue;
        // 长到碰上别的形体时多伸进去一点点：正好贴着的面，布尔运算后可能留下夹在中间的双层面，图上多出线
        const tc = touch != null && Math.abs(x1 - touch) < 0.05;
        out.push({ L, i, op: f.grow(tc ? x1 + f.s * EPS : x1), dist: Math.abs(x1 - f.x), touch: tc });
      }
    }
  });
  return out.sort((p, q) => (Math.abs(q.L - p.L) > 0.5 ? q.L - p.L : (q.touch - p.touch) || p.dist - q.dist)).slice(0, limit);
}

// 给任意一个候选（看图直接建模、修正后的方案）做补齐：每轮试几种延伸，留下吻合度提高最多的
export function fillGaps(M, cand, d, { name = cand?.name, maxEvals = 24, budgetMs = 10000, onStep = () => {} } = {}) {
  if (!cand || cand.error || !cand.cmp || cand.score >= 0.995) return cand;
  const t0 = Date.now(), vals = axisValues(d), start = cand.score;
  let best = cand, evals = 0;
  for (let round = 0; round < 3; round++) {
    let better = null;
    for (const g of gapExtensions(best.ops, d, best.cmp.diffs || [], vals)) {
      if (evals >= maxEvals || Date.now() - t0 > budgetMs) break;
      const ops = best.ops.map((o, j) => (j === g.i ? g.op : o));
      const c = evaluate(M, ops, d, name); evals++;
      if (!c.error && c.score > (better || best).score + 0.002) better = c;
    }
    if (!better) break;
    best = better; onStep(`补齐后吻合度 ${(best.score * 100).toFixed(1)}%`);
  }
  if (best !== cand) { best.explain = cand.explain; best.tuned = `程序补齐：${(start * 100).toFixed(1)}% → ${(best.score * 100).toFixed(1)}%`; }
  return best;
}

export { cleanPart };
