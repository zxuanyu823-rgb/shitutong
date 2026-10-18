// 视图通 · 拍照重建 ①：识图结果 → 规范化三视图
import { VIEW_KEYS, VN, extractJSON } from '../util.js';
// 识图模型给出每个视图的局部坐标（原点在该视图包围盒左下角，u 右 v 上），这里转换到与几何引擎一致的视图坐标：
//   主视图 (x, z)   俯视图 (x, y)   左视图 (-y, z)      其中 X 向右、Y 向后（y=0 为前表面）、Z 向上
// 然后用“长对正、高平齐、宽相等”把三个视图互相校正。

export { VIEW_KEYS };
const T = t => (t === 'dashed' || t === 'hidden' ? 'dashed' : t === 'center' ? 'center' : 'solid');

// 解析识图模型的 JSON（容忍 ```json 包裹和多余文字）
export function parseVisionJSON(text) {
  return extractJSON(text, '识图结果');
}

// 局部坐标 → 视图坐标；返回 { views: {front:{present, segs, circles, arcs}, ...}, meta }
export function fromVision(json) {
  const out = { views: {}, question: json.question || '', confidence: json.confidence ?? null, unit: json.unit || '' };
  for (const v of VIEW_KEYS) {
    const src = json.views?.[v];
    const present = !!src && src.present !== false && ((src.lines?.length || 0) + (src.circles?.length || 0) + (src.arcs?.length || 0) > 0);
    const segs = [], circles = [], arcs = [];
    if (present) {
      for (const l of src.lines || []) if (l?.a && l?.b) segs.push({ a: [+l.a[0], +l.a[1]], b: [+l.b[0], +l.b[1]], t: T(l.t) });
      for (const c of src.circles || []) if (c?.c && c.r > 0) circles.push({ c: [+c.c[0], +c.c[1]], r: +c.r, t: T(c.t) });
      for (const a of src.arcs || []) if (a?.c && a.r > 0) arcs.push({ c: [+a.c[0], +a.c[1]], r: +a.r, from: +a.from || 0, to: +a.to || 0, t: T(a.t) });
    }
    out.views[v] = { present, segs, circles, arcs };
  }
  // 平移：每个视图包围盒左下角归零；左视图再整体左移到 u≤0（u = -y，前表面在右侧 u=0）
  for (const v of VIEW_KEYS) {
    const vw = out.views[v]; if (!vw.present) continue;
    const bb = bbox(vw);
    const du = v === 'left' ? -bb[2] : -bb[0], dv = -bb[1];
    shiftView(vw, du, dv);
  }
  return out;
}

function eachPoint(vw, f) {
  for (const s of vw.segs) { f(s.a); f(s.b); }
  for (const c of vw.circles) f(c.c);
  for (const a of vw.arcs) f(a.c);
}
export function bbox(vw) {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  const take = (u, v) => { u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v); };
  for (const s of vw.segs) { if (s.t === 'center') continue; take(...s.a); take(...s.b); }
  for (const c of vw.circles) { take(c.c[0] - c.r, c.c[1] - c.r); take(c.c[0] + c.r, c.c[1] + c.r); }
  for (const a of vw.arcs) for (const p of arcPoints(a, 16)) take(...p);
  if (u0 === Infinity) return [0, 0, 0, 0];
  return [u0, v0, u1, v1];
}
function shiftView(vw, du, dv) { eachPoint(vw, p => { p[0] += du; p[1] += dv; }); }
function scaleView(vw, su, sv) {
  eachPoint(vw, p => { p[0] *= su; p[1] *= sv; });
  for (const c of vw.circles) c.r *= Math.sqrt(su * sv);
  for (const a of vw.arcs) a.r *= Math.sqrt(su * sv);
}

export function arcPoints(a, n = 32) {
  let from = a.from, to = a.to; while (to <= from) to += 360;
  const k = Math.max(2, Math.ceil(n * (to - from) / 360));
  const pts = [];
  for (let i = 0; i <= k; i++) { const t = (from + (to - from) * i / k) * Math.PI / 180; pts.push([a.c[0] + a.r * Math.cos(t), a.c[1] + a.r * Math.sin(t)]); }
  return pts;
}
export function circlePoints(c, n = 48) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const t = 2 * Math.PI * i / n; pts.push([c.c[0] + c.r * Math.cos(t), c.c[1] + c.r * Math.sin(t)]); }
  return pts;
}

