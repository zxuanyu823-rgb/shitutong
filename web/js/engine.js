// 视图通 · 几何引擎
import { VIEW_KEYS, distPtSeg, r1 } from './util.js';
// 1. 用 Manifold 做布尔运算得到实体网格
// 2. 提取「面」（光滑相连的三角形）和「棱」（两面交线）
// 3. 按 GB 第一角画法求主/俯/左视图，逐段判断可见性（实线/虚线）
// 4. 建立 2D 线 ↔ 3D 棱/面 的双向对应，供讲解和练习使用

export const VIEWS = {
  front: { key: 'front', name: '主视图', dir: [0, -1, 0], uAxis: 'x', vAxis: 'z' },
  top:   { key: 'top',   name: '俯视图', dir: [0, 0, 1],  uAxis: 'x', vAxis: 'y' },
  left:  { key: 'left',  name: '左视图', dir: [-1, 0, 0], uAxis: '-y', vAxis: 'z' },
};
export { VIEW_KEYS };

// 3D → 2D（每个视图自己的坐标，单位 mm）
export function project(view, p) {
  switch (view) {
    case 'front': return [p[0], p[2]];
    case 'top': return [p[0], p[1]];
    case 'left': return [-p[1], p[2]];
  }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const fmt = x => { const v = r1(x); return Object.is(v, -0) ? '0' : String(v); };
export const fmtPt = p => `(${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])})`;

// ---------- 建模 ----------

const CYL_SEG = 64;

function colMajor(A, T) {
  // A: 3x3 行优先；输出 Manifold 需要的列优先 4x4
  return [A[0][0], A[1][0], A[2][0], 0, A[0][1], A[1][1], A[2][1], 0, A[0][2], A[1][2], A[2][2], 0, T[0], T[1], T[2], 1];
}
// 把「在 XY 平面内画、沿 Z 拉伸 h」的形体放到指定轴向，范围 from..to
function placeAlong(m, axis, from, to) {
  // Manifold transformations return a new owning handle. This helper consumes
  // the local shape, including when placement fails.
  try {
    if (axis === 'z') return m.translate([0, 0, from]);
    if (axis === 'y') return m.transform(colMajor([[1, 0, 0], [0, 0, -1], [0, 1, 0]], [0, to, 0])); // (a,b,t)→(a, to-t, b)
    if (axis === 'x') return m.transform(colMajor([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [from, 0, 0])); // (a,b,t)→(from+t, a, b)
    throw new Error('bad axis ' + axis);
  } finally { m.delete?.(); }
}

function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

export const hullR = r => r - (r * (1 - Math.cos(Math.PI / CYL_SEG)) * 1.1 + 0.01);
// circles 可写成 [{c:[a,b],r}] 或 [[a,b,r]]
export function circlesOf(s) {
  return (Array.isArray(s.circles) ? s.circles : []).map(q => Array.isArray(q) ? { c: [+q[0], +q[1]], r: +q[2] } : { c: [+q.c[0], +q.c[1]], r: +q.r }).filter(q => q.r > 0 && q.c.every(Number.isFinite));
}
// 平面点集的凸包（单调链法，逆时针，去掉共线点）
export function hull2d(pts) {
  const P = pts.filter(p => p.every(Number.isFinite)).map(p => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 1e-9) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 1e-9) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

function shapeOf(M, s) {
  const { Manifold, CrossSection } = M;
  if (s.type === 'box') {
    const size = sub(s.max, s.min);
    const cube = Manifold.cube(size, false);
    try { return cube.translate(s.min); } finally { cube.delete?.(); }
  }
  if (s.type === 'prism') {
    let poly = (s.poly || []).map(p => [+p[0], +p[1]]);
    // 带 circles 时取这些顶点和圆的凸包：圆角板、与圆柱相切的支撑板都这样表示，切点由程序算
    // 凸包用的圆比同位置的圆柱略小一丝（小于网格的弓高），圆弧部分完全埋进圆柱里，
    // 不会和圆柱的网格面重合（重合面做布尔运算会留下碎面、多画出线）
    // （缩小在 snapToFacets 里按是否有同位置的圆柱决定）
    const circles = circlesOf(s);
    if (circles.length) poly = hull2d([...poly, ...circles.flatMap(({ c, r }) => Array.from({ length: CYL_SEG }, (_, k) => [c[0] + r * Math.cos(2 * Math.PI * k / CYL_SEG), c[1] + r * Math.sin(2 * Math.PI * k / CYL_SEG)]))]);
    if (poly.length < 3) throw new Error('柱体截面至少要 3 个顶点');
    if (polyArea(poly) < 0) poly = poly.reverse();
    const cs = new CrossSection([poly]);
    try { return placeAlong(cs.extrude(s.to - s.from), s.axis, s.from, s.to); }
    finally { cs.delete?.(); }
  }
  if (s.type === 'cyl') {
    const cylinder = Manifold.cylinder(s.to - s.from, s.r, s.r, CYL_SEG, false);
    let c;
    try { c = cylinder.translate([s.c[0], s.c[1], 0]); }
    finally { cylinder.delete?.(); }
    return placeAlong(c, s.axis, s.from, s.to);
  }
  if (s.type === 'hull') {
    // 凸多面体：给出顶点，取凸包（楔块、棱台、斜切块都可以这样描述）
    return Manifold.hull(s.pts.map(p => [+p[0], +p[1], +p[2]]));
  }
  throw new Error('unknown shape ' + s.type);
}

// 柱体截面上落在同轴圆柱圆周上的顶点（比如支撑板与圆筒的切点），挪到圆柱网格的边上。
// 圆柱是用 CYL_SEG 边形近似的，切点恰好在真实圆上时会比网格多凸出一丝，
// 布尔运算后留下极窄的小面，三视图里就会在“相切处”多画出一条线。
function snapToFacets(ops) {
  const cyls = ops.filter(o => o.type === 'cyl');
  const D = 2 * Math.PI / CYL_SEG;
  return ops.map(o => {
    if (o.type !== 'prism') return o;
    const lo = Math.min(o.from, o.to), hi = Math.max(o.from, o.to);
    const cs = cyls.filter(c => c.axis === o.axis && Math.min(c.from, c.to) < hi && Math.max(c.from, c.to) > lo);
    if (!cs.length) return o;
    const same = q => cs.some(c => Math.hypot(c.c[0] - q.c[0], c.c[1] - q.c[1]) < 1e-6 && Math.abs(c.r - q.r) < 1e-6);
    const circles = circlesOf(o).map(q => (same(q) ? { c: q.c, r: hullR(q.r) } : q));
    const poly = (o.poly || []).map(p => {
      for (const c of cs) {
        const dx = p[0] - c.c[0], dy = p[1] - c.c[1], d = Math.hypot(dx, dy);
        if (Math.abs(d - c.r) > Math.max(0.02, c.r * 0.004)) continue;
        let phi = Math.atan2(dy, dx); if (phi < 0) phi += 2 * Math.PI;
        const mid = (Math.floor(phi / D) + 0.5) * D, rr = c.r * Math.cos(D / 2) / Math.cos(phi - mid);
        return [c.c[0] + rr * Math.cos(phi), c.c[1] + rr * Math.sin(phi)];
      }
      return p;
    });
    return { ...o, poly, circles };
  });
}

export function buildMesh(M, def) {
  let solid = null;
  try {
    for (const o of snapToFacets(def.ops)) {
      if (o.type === 'cut') {
        if (o.op !== 'sub' || !solid) throw new Error('平面切割必须用于已有实体的 sub 操作');
        if (!(len(o.n) > 0)) throw new Error('切割法向量不能为零');
        // trimByPlane keeps dot(normal, point) >= offset. The DSL normal
        // points at the removed side, so negate it to keep the other half.
        const keepNormal = mul(norm(o.n), -1), previous = solid;
        solid = previous.trimByPlane(keepNormal, dot(keepNormal, o.p));
        previous.delete?.();
        continue;
      }
      const s = shapeOf(M, o);
      if (!solid && (o.op === 'add' || o.op === 'int')) { solid = s; continue; }
      try {
        if (solid) {
          const previous = solid;
          solid = o.op === 'add' ? previous.add(s) : o.op === 'int' ? previous.intersect(s) : previous.subtract(s);
          previous.delete?.();
        }
      } finally { s.delete?.(); }
    }
    if (!solid || solid.isEmpty()) throw new Error('生成的形体为空');
    const mesh = solid.getMesh();
    const np = mesh.numProp;
    const pos = [], tris = [];
    const vmap = new Map(), remap = [];
    for (let i = 0; i < mesh.vertProperties.length / np; i++) {
      const p = [0, 1, 2].map(k => Math.round(mesh.vertProperties[i * np + k] * 1e4) / 1e4);
      const key = p.join(',');
      if (!vmap.has(key)) { vmap.set(key, pos.length); pos.push(p); }
      remap.push(vmap.get(key));
    }
    for (let i = 0; i < mesh.triVerts.length; i += 3) {
      const t = [remap[mesh.triVerts[i]], remap[mesh.triVerts[i + 1]], remap[mesh.triVerts[i + 2]]];
      if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) tris.push(t);
    }
    return { pos, tris };
  } finally {
    solid?.delete?.();
  }
}

// ---------- 拓扑分析 ----------

const FEATURE_DEG = 20;          // 二面角大于此值视为棱线
const FEATURE_COS = Math.cos(FEATURE_DEG * Math.PI / 180);

function classifyPlane(n) {
  const e = 1e-4, [x, y, z] = n.map(Math.abs);
  if (y < e && x < e) return { kind: '水平面', short: '水平面', parallel: 'H' };
  if (x < e && z < e) return { kind: '正平面', short: '正平面', parallel: 'V' };
  if (y < e && z < e) return { kind: '侧平面', short: '侧平面', parallel: 'W' };
  if (z < e) return { kind: '铅垂面', short: '铅垂面', perp: 'H' };
  if (y < e) return { kind: '正垂面', short: '正垂面', perp: 'V' };
  if (x < e) return { kind: '侧垂面', short: '侧垂面', perp: 'W' };
  return { kind: '一般位置平面', short: '一般位置平面' };
}
export function classifyLine(d) {
  const e = 1e-4, [x, y, z] = norm(d).map(Math.abs);
  if (x < e && y < e) return '铅垂线';
  if (x < e && z < e) return '正垂线';
  if (y < e && z < e) return '侧垂线';
  if (z < e) return '水平线';
  if (y < e) return '正平线';
  if (x < e) return '侧平线';
  return '一般位置直线';
}

function faceLabel(n, d, bmin, bmax) {
  // 按朝向和是否在外轮廓上命名：外表面叫“顶面/前表面…”，内部的台阶、槽壁按朝向称呼
  const e = 1e-4, at = (v, w) => Math.abs(v - w) < 1e-3;
  if (Math.abs(n[2] - 1) < e) return at(d, bmax[2]) ? '顶面' : '朝上的水平面';
  if (Math.abs(n[2] + 1) < e) return at(-d, bmin[2]) ? '底面' : '朝下的水平面';
  if (Math.abs(n[1] + 1) < e) return at(-d, bmin[1]) ? '前表面' : '朝前的正平面';
  if (Math.abs(n[1] - 1) < e) return at(d, bmax[1]) ? '后表面' : '朝后的正平面';
  if (Math.abs(n[0] + 1) < e) return at(-d, bmin[0]) ? '左端面' : '朝左的侧平面';
  if (Math.abs(n[0] - 1) < e) return at(d, bmax[0]) ? '右端面' : '朝右的侧平面';
  return '斜面';
}

export function analyze(def, raw) {
  const { pos, tris } = raw;
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  for (const p of pos) for (let k = 0; k < 3; k++) { bmin[k] = Math.min(bmin[k], p[k]); bmax[k] = Math.max(bmax[k], p[k]); }
  const T = tris.length;
  const tn = new Array(T), tarea = new Array(T);
  for (let i = 0; i < T; i++) {
    const [a, b, c] = tris[i].map(k => pos[k]);
    const cr = cross(sub(b, a), sub(c, a));
    tarea[i] = len(cr) / 2; tn[i] = norm(cr);
  }
  // 边 → 相邻三角形
  const edgeMap = new Map();
  const ek = (a, b) => a < b ? a + '_' + b : b + '_' + a;
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3], key = ek(a, b);
      if (!edgeMap.has(key)) edgeMap.set(key, { a: Math.min(a, b), b: Math.max(a, b), tris: [] });
      edgeMap.get(key).tris.push(i);
    }
  });
  // 面分组（光滑相连）
  const parent = Array.from({ length: T }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const meshEdges = [...edgeMap.values()];
  for (const e of meshEdges) {
    if (e.tris.length !== 2) { e.feature = true; continue; }
    const c = dot(tn[e.tris[0]], tn[e.tris[1]]);
    e.feature = c < FEATURE_COS;
    if (!e.feature) { const ra = find(e.tris[0]), rb = find(e.tris[1]); if (ra !== rb) parent[ra] = rb; }
  }
  const groupOfRoot = new Map(); const triFace = new Array(T);
  const faces = [];
  for (let i = 0; i < T; i++) {
    const r = find(i);
    if (!groupOfRoot.has(r)) { groupOfRoot.set(r, faces.length); faces.push({ tris: [] }); }
    triFace[i] = groupOfRoot.get(r); faces[triFace[i]].tris.push(i);
  }
  // 面属性
  // 柱体凸包里的圆（圆角、相切板的圆头）也按圆柱面识别
  const cylOps = [...def.ops.filter(o => o.type === 'cyl'), ...def.ops.filter(o => o.type === 'prism').flatMap(o => circlesOf(o).map(q => ({ op: o.op, type: 'cyl', axis: o.axis, c: q.c, r: q.r, from: o.from, to: o.to, fromHull: true })))];
  faces.forEach(f => {
    let area = 0, nsum = [0, 0, 0], cen = [0, 0, 0];
    const vset = new Set();
    for (const t of f.tris) {
      area += tarea[t]; nsum = add(nsum, mul(tn[t], tarea[t]));
      tris[t].forEach(v => vset.add(v));
    }
    f.area = area; f.verts = [...vset];
    for (const v of f.verts) cen = add(cen, pos[v]);
    f.centroid = mul(cen, 1 / f.verts.length);
    const navg = norm(nsum);
    const planar = f.tris.every(t => dot(tn[t], navg) > 0.9999);
    f.planar = planar;
    if (planar) {
      f.normal = navg; f.d = dot(navg, pos[tris[f.tris[0]][0]]);
      Object.assign(f, classifyPlane(navg));
      f.label = faceLabel(navg, f.d, bmin, bmax);
    } else {
      // 曲面：匹配圆柱参数
      f.normal = null;
      let match = null;
      for (const o of cylOps) {
        const ax = { x: 0, y: 1, z: 2 }[o.axis];
        const others = [0, 1, 2].filter(k => k !== ax);
        const cc = o.axis === 'y' ? [o.c[0], o.c[1]] : o.c; // y 轴：c=(x,z)；x 轴：c=(y,z)；z 轴：c=(x,y)
        const ok = f.verts.every(v => {
          const p = pos[v];
          const dd = Math.hypot(p[others[0]] - cc[0], p[others[1]] - cc[1]);
          return Math.abs(dd - o.r) < 0.05 && p[ax] >= Math.min(o.from, o.to) - 0.01 && p[ax] <= Math.max(o.from, o.to) + 0.01;
        });
        if (ok) { match = o; break; }
      }
      // 与圆柱相切的平面也可能并入同一组：只要大部分顶点在圆柱上即可
      if (!match) {
        for (const o of cylOps) {
          const ax = { x: 0, y: 1, z: 2 }[o.axis];
          const others = [0, 1, 2].filter(k => k !== ax);
          const cc = o.c;
          const onCyl = f.verts.filter(v => { const p = pos[v]; return Math.abs(Math.hypot(p[others[0]] - cc[0], p[others[1]] - cc[1]) - o.r) < 0.05; }).length;
          if (onCyl / f.verts.length > 0.6) { match = o; break; }
        }
      }
      f.cyl = match;
      f.axisDir = match ? ({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] })[match.axis] : null;
      if (match && match.op === 'sub') { f.kind = '圆孔面'; f.short = '孔壁'; f.label = `Φ${fmt(match.r * 2)} 孔的孔壁`; }
      else if (match) { f.kind = '圆柱面'; f.short = '圆柱面'; f.label = `R${fmt(match.r)} 圆柱面`; }
      else { f.kind = '曲面'; f.short = '曲面'; f.label = '曲面'; }
      f.tangentPlane = !!match && f.verts.some(v => { const p = pos[v]; const ax = { x: 0, y: 1, z: 2 }[match.axis]; const o = [0, 1, 2].filter(k => k !== ax); return Math.abs(Math.hypot(p[o[0]] - match.c[0], p[o[1]] - match.c[1]) - match.r) > 0.05; });
    }
  });
  // 面编号：按位置排序，便于讲解
  const order = faces.map((f, i) => i).sort((i, j) => {
    const a = faces[i].centroid, b = faces[j].centroid;
    return (b[2] - a[2]) || (a[1] - b[1]) || (a[0] - b[0]);
  });
  order.forEach((fi, k) => { faces[fi].id = 'F' + (k + 1); faces[fi].index = fi; });
  faces.forEach(f => {
    if (f.planar) {
      const ax = Math.abs(f.normal[2]) > 0.9999 ? 'z' : Math.abs(f.normal[1]) > 0.9999 ? 'y' : Math.abs(f.normal[0]) > 0.9999 ? 'x' : null;
      f.where = ax ? `${ax}=${fmt(f.d * (ax === 'x' ? f.normal[0] : ax === 'y' ? f.normal[1] : f.normal[2]))}` : `过点 ${fmtPt(f.centroid)}`;
      f.name = `${f.label}（${f.kind}，${f.where}）`;
    } else {
      f.name = f.label + (f.tangentPlane ? '（含相切平面）' : '');
    }
  });

  // 棱：两面交线，按 (面A,面B) 分组再按连通性拆分
  const pairEdges = new Map();
  for (const e of meshEdges) {
    if (!e.feature || e.tris.length !== 2) continue;
    const fa = triFace[e.tris[0]], fb = triFace[e.tris[1]];
    if (fa === fb) continue;
    const key = fa < fb ? fa + '-' + fb : fb + '-' + fa;
    if (!pairEdges.has(key)) pairEdges.set(key, []);
    pairEdges.get(key).push(e);
  }
  const curves = [];
  for (const [key, list] of pairEdges) {
    const [fa, fb] = key.split('-').map(Number);
    // 连通分量
    const adj = new Map();
    list.forEach((e, i) => { for (const v of [e.a, e.b]) { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(i); } });
    const seen = new Array(list.length).fill(false);
    for (let s = 0; s < list.length; s++) {
      if (seen[s]) continue;
      const comp = []; const stack = [s]; seen[s] = true;
      while (stack.length) {
        const i = stack.pop(); comp.push(list[i]);
        for (const v of [list[i].a, list[i].b]) for (const j of adj.get(v)) if (!seen[j]) { seen[j] = true; stack.push(j); }
      }
      curves.push(makeCurve(comp, [fa, fb]));
    }
  }
  function makeCurve(segs, fpair) {
    const pts = segs.map(e => [pos[e.a], pos[e.b]]);
    // 是否共线
    const p0 = pts[0][0];
    let far = pts[0][1], fd = 0;
    for (const [a, b] of pts) for (const p of [a, b]) { const d = len(sub(p, p0)); if (d > fd) { fd = d; far = p; } }
    const dir = norm(sub(far, p0));
    let straight = true;
    for (const [a, b] of pts) for (const p of [a, b]) { const w = sub(p, p0); if (len(sub(w, mul(dir, dot(w, dir)))) > 1e-3) straight = false; }
    let total = 0; for (const [a, b] of pts) total += len(sub(b, a));
    const c = { segs: pts, faces: fpair, straight, length: total };
    if (straight) {
      let tmin = Infinity, tmax = -Infinity;
      for (const [a, b] of pts) for (const p of [a, b]) { const t = dot(sub(p, p0), dir); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
      c.ends = [add(p0, mul(dir, tmin)), add(p0, mul(dir, tmax))];
      c.dir = dir; c.lineKind = classifyLine(dir);
    } else {
      c.lineKind = '曲线';
      // 圆弧：估计半径
      let cen = [0, 0, 0], n = 0; for (const [a] of pts) { cen = add(cen, a); n++; }
      c.center = mul(cen, 1 / n);
    }
    return c;
  }
  curves.sort((a, b) => {
    const ca = a.straight ? lerp(a.ends[0], a.ends[1], 0.5) : a.center, cb = b.straight ? lerp(b.ends[0], b.ends[1], 0.5) : b.center;
    return (cb[2] - ca[2]) || (ca[1] - cb[1]) || (ca[0] - cb[0]);
  });
  curves.forEach((c, i) => {
    c.id = 'E' + (i + 1); c.index = i;
    const [A, B] = c.faces.map(fi => faces[fi]);
    c.desc = c.straight
      ? `${c.lineKind}，从 ${fmtPt(c.ends[0])} 到 ${fmtPt(c.ends[1])}，长 ${fmt(c.length)}`
      : `${A.kind === '圆孔面' || B.kind === '圆孔面' || A.kind === '圆柱面' || B.kind === '圆柱面' ? '圆弧/圆' : '曲线'}，长约 ${fmt(c.length)}`;
    c.between = `${A.id} ${A.label} 与 ${B.id} ${B.label} 的交线`;
  });
  faces.forEach(f => { f.curves = curves.filter(c => c.faces.includes(f.index)).map(c => c.id); });


  const model = { def, pos, tris, tn, triFace, faces, curves, meshEdges, bbox: [bmin, bmax], views: {} };
  for (const v of VIEW_KEYS) model.views[v] = computeView(model, v);
  return model;
}