// ---------- 三等对齐 ----------
// 每个坐标轴在两个视图里出现：X（主、俯的 u），Z（主、左的 v），Y（俯的 v，左的 -u）
const AXES = {
  x: [['front', 0, 1], ['top', 0, 1]],
  z: [['front', 1, 1], ['left', 1, 1]],
  y: [['top', 1, 1], ['left', 0, -1]],
};

export function reconcile(d) {
  const log = [];
  const P = VIEW_KEYS.filter(v => d.views[v].present);
  if (P.length < 2) throw new Error('至少需要两个视图才能重建');
  // 1) 尺寸统一：同一方向的总尺寸取平均，各视图按轴向缩放
  const ext = {};
  for (const v of P) { const b = bbox(d.views[v]); ext[v] = [b[2] - b[0], b[3] - b[1]]; }
  const dims = {};
  for (const [ax, uses] of Object.entries(AXES)) {
    const vals = uses.filter(([v]) => d.views[v].present).map(([v, k]) => ext[v][k]);
    if (vals.length) dims[ax] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  for (const v of P) {
    const [axU, axV] = v === 'front' ? ['x', 'z'] : v === 'top' ? ['x', 'y'] : ['y', 'z'];
    const su = ext[v][0] ? dims[axU] / ext[v][0] : 1, sv = ext[v][1] ? dims[axV] / ext[v][1] : 1;
    if (Math.abs(su - 1) > 0.01 || Math.abs(sv - 1) > 0.01) log.push(`${VN[v]}比例与其他视图不一致，已按${axU === 'x' ? '长' : '宽'}${'、'}${axV === 'z' ? '高' : '宽'}方向分别缩放 ${(su * 100).toFixed(0)}% / ${(sv * 100).toFixed(0)}%`);
    scaleView(d.views[v], su, sv);
    // 缩放后重新贴齐原点
    const b = bbox(d.views[v]);
    shiftView(d.views[v], v === 'left' ? -b[2] : -b[0], -b[1]);
  }
  // 横平竖直：工程图里绝大多数图线是水平或竖直的，偏差在 3.5° 以内的视为读数误差，拉正
  let straightened = 0;
  for (const v of P) for (const sg of d.views[v].segs) {
    const dx = sg.b[0] - sg.a[0], dy = sg.b[1] - sg.a[1], L = Math.hypot(dx, dy);
    if (!L) continue;
    const ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI) % 180;
    if (ang > 1e-6 && (ang < 3.5 || ang > 176.5)) { const m = (sg.a[1] + sg.b[1]) / 2; sg.a[1] = sg.b[1] = m; straightened++; }
    else if (Math.abs(ang - 90) > 1e-6 && Math.abs(ang - 90) < 3.5) { const m = (sg.a[0] + sg.b[0]) / 2; sg.a[0] = sg.b[0] = m; straightened++; }
  }
  if (straightened) log.push(`有 ${straightened} 条线略微倾斜，按“横平竖直”拉正`);
  const size = Math.max(...Object.values(dims));
  const tol = Math.max(0.6, size * 0.035);
  const ctol = Math.max(0.5, size * 0.02); // 坐标合并容差：真实结构可能只差 2～3 mm，不能合并过头
  // 2) 坐标聚类：同一轴向上相近的坐标值合并为同一个（跨视图 + 视图内）
  let moved = 0, maxMove = 0;
  const examples = [];
  for (const [ax, uses] of Object.entries(AXES)) {
    const refs = []; // {get, set, view}
    for (const [v, k, sign] of uses) {
      const vw = d.views[v]; if (!vw.present) continue;
      const add = (p, kk) => refs.push({ v, val: sign * p[kk], set: x => { p[kk] = sign * x; } });
      for (const s of vw.segs) { add(s.a, k); add(s.b, k); }
      for (const c of vw.circles) add(c.c, k);
      for (const a of vw.arcs) add(a.c, k);
      // 圆的切线位置（c±r）也参与对齐，但只读不写
      for (const c of vw.circles) { refs.push({ v, val: sign * c.c[k] - c.r, ro: true }); refs.push({ v, val: sign * c.c[k] + c.r, ro: true }); }
    }
    refs.sort((a, b) => a.val - b.val);
    let i = 0;
    while (i < refs.length) {
      let j = i; while (j + 1 < refs.length && refs[j + 1].val - refs[j].val < ctol && refs[j + 1].val - refs[i].val < ctol * 3) j++; // 相邻间隔小于容差就归为同一坐标
      const grp = refs.slice(i, j + 1);
      // 取值：优先用整 0.5 的“干净”数；多视图都出现时更可信
      const mean = grp.reduce((s, r) => s + r.val, 0) / grp.length;
      const snap = Math.round(mean * 2) / 2;
      const views = new Set(grp.map(r => r.v));
      for (const r of grp) if (!r.ro) {
        const dlt = Math.abs(r.val - snap);
        if (dlt > 1e-6) { moved++; maxMove = Math.max(maxMove, dlt); r.set(snap); }
      }
      if (views.size > 1) {
        const spread = Math.max(...grp.map(r => r.val)) - Math.min(...grp.map(r => r.val));
        if (spread > 0.3 && examples.length < 6) {
          const rule = ax === 'x' ? '长对正' : ax === 'z' ? '高平齐' : '宽相等';
          examples.push(`${rule}：${[...views].map(v => VN[v]).join('与')}中 ${ax} 方向相差 ${spread.toFixed(1)} 的线统一到 ${ax}=${Math.abs(snap)}`);
        }
      }
      i = j + 1;
    }
  }
  // 聚类后再把各视图贴回原点，保证外轮廓从 0 开始
  for (const v of P) { const b = bbox(d.views[v]); shiftView(d.views[v], v === 'left' ? -b[2] : -b[0], -b[1]); }
  log.push(...examples);
  if (moved) log.push(`共校正 ${moved} 处坐标，最大移动 ${maxMove.toFixed(1)}（容差 ${ctol.toFixed(1)}）`);
  // 3) 清理：去掉过短的线、合并共线重叠的同类线
  for (const v of P) d.views[v].segs = cleanSegs(d.views[v].segs, tol * 0.3);
  d.dims = dims; d.tol = tol; d.log = log;
  return d;
}