// ---------- 视图计算 ----------

function buildGrid(model, view) {
  const { pos, tris } = model;
  const P = pos.map(p => project(view, p));
  let umin = Infinity, vmin = Infinity, umax = -Infinity, vmax = -Infinity;
  for (const [u, v] of P) { umin = Math.min(umin, u); vmin = Math.min(vmin, v); umax = Math.max(umax, u); vmax = Math.max(vmax, v); }
  const N = 48, cw = (umax - umin) / N || 1, ch = (vmax - vmin) / N || 1;
  const cells = Array.from({ length: N * N }, () => []);
  const d = VIEWS[view].dir;
  tris.forEach((t, i) => {
    if (Math.abs(dot(model.tn[i], d)) < 1e-9) return;
    const us = t.map(k => P[k][0]), vs = t.map(k => P[k][1]);
    const i0 = Math.max(0, Math.floor((Math.min(...us) - umin) / cw - 1e-6)), i1 = Math.min(N - 1, Math.floor((Math.max(...us) - umin) / cw + 1e-6));
    const j0 = Math.max(0, Math.floor((Math.min(...vs) - vmin) / ch - 1e-6)), j1 = Math.min(N - 1, Math.floor((Math.max(...vs) - vmin) / ch + 1e-6));
    for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) cells[b * N + a].push(i);
  });
  return { P, umin, vmin, cw, ch, N, cells };
}