function cleanSegs(segs, minLen) {
  const out = [];
  const groups = new Map();
  for (const s of segs) {
    let dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1]; const L = Math.hypot(dx, dy);
    if (L < minLen) continue;
    dx /= L; dy /= L; if (dx < -1e-9 || (Math.abs(dx) < 1e-9 && dy < 0)) { dx = -dx; dy = -dy; }
    const c = -dy * s.a[0] + dx * s.a[1];
    const key = `${s.t}|${Math.round(dx * 200)}|${Math.round(dy * 200)}|${Math.round(c * 4)}`;
    if (!groups.has(key)) groups.set(key, { dx, dy, c, t: s.t, iv: [] });
    const g = groups.get(key);
    const t0 = dx * s.a[0] + dy * s.a[1], t1 = dx * s.b[0] + dy * s.b[1];
    g.iv.push([Math.min(t0, t1), Math.max(t0, t1)]);
  }
  for (const g of groups.values()) {
    g.iv.sort((a, b) => a[0] - b[0]);
    const m = [];
    for (const x of g.iv) { if (m.length && x[0] <= m[m.length - 1][1] + 0.3) m[m.length - 1][1] = Math.max(m[m.length - 1][1], x[1]); else m.push([...x]); }
    const pt = s => [g.dx * s - g.dy * g.c, g.dy * s + g.dx * g.c];
    for (const [s0, s1] of m) out.push({ a: pt(s0), b: pt(s1), t: g.t });
  }
  return out;
}

// ---------- 外轮廓 ----------
// 把可见/不可见轮廓线（不含点画线）建成平面图，沿最外侧走一圈得到外轮廓多边形
export function outerContour(vw, tol = 0.4) {
  const g = graphContour(vw, tol);
  if (g && isSimple(g)) return g;
  return rasterContour(vw, tol * 2.5);
}