// 从点 p 沿视线方向朝观察者发射射线，返回第一个遮挡三角形（不含起点所在的面）
function rayHit(model, grid, view, p, eps = 1e-4, farthest = false) {
  const d = VIEWS[view].dir;
  const [u, v] = project(view, p);
  const a = Math.floor((u - grid.umin) / grid.cw), b = Math.floor((v - grid.vmin) / grid.ch);
  if (a < 0 || b < 0 || a >= grid.N || b >= grid.N) return null;
  let best = null, bestT = Infinity;
  for (const ti of grid.cells[b * grid.N + a]) {
    const t = rayTri(p, d, model.tris[ti].map(k => model.pos[k]));
    if (t !== null && t > eps && (farthest ? (best === null || t > bestT) : t < bestT)) { bestT = t; best = ti; }
  }
  return best === null ? null : { tri: best, t: bestT, face: model.triFace[best] };
}
// 从无穷远处沿视线看过来，找到某个 2D 点处最前面的面
export function pickFace(model, view, uv) {
  const vw = model.views[view];
  const d = VIEWS[view].dir;
  const [bmin, bmax] = model.bbox;
  const margin = Math.max(1, len(sub(bmax, bmin)) * 0.01);
  let p;
  if (view === 'front') p = [uv[0], bmin[1] - margin, uv[1]];
  else if (view === 'top') p = [uv[0], uv[1], bmax[2] + margin];
  else p = [bmin[0] - margin, -uv[0], uv[1]];
  // 射线方向：背离观察者
  const back = mul(d, -1);
  const a = Math.floor((uv[0] - vw.grid.umin) / vw.grid.cw), b = Math.floor((uv[1] - vw.grid.vmin) / vw.grid.ch);
  if (a < 0 || b < 0 || a >= vw.grid.N || b >= vw.grid.N) return null;
  const hits = [];
  for (const ti of vw.grid.cells[b * vw.grid.N + a]) {
    const t = rayTri(p, back, model.tris[ti].map(k => model.pos[k]));
    if (t !== null && t >= 0) hits.push({ t, face: model.triFace[ti] });
  }
  hits.sort((x, y) => x.t - y.t);
  const seen = new Set(), order = [];
  for (const h of hits) if (!seen.has(h.face)) { seen.add(h.face); order.push(h.face); }
  return order;
}