function graphContour(vw, tol) {
  const raw = [];
  for (const s of vw.segs) if (s.t !== 'center') raw.push([s.a, s.b]);
  for (const a of vw.arcs) { const p = arcPoints(a, 48); for (let i = 0; i < p.length - 1; i++) raw.push([p[i], p[i + 1]]); }
  for (const c of vw.circles) { const p = circlePoints(c, 48); for (let i = 0; i < p.length - 1; i++) raw.push([p[i], p[i + 1]]); }
  // 互相求交并打断
  const cuts = raw.map(() => [0, 1]);
  for (let i = 0; i < raw.length; i++) for (let j = i + 1; j < raw.length; j++) {
    const r = segInter(raw[i], raw[j], tol);
    if (r) { cuts[i].push(r[0]); cuts[j].push(r[1]); }
  }
  const nodes = []; const key = p => { for (let i = 0; i < nodes.length; i++) if (Math.hypot(nodes[i][0] - p[0], nodes[i][1] - p[1]) < tol) return i; nodes.push(p); return nodes.length - 1; };
  const adj = new Map(); const link = (a, b) => { if (a === b) return; if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set()); adj.get(a).add(b); adj.get(b).add(a); };
  raw.forEach(([a, b], i) => {
    const ts = [...new Set(cuts[i].map(t => Math.round(t * 1e6) / 1e6))].sort((x, y) => x - y);
    for (let k = 0; k < ts.length - 1; k++) {
      const p = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]];
      const q = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
      link(key(p), key(q));
    }
  });
  // 补缝：识图有误差时，线的端点可能差一点没接上；把相距很近的悬空端点连起来
  const gap = tol * 3;
  const ends = [...adj.keys()].filter(n => adj.get(n).size === 1);
  for (const n of ends) {
    if (adj.get(n).size !== 1) continue;
    let best = -1, bd = gap;
    for (const m of adj.keys()) {
      if (m === n || adj.get(n).has(m)) continue;
      const d = Math.hypot(nodes[m][0] - nodes[n][0], nodes[m][1] - nodes[n][1]);
      // 优先接到另一个悬空端点
      const dd = adj.get(m).size === 1 ? d * 0.7 : d;
      if (dd < bd) { bd = dd; best = m; }
    }
    if (best >= 0) link(n, best);
  }
  // 去掉悬挂边
  let changed = true;
  while (changed) { changed = false; for (const [n, s] of adj) if (s.size < 2) { for (const m of s) adj.get(m)?.delete(n); adj.delete(n); changed = true; } }
  if (!adj.size) return null;
  let start = null;
  for (const n of adj.keys()) { const p = nodes[n]; if (start === null || p[1] < nodes[start][1] - 1e-9 || (Math.abs(p[1] - nodes[start][1]) < 1e-9 && p[0] < nodes[start][0])) start = n; }
  const poly = [start];
  let prev = [nodes[start][0] - 1, nodes[start][1]], cur = start, prevNode = -1;
  for (let guard = 0; guard < 5000; guard++) {
    const P = nodes[cur];
    const back = Math.atan2(prev[1] - P[1], prev[0] - P[0]);
    let best = null, bestA = Infinity;
    for (const n of adj.get(cur)) {
      if (n === prevNode && adj.get(cur).size > 1) continue;
      const a = Math.atan2(nodes[n][1] - P[1], nodes[n][0] - P[0]);
      let cw = back - a; while (cw <= 1e-9) cw += 2 * Math.PI;
      if (cw < bestA) { bestA = cw; best = n; }
    }
    if (best === null) break;
    prevNode = cur; prev = P; cur = best;
    if (cur === start) break;
    poly.push(cur);
  }
  // 去掉共线点
  let pts = poly.map(i => nodes[i]);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) > 1e-6 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1])) * 1e3 * 1e-3) out.push(b);
  }
  return out.length >= 3 ? out : null;
}

function isSimple(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const a = poly[i], b = poly[(i + 1) % n], c = poly[j], d = poly[(j + 1) % n];
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
    if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) return false;
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.hypot(poly[i][0] - poly[j][0], poly[i][1] - poly[j][1]) < 1e-6) return false;
  return true;
}