function rayTri(o, d, [a, b, c]) {
  const e1 = sub(b, a), e2 = sub(c, a);
  const pv = cross(d, e2), det = dot(e1, pv);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det, tv = sub(o, a);
  const u = dot(tv, pv) * inv; if (u < -1e-7 || u > 1 + 1e-7) return null;
  const qv = cross(tv, e1);
  const v = dot(d, qv) * inv; if (v < -1e-7 || u + v > 1 + 1e-7) return null;
  return dot(e2, qv) * inv;
}

function computeView(model, view) {
  const grid = buildGrid(model, view);
  const d = VIEWS[view].dir;
  const pieces = []; // {a,b (2D), vis, src:'E3'|'S..', a3,b3}

  const visibleAt = p => !rayHit(model, grid, view, p);
  function addSegment3(a3, b3, src) {
    const a2 = project(view, a3), b2 = project(view, b3);
    if (Math.hypot(b2[0] - a2[0], b2[1] - a2[1]) < 1e-6) return; // 与视线平行，积聚为点
    const L = len(sub(b3, a3));
    const n = Math.max(2, Math.ceil(L / 0.8));
    const st = [];
    for (let i = 0; i < n; i++) st.push(visibleAt(lerp(a3, b3, (i + 0.5) / n)));
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || st[i] !== st[start]) {
        let t0 = start === 0 ? 0 : null, t1 = i === n ? 1 : null;
        if (t0 === null) t0 = bisect(a3, b3, (start - 0.5) / n, (start + 0.5) / n, st[start - 1]);
        if (t1 === null) t1 = bisect(a3, b3, (i - 0.5) / n, (i + 0.5) / n, st[i - 1]);
        const p = lerp(a3, b3, t0), q = lerp(a3, b3, t1);
        const pa = project(view, p), pb = project(view, q);
        if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) > 1e-4) pieces.push({ a: pa, b: pb, vis: st[start], src, a3: p, b3: q });
        start = i;
      }
    }
  }
  function bisect(a3, b3, lo, hi, stateLo) {
    for (let k = 0; k < 22; k++) { const m = (lo + hi) / 2; if (visibleAt(lerp(a3, b3, m)) === stateLo) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }

  for (const c of model.curves) for (const [a, b] of c.segs) addSegment3(a, b, c.id);

  // 转向轮廓线（曲面在该方向上的外形线）
  const silEdges = [];
  for (const e of model.meshEdges) {
    if (e.feature || e.tris.length !== 2) continue;
    const s1 = dot(model.tn[e.tris[0]], d), s2 = dot(model.tn[e.tris[1]], d);
    const z1 = Math.abs(s1) < 1e-6, z2 = Math.abs(s2) < 1e-6;
    if ((s1 > 1e-6 && s2 < -1e-6) || (s1 < -1e-6 && s2 > 1e-6) || (z1 !== z2)) silEdges.push(e);
  }
  // 按连通性归组
  const sils = [];
  {
    const adj = new Map();
    silEdges.forEach((e, i) => { for (const v of [e.a, e.b]) { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(i); } });
    const seen = new Array(silEdges.length).fill(false);
    for (let s = 0; s < silEdges.length; s++) {
      if (seen[s]) continue;
      const comp = [], st = [s]; seen[s] = true;
      while (st.length) { const i = st.pop(); comp.push(silEdges[i]); for (const v of [silEdges[i].a, silEdges[i].b]) for (const j of adj.get(v)) if (!seen[j]) { seen[j] = true; st.push(j); } }
      const id = `S${view[0].toUpperCase()}${sils.length + 1}`;
      const face = model.triFace[comp[0].tris[0]];
      const segs = comp.map(e => [model.pos[e.a], model.pos[e.b]]);
      sils.push({ id, face, segs, faceId: model.faces[face].id });
      for (const [a, b] of segs) addSegment3(a, b, id);
    }
  }

  // 积聚：面平行于视线时投影为线
  const edgeOnFaces = model.faces.filter(f => f.tris.every(t => Math.abs(dot(model.tn[t], d)) < 1e-3)).map(f => f.index);

  // 合并共线重叠线段：可见优先，被可见线覆盖的虚线不再画
  const lines = mergeLines(pieces);
  const center = centerLines(model, view);
  return { view, grid, pieces, lines, center, sils, edgeOnFaces };
}

function mergeLines(pieces) {
  const groups = new Map();
  for (const p of pieces) {
    let dx = p.b[0] - p.a[0], dy = p.b[1] - p.a[1];
    const L = Math.hypot(dx, dy); dx /= L; dy /= L;
    if (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dy < 0)) { dx = -dx; dy = -dy; }
    const nx = -dy, ny = dx, c = nx * p.a[0] + ny * p.a[1];
    const key = `${Math.round(dx * 1e4)},${Math.round(dy * 1e4)},${Math.round(c * 1e3)}`;
    if (!groups.has(key)) groups.set(key, { dx, dy, nx, ny, c, vis: [], hid: [] });
    const g = groups.get(key);
    const s0 = dx * p.a[0] + dy * p.a[1], s1 = dx * p.b[0] + dy * p.b[1];
    (p.vis ? g.vis : g.hid).push([Math.min(s0, s1), Math.max(s0, s1)]);
  }
  const out = [];
  const union = iv => {
    iv.sort((a, b) => a[0] - b[0]); const r = [];
    for (const x of iv) { if (r.length && x[0] <= r[r.length - 1][1] + 1e-4) r[r.length - 1][1] = Math.max(r[r.length - 1][1], x[1]); else r.push([...x]); }
    return r;
  };
  const minus = (A, B) => {
    const r = [];
    for (const [a0, a1] of A) {
      let segs = [[a0, a1]];
      for (const [b0, b1] of B) {
        const nx = [];
        for (const [s0, s1] of segs) {
          if (b1 <= s0 + 1e-4 || b0 >= s1 - 1e-4) { nx.push([s0, s1]); continue; }
          if (b0 > s0 + 1e-4) nx.push([s0, b0]);
          if (b1 < s1 - 1e-4) nx.push([b1, s1]);
        }
        segs = nx;
      }
      r.push(...segs.filter(([s0, s1]) => s1 - s0 > 0.05));
    }
    return r;
  };
  for (const g of groups.values()) {
    const V = union(g.vis), H = minus(union(g.hid), V);
    const pt = s => [g.dx * s + g.nx * g.c, g.dy * s + g.ny * g.c];
    for (const [s0, s1] of V) out.push({ a: pt(s0), b: pt(s1), vis: true });
    for (const [s0, s1] of H) out.push({ a: pt(s0), b: pt(s1), vis: false });
  }
  return out;
}