// 栅格法外轮廓：把图线加粗画到网格上，从边界灌水求外部，剩下的就是形体投影区域；
// 再腐蚀回线宽、描边、化简，并把角点吸附到图线端点上。对识图误差（线没接上、略有错位）更稳。
export function rasterContour(vw, tol) {
  const segs = allSegs(vw);
  if (!segs.length) return null;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const s of segs) for (const p of [s.a, s.b]) { u0 = Math.min(u0, p[0]); v0 = Math.min(v0, p[1]); u1 = Math.max(u1, p[0]); v1 = Math.max(v1, p[1]); }
  const size = Math.max(u1 - u0, v1 - v0);
  const cell = Math.max(size / 360, tol / 5);
  const rr = tol * 0.5, pad = rr + 3 * cell;
  const W = Math.ceil((u1 - u0 + 2 * pad) / cell) + 1, H = Math.ceil((v1 - v0 + 2 * pad) / cell) + 1;
  const ox = u0 - pad, oy = v0 - pad;
  const line = new Uint8Array(W * H);
  const k = Math.ceil(rr / cell);
  for (const s of segs) {
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), n = Math.max(1, Math.ceil(L / (cell * 0.5)));
    for (let i = 0; i <= n; i++) {
      const x = (s.a[0] + (s.b[0] - s.a[0]) * i / n - ox) / cell, y = (s.a[1] + (s.b[1] - s.a[1]) * i / n - oy) / cell;
      const cx = Math.round(x), cy = Math.round(y);
      for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
        if (dx * dx + dy * dy > k * k) continue;
        const X = cx + dx, Y = cy + dy; if (X >= 0 && Y >= 0 && X < W && Y < H) line[Y * W + X] = 1;
      }
    }
  }
  // 外部灌水
  const out = new Uint8Array(W * H), st = [];
  for (let x = 0; x < W; x++) { st.push(x, (H - 1) * W + x); }
  for (let y = 0; y < H; y++) { st.push(y * W, y * W + W - 1); }
  while (st.length) { const i = st.pop(); if (out[i] || line[i]) continue; out[i] = 1; const x = i % W, y = (i / W) | 0; if (x > 0) st.push(i - 1); if (x < W - 1) st.push(i + 1); if (y > 0) st.push(i - W); if (y < H - 1) st.push(i + W); }
  // 内部 = 非外部；腐蚀 k 格（先横后竖）
  let inn = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) inn[i] = out[i] ? 0 : 1;
  const erode = (src, horiz) => { const dst = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let ok = 1; for (let d = -k; d <= k && ok; d++) { const X = horiz ? x + d : x, Y = horiz ? y : y + d; if (X < 0 || Y < 0 || X >= W || Y >= H || !src[Y * W + X]) ok = 0; } dst[y * W + x] = ok; } return dst; };
  inn = erode(erode(inn, true), false);
  // 只保留最大的连通区域
  const lab = new Int32Array(W * H).fill(-1); let bestLab = -1, bestN = 0, nl = 0;
  for (let i = 0; i < W * H; i++) {
    if (!inn[i] || lab[i] >= 0) continue;
    let cnt = 0; const q = [i]; lab[i] = nl;
    while (q.length) { const j = q.pop(); cnt++; const x = j % W, y = (j / W) | 0; for (const t of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1]) if (t >= 0 && inn[t] && lab[t] < 0) { lab[t] = nl; q.push(t); } }
    if (cnt > bestN) { bestN = cnt; bestLab = nl; } nl++;
  }
  if (bestLab < 0) return null;
  const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && lab[y * W + x] === bestLab;
  // 沿像素边界描边（按格点走，区域始终在左手边）
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) { sx = x; sy = y; break outer; }
  const pts = [];
  let x = sx, y = sy, dir = 0; // 从像素 (sx,sy) 的左下角出发，向右走（0右 1上 2左 3下）
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  // 判断沿方向 dir 走过的那条边，左侧像素是否在区域内
  const leftIn = (x, y, d) => d === 0 ? inside(x, y) : d === 1 ? inside(x - 1, y) : d === 2 ? inside(x - 1, y - 1) : inside(x, y - 1);
  for (let guard = 0; guard < W * H * 4; guard++) {
    pts.push([ox + x * cell - cell / 2, oy + y * cell - cell / 2]);
    // 依次尝试右转、直行、左转
    let moved = false;
    for (const turn of [3, 0, 1, 2]) {
      const nd = (dir + turn) % 4;
      if (leftIn(x, y, nd) && !edgeRightIn(x, y, nd)) { dir = nd; x += DX[nd]; y += DY[nd]; moved = true; break; }
    }
    if (!moved || (x === sx && y === sy)) break;
  }
  function edgeRightIn(x, y, d) { return d === 0 ? inside(x, y - 1) : d === 1 ? inside(x, y) : d === 2 ? inside(x - 1, y) : inside(x - 1, y - 1); }
  if (pts.length < 4) return null;
  let poly = dp(pts, cell * 1.6);
  // 吸附到图线端点
  const cand = [];
  for (const s of vw.segs) if (s.t !== 'center') cand.push(s.a, s.b);
  for (const a of vw.arcs) { const p = arcPoints(a, 2); cand.push(p[0], p[p.length - 1]); }
  poly = poly.map(p => { let b = null, bd = tol * 1.2; for (const c of cand) { const d = Math.hypot(c[0] - p[0], c[1] - p[1]); if (d < bd) { bd = d; b = c; } } return b ? [b[0], b[1]] : p; });
  const res = [];
  for (const p of poly) if (!res.length || Math.hypot(p[0] - res[res.length - 1][0], p[1] - res[res.length - 1][1]) > 1e-6) res.push(p);
  if (res.length > 1 && Math.hypot(res[0][0] - res[res.length - 1][0], res[0][1] - res[res.length - 1][1]) < 1e-6) res.pop();
  return res.length >= 3 ? res : null;
}