function centerLines(model, view) {
  const out = [];
  const d = VIEWS[view].dir;
  const seen = new Set();
  for (const o of model.def.ops) {
    if (o.type !== 'cyl') continue;
    // 只给实际存在的圆柱面画中心线
    if (!model.faces.some(f => f.cyl === o)) continue;
    const ax = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[o.axis];
    const c3 = (t) => o.axis === 'z' ? [o.c[0], o.c[1], t] : o.axis === 'y' ? [o.c[0], t, o.c[1]] : [t, o.c[0], o.c[1]];
    // 实际长度取实体范围内
    const [bmin, bmax] = model.bbox; const k = { x: 0, y: 1, z: 2 }[o.axis];
    const t0 = Math.max(Math.min(o.from, o.to), bmin[k]), t1 = Math.min(Math.max(o.from, o.to), bmax[k]);
    const m = 3;
    if (Math.abs(dot(ax, d)) > 0.99) {
      const c2 = project(view, c3(t0));
      const key = c2.map(x => x.toFixed(2)).join(',');
      if (seen.has(key + 'x')) continue; seen.add(key + 'x');
      const R = Math.max(...model.def.ops.filter(q => q.type === 'cyl' && q.axis === o.axis && Math.hypot(q.c[0] - o.c[0], q.c[1] - o.c[1]) < 1e-6).map(q => q.r));
      out.push({ a: [c2[0] - R - m, c2[1]], b: [c2[0] + R + m, c2[1]] });
      out.push({ a: [c2[0], c2[1] - R - m], b: [c2[0], c2[1] + R + m] });
    } else {
      const a = project(view, c3(t0)), b = project(view, c3(t1));
      const dir = [b[0] - a[0], b[1] - a[1]]; const L = Math.hypot(...dir); const u = [dir[0] / L, dir[1] / L];
      const key = [a, b].map(p => p.map(x => x.toFixed(2)).join(',')).join('|');
      if (seen.has(key)) continue; seen.add(key);
      out.push({ a: [a[0] - u[0] * m, a[1] - u[1] * m], b: [b[0] + u[0] * m, b[1] + u[1] * m], axisOf: o });
    }
  }
  // 合并同一条轴线
  const merged = [];
  for (const l of out) {
    const dup = merged.find(q => Math.hypot(q.a[0] - l.a[0], q.a[1] - l.a[1]) < 1e-6 && Math.hypot(q.b[0] - l.b[0], q.b[1] - l.b[1]) < 1e-6);
    if (!dup) merged.push(l);
  }
  return merged;
}

// ---------- 查询（讲解与练习都用这些结果，避免大模型凭空猜） ----------


// 2D 点 → 该处的线由哪些棱/面投影而来
export function queryLineAt(model, view, uv, tol = 1.2) {
  const vw = model.views[view];
  let best = Infinity;
  for (const p of vw.pieces) best = Math.min(best, distPtSeg(uv, p.a, p.b));
  if (best > tol) return null;
  const near = vw.pieces.filter(p => distPtSeg(uv, p.a, p.b) < best + 0.15);
  const srcs = new Map();
  for (const p of near) {
    if (!srcs.has(p.src)) srcs.set(p.src, { id: p.src, vis: p.vis, any: [] });
    const s = srcs.get(p.src); s.any.push(p); if (p.vis) s.vis = true;
  }
  const visible = [...srcs.values()].some(s => s.vis);
  // 积聚在此处的面
  const faces = vw.edgeOnFaces.filter(fi => {
    const f = model.faces[fi];
    return f.tris.some(t => {
      const P = model.tris[t].map(k => project(view, model.pos[k]));
      return distPtSeg(uv, P[0], P[1]) < best + 0.2 || distPtSeg(uv, P[1], P[2]) < best + 0.2 || distPtSeg(uv, P[0], P[2]) < best + 0.2;
    });
  }).map(fi => model.faces[fi].id);
  const items = [...srcs.values()].map(s => s.id);
  return { view, uv, visible, sources: items, faces, sourceVis: Object.fromEntries([...srcs.values()].map(s => [s.id, s.vis])) };
}