function dp(pts, eps) {
  // 闭合折线的 Douglas–Peucker 化简
  const n = pts.length;
  const keep = new Uint8Array(n);
  let far = 0, fd = -1; for (let i = 1; i < n; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  keep[0] = keep[far] = 1;
  const rec = (i, j) => {
    let idx = -1, md = eps;
    for (let k = i + 1; k < j; k++) { const d = distSeg(pts[k], pts[i], pts[j % n]); if (d > md) { md = d; idx = k; } }
    if (idx >= 0) { keep[idx] = 1; rec(i, idx); rec(idx, j); }
  };
  rec(0, far); rec(far, n);
  return pts.filter((_, i) => keep[i]);
}

function segInter([p, p2], [q, q2], tol) {
  const r = [p2[0] - p[0], p2[1] - p[1]], s = [q2[0] - q[0], q2[1] - q[1]];
  const rxs = r[0] * s[1] - r[1] * s[0];
  const qp = [q[0] - p[0], q[1] - p[1]];
  const Lr = Math.hypot(...r), Ls = Math.hypot(...s);
  if (Math.abs(rxs) < 1e-9 * Lr * Ls) {
    // 平行：处理共线重叠时的端点
    const res = [];
    return null;
  }
  const t = (qp[0] * s[1] - qp[1] * s[0]) / rxs, u = (qp[0] * r[1] - qp[1] * r[0]) / rxs;
  const et = tol / Lr, eu = tol / Ls;
  if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) return null;
  return [Math.max(0, Math.min(1, t)), Math.max(0, Math.min(1, u))];
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 把视图里的全部图线展开成线段（圆、圆弧离散化），用于比对
export function allSegs(vw) {
  const out = vw.segs.filter(s => s.t !== 'center').map(s => ({ a: s.a, b: s.b, t: s.t }));
  for (const c of vw.circles) { const p = circlePoints(c, 48); for (let i = 0; i < p.length - 1; i++) out.push({ a: p[i], b: p[i + 1], t: c.t }); }
  for (const a of vw.arcs) { const p = arcPoints(a, 48); for (let i = 0; i < p.length - 1; i++) out.push({ a: p[i], b: p[i + 1], t: a.t }); }
  return out;
}

// ---------- 测试用：从已知模型生成“模拟识图结果” ----------
// noise：坐标噪声（相对尺寸），scaleErr：各视图比例误差
export function synthVision(model, { noise = 0, scaleErr = 0, drop = null, seed = 1 } = {}) {
  let st = seed; const rnd = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
  const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / Math.sqrt(0.5); };
  const [bmin, bmax] = model.bbox; const size = Math.max(...bmax.map((v, i) => v - bmin[i]));
  const views = {};
  for (const v of VIEW_KEYS) {
    if (v === drop) { views[v] = { present: false }; continue; }
    const vw = model.views[v];
    const lines = [], circles = [], arcs = [];
    // 圆和圆弧：用题库里的圆柱参数，看圆周上哪些部分在该视图中出现
    const dirAxis = { front: 'y', top: 'z', left: 'x' }[v];
    const tolC = 0.12;
    const pieceNear = (p, wantVis) => vw.pieces.some(q => (wantVis === undefined || q.vis === wantVis) && distSeg(p, q.a, q.b) < tolC);
    const onCircle = [];
    for (const o of model.def.ops) {
      if (o.type !== 'cyl' || o.axis !== dirAxis) continue;
      const c = v === 'left' ? [-o.c[0], o.c[1]] : [o.c[0], o.c[1]];
      if (circles.some(q => Math.hypot(q.c[0] - c[0], q.c[1] - c[1]) < 1e-6 && Math.abs(q.r - o.r) < 1e-6)) continue;
      const st = [];
      for (let k = 0; k < 180; k++) {
        const t = k * 2 * Math.PI / 180, p = [c[0] + o.r * Math.cos(t), c[1] + o.r * Math.sin(t)];
        st.push(pieceNear(p, true) ? 'solid' : pieceNear(p, false) ? 'dashed' : null);
      }
      if (st.every(x => x === null)) continue;
      onCircle.push({ c, r: o.r });
      if (st.every(x => x === st[0])) { circles.push({ c, r: o.r, t: st[0] }); continue; }
      // 拆成连续圆弧
      let k0 = st.findIndex((x, i) => x !== st[(i + 179) % 180]);
      for (let n = 0; n < 180;) {
        const t = st[(k0 + n) % 180]; let m = n;
        while (m < 180 && st[(k0 + m) % 180] === t) m++;
        if (t && (m - n) * 2 >= 8) arcs.push({ c, r: o.r, from: ((k0 + n) * 2) % 360, to: ((k0 + m) * 2) % 360 || 360, t });
        n = m;
      }
    }
    const isCurvedLine = l => onCircle.some(cc => [l.a, l.b, [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2]].every(p => Math.abs(Math.hypot(p[0] - cc.c[0], p[1] - cc.c[1]) - cc.r) < 0.35));
    for (const l of vw.lines) {
      if (isCurvedLine(l)) continue;
      lines.push({ a: [...l.a], b: [...l.b], t: l.vis ? 'solid' : 'dashed' });
    }
    for (const c of vw.center) lines.push({ a: [...c.a], b: [...c.b], t: 'center' });
    // 局部坐标：原点在包围盒左下角
    const tmp = { segs: lines.filter(l => l.t !== 'center'), circles, arcs };
    const b = bbox(tmp);
    const su = 1 + scaleErr * g(), sv = 1 + scaleErr * g();
    const tr = p => [(p[0] - b[0]) * su + noise * size * g(), (p[1] - b[1]) * sv + noise * size * g()];
    const r1 = x => Math.round(x * 2) / 2;
    views[v] = {
      present: true, w: r1((b[2] - b[0]) * su), h: r1((b[3] - b[1]) * sv),
      lines: lines.map(l => ({ a: tr(l.a).map(r1), b: tr(l.b).map(r1), t: l.t })),
      circles: circles.map(c => ({ c: tr(c.c).map(r1), r: r1(c.r * Math.sqrt(su * sv)), t: c.t })),
      arcs: arcs.map(a => ({ c: tr(a.c).map(r1), r: r1(a.r * Math.sqrt(su * sv)), from: Math.round(a.from), to: Math.round(a.to), t: a.t })),
    };
  }
  return { unit: 'mm', views, question: '', confidence: 1 };
}

function distSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