// 某条棱/轮廓线在该视图中被谁挡住
export function occluderOf(model, view, srcId) {
  const vw = model.views[view];
  const hidden = vw.pieces.filter(p => p.src === srcId && !p.vis);
  if (!hidden.length) return null;
  const p = hidden.reduce((a, b) => (len(sub(b.b3, b.a3)) > len(sub(a.b3, a.a3)) ? b : a));
  const mid = lerp(p.a3, p.b3, 0.5);
  // 取视线上离观察者最近的表面，即“从这个方向看过去先看到的面”
  const h = rayHit(model, vw.grid, view, mid, 1e-4, true);
  return h ? model.faces[h.face] : null;
}

export function findCurve(model, id) {
  if (id.startsWith('E')) return model.curves.find(c => c.id === id) || null;
  for (const v of VIEW_KEYS) { const s = model.views[v].sils.find(x => x.id === id); if (s) return { ...s, isSil: true, view: v }; }
  return null;
}
export function findFace(model, id) { return model.faces.find(f => f.id === id) || null; }

// 某个 3D 元素在各视图中的表现
export function appearance(model, id) {
  const res = {};
  for (const v of VIEW_KEYS) {
    const vw = model.views[v];
    if (id.startsWith('F')) {
      const f = findFace(model, id);
      const edgeOn = vw.edgeOnFaces.includes(f.index);
      const d = VIEWS[v].dir;
      const facing = f.planar ? dot(f.normal, d) : null;
      // 是否可见：面中心沿视线是否被挡
      let visible = null;
      if (!edgeOn) {
        let vis = 0, tot = 0;
        for (const t of f.tris.slice(0, 40)) {
          const c = mul(model.tris[t].map(k => model.pos[k]).reduce(add, [0, 0, 0]), 1 / 3);
          if (dot(model.tn[t], d) <= 0) continue; tot++;
          if (!rayHit(model, vw.grid, v, c)) vis++;
        }
        visible = tot ? vis / tot > 0.5 : false;
      }
      res[v] = { edgeOn, facing, visible };
    } else {
      const ps = vw.pieces.filter(p => p.src === id);
      const visLen = ps.filter(p => p.vis).reduce((s, p) => s + Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]), 0);
      const hidLen = ps.filter(p => !p.vis).reduce((s, p) => s + Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]), 0);
      res[v] = { asPoint: ps.length === 0, visLen, hidLen };
    }
  }
  return res;
}

// 给大模型/讲解用的紧凑摘要
export function summarize(model) {
  const f = [...model.faces].sort((a, b) => +a.id.slice(1) - +b.id.slice(1)).map(x => `${x.id} ${x.name}`).join('\n');
  const e = model.curves.map(c => `${c.id} ${c.desc}；${c.between}`).join('\n');
  const [bmin, bmax] = model.bbox;
  return `模型：${model.def.name}（${model.def.desc}）\n总体尺寸：长 ${fmt(bmax[0] - bmin[0])} × 宽 ${fmt(bmax[1] - bmin[1])} × 高 ${fmt(bmax[2] - bmin[2])}\n坐标：X 向右，Y 向后（y=0 为前表面），Z 向上\n面：\n${f}\n棱：\n${e}`;
}
