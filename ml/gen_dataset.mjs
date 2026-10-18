// 视图通 · 训练数据生成器：随机组合体 → 三视图（每条线的坐标与虚实）、识图 JSON、部件清单
// 用法：node ml/gen_dataset.mjs --seed 1 --count 1000 --out ml/data/shapes-1.jsonl
// 每行一个样本：
//   parts   建模的标准答案（形体分析格式，坐标约定与 App 的形体分析提示词一致）
//   ops     建模步骤（App 的建模语言）
//   views   三视图图线（App 内部视图坐标：主视图 (x,z)、俯视图 (x,y)、左视图 (-y,z)），渲染照片、做像素标签用
//   vision  识图 JSON（与识图提示词的格式一致，每个视图以外轮廓左下角为原点），训练端到端识图模型用
//   text    程序量好的图线文本（形体分析提示词里的那一段），训练“图线 → 部件清单”的模型用
import fs from 'node:fs';
import Module from '../node_modules/manifold-3d/manifold.js';
import { buildMesh, analyze } from '../web/js/engine.js';
import { synthVision, fromVision, reconcile } from '../web/js/recon/drawing.js';
import { partsToOps, partsDrawingText, cleanPart } from '../web/js/recon/parts.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SEED = +arg('seed', 1), COUNT = +arg('count', 100), OUT = arg('out', 'ml/data/shapes.jsonl');
const M = await Module(); M.setup();

// ---------- 随机数（可复现） ----------
function rng(seed) {
  let a = seed >>> 0;
  const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.int = (lo, hi, step = 1) => lo + step * Math.floor(r() * (Math.floor((hi - lo) / step) + 1));
  r.pick = arr => arr[Math.floor(r() * arr.length)];
  r.chance = p => r() < p;
  return r;
}
const rect = (u0, v0, u1, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
const part = (name, op, view, extra) => ({ name, op, view, ...extra });

// ---------- 几类典型组合体（坐标都在整数网格上，包围盒从 0 开始） ----------
// 1. 切割类：长方体上开槽、台阶、倒角、V 形槽、燕尾槽、孔
function block(r) {
  const L = r.int(36, 90, 2), W = r.int(20, 56, 2), H = r.int(16, 56, 2);
  const parts = [part('长方体', 'add', 'front', { loop: rect(0, 0, L, H), range: [0, W] })];
  const n = r.int(1, 4);
  for (let i = 0; i < n; i++) {
    const kind = r.pick(['step', 'slotTop', 'slotBottom', 'slotX', 'chamfer', 'chamferLeft', 'vgroove', 'dovetail', 'holeZ', 'holeY', 'counterbore']);
    const x0 = r.int(Math.round(L * 0.2), Math.round(L * 0.6), 2), z0 = r.int(Math.round(H * 0.3), Math.round(H * 0.7), 2);
    if (kind === 'step') { const right = r.chance(0.5); parts.push(part('台阶', 'sub', 'front', { loop: right ? rect(L - Math.round(L * 0.25 + r() * L * 0.3), z0, L, H) : rect(0, z0, Math.round(L * 0.25 + r() * L * 0.3), H), range: r.chance(0.7) ? 'through' : [r.int(Math.round(W * 0.3), Math.round(W * 0.7), 2), W] })); }
    else if (kind === 'slotTop') { const w = r.int(6, Math.max(8, Math.round(L * 0.35)), 2); parts.push(part('上方通槽', 'sub', 'front', { loop: rect(x0, z0, Math.min(L - 4, x0 + w), H), range: 'through' })); }
    else if (kind === 'slotBottom') { const w = r.int(6, Math.max(8, Math.round(L * 0.35)), 2); parts.push(part('底部通槽', 'sub', 'front', { loop: rect(x0, 0, Math.min(L - 4, x0 + w), r.int(3, Math.max(4, Math.round(H * 0.4)))), range: 'through' })); }
    else if (kind === 'slotX') { const y0 = r.int(4, Math.max(5, Math.round(W * 0.5)), 2), w = r.int(6, Math.max(7, Math.round(W * 0.4)), 2); parts.push(part('左右通槽', 'sub', 'left', { loop: rect(y0, z0, Math.min(W - 4, y0 + w), H), range: 'through' })); }
    else if (kind === 'chamfer') { const a = r.int(6, Math.round(L * 0.4), 2), b = r.int(4, Math.round(H * 0.6), 2), right = r.chance(0.5); parts.push(part('切角', 'sub', 'front', { loop: right ? [[L - a, H], [L, H], [L, H - b]] : [[0, H - b], [0, H], [a, H]], range: 'through' })); }
    else if (kind === 'chamferLeft') { const a = r.int(4, Math.round(W * 0.5), 2), b = r.int(4, Math.round(H * 0.6), 2), back = r.chance(0.5); parts.push(part('前后切角', 'sub', 'left', { loop: back ? [[W - a, H], [W, H], [W, H - b]] : [[0, H - b], [0, H], [a, H]], range: 'through' })); }
    else if (kind === 'vgroove') { const c = r.int(Math.round(L * 0.3), Math.round(L * 0.7), 2), w = r.int(4, Math.max(5, Math.round(L * 0.15)), 2), h = r.int(4, Math.round(H * 0.5), 2); parts.push(part('V 形槽', 'sub', 'front', { loop: [[c - w, H], [c + w, H], [c, H - h]], range: 'through' })); }
    else if (kind === 'dovetail') { const c = r.int(Math.round(L * 0.3), Math.round(L * 0.7), 2), w1 = r.int(3, 6), w2 = w1 + r.int(2, 5), h = r.int(4, Math.round(H * 0.45), 2); parts.push(part('燕尾槽', 'sub', 'front', { loop: [[c - w1, H], [c + w1, H], [c + w2, H - h], [c - w2, H - h]], range: 'through' })); }
    else if (kind === 'holeZ') { const rr = r.int(3, Math.max(3, Math.min(8, Math.round(Math.min(L, W) / 6)))); parts.push(part('竖直孔', 'sub', 'top', { circle: [r.int(rr + 4, L - rr - 4), r.int(rr + 4, W - rr - 4), rr], range: 'through' })); }
    else if (kind === 'holeY') { const rr = r.int(3, Math.max(3, Math.min(8, Math.round(Math.min(L, H) / 6)))); parts.push(part('前后孔', 'sub', 'front', { circle: [r.int(rr + 4, L - rr - 4), r.int(rr + 4, H - rr - 4), rr], range: 'through' })); }
    else if (kind === 'counterbore') { const rr = r.int(3, 6), R = rr + r.int(2, 4), cx = r.int(R + 4, L - R - 4), cy = r.int(R + 4, W - R - 4), dd = r.int(2, Math.max(3, Math.round(H * 0.4))); parts.push(part('沉孔', 'sub', 'top', { circle: [cx, cy, R], range: [H - dd, H] }), part('通孔', 'sub', 'top', { circle: [cx, cy, rr], range: 'through' })); }
  }
  return { parts, dims: { x: L, y: W, z: H }, kind: 'block' };
}

// 2. 支架类：底板 + 竖板（方头或圆头）+ 肋板 + 孔
function bracket(r) {
  const L = r.int(40, 90, 2), W = r.int(28, 60, 2), h = r.int(6, 14, 2), H = r.int(h + 20, h + 50, 2), t = r.int(6, 12, 2);
  const parts = [part('底板', 'add', 'top', { loop: rect(0, 0, L, W), range: [0, h] })];
  const round = r.chance(0.6), x0 = r.chance(0.5) ? 0 : r.int(4, Math.round(L * 0.25), 2), x1 = L - x0;
  const R = (x1 - x0) / 2, cx = (x0 + x1) / 2;
  if (round && H - R > h + 2) {
    parts.push(part('圆头竖板', 'add', 'front', { loop: [[x0, h], [x1, h]], circles: [[cx, H - R, R]], range: [W - t, W] }));
    if (r.chance(0.8)) parts.push(part('竖板孔', 'sub', 'front', { circle: [cx, H - R, r.int(3, Math.max(3, Math.round(R * 0.6)))], range: 'through' }));
  } else {
    parts.push(part('竖板', 'add', 'front', { loop: rect(x0, h, x1, H), range: [W - t, W] }));
    if (r.chance(0.5)) parts.push(part('竖板孔', 'sub', 'front', { circle: [cx, Math.round((h + H) / 2), r.int(3, Math.max(3, Math.min(Math.round((x1 - x0) / 5), Math.round((H - h) / 4))))], range: 'through' }));
  }
  if (r.chance(0.6)) { const rw = r.int(4, 10, 2), rl = r.int(8, Math.max(9, W - t - 4), 2), rh = r.int(8, Math.max(9, H - h - 6), 2); parts.push(part('肋板', 'add', 'left', { loop: [[W - t - rl, h], [W - t, h], [W - t, h + rh]], range: [cx - rw / 2, cx + rw / 2] })); }
  if (r.chance(0.7)) { const rr = r.int(3, 5), cy = r.int(rr + 4, Math.max(rr + 4, Math.round((W - t) * 0.6))); parts.push(part('底板孔', 'sub', 'top', { circle: [rr + 5, cy, rr], range: 'through' }), part('底板孔', 'sub', 'top', { circle: [L - rr - 5, cy, rr], range: 'through' })); }
  if (r.chance(0.3)) { const g0 = r.int(Math.round(L * 0.3), Math.round(L * 0.45), 2); parts.push(part('底面通槽', 'sub', 'front', { loop: rect(g0, 0, L - g0, r.int(2, Math.max(2, h - 3))), range: 'through' })); }
  return { parts, dims: { x: L, y: W, z: H }, kind: 'bracket' };
}

// 3. 轴承座类：底板（可带圆角、通槽、孔）+ 与圆筒相切的支撑板 + 圆筒 + 肋板 + 凸台
function seat(r) {
  const L = r.int(60, 100, 2), W = r.int(36, 60, 2), h = r.int(8, 14, 2), t = r.int(8, 12, 2);
  const R = r.int(12, Math.min(26, Math.round(L / 3.2)), 2), rb = r.int(Math.round(R * 0.45), Math.round(R * 0.7)), zc = h + R + r.int(6, 24, 2);
  const y0 = r.int(Math.max(4, W - t - 26), W - t - 4, 2), y1 = W + (r.chance(0.5) ? 0 : r.int(4, 8, 2)), cx = L / 2;
  const parts = [];
  const fillet = r.chance(0.5) ? r.int(6, 12, 2) : 0;
  parts.push(fillet ? part('底板', 'add', 'top', { loop: [[0, W], [L, W]], circles: [[fillet, fillet, fillet], [L - fillet, fillet, fillet]], range: [0, h] }) : part('底板', 'add', 'top', { loop: rect(0, 0, L, W), range: [0, h] }));
  const inset = r.chance(0.6) ? 0 : r.int(4, Math.round(L * 0.15), 2);
  parts.push(part('支撑板', 'add', 'front', { loop: [[inset, h], [L - inset, h]], circles: [[cx, zc, R]], range: [W - t, W] }));
  parts.push(part('圆筒', 'add', 'front', { circle: [cx, zc, R], range: [y0, y1] }));
  let H = zc + R;
  if (r.chance(0.6)) {
    const rw = r.int(6, Math.min(14, R), 2), top = zc - rb - 1, yr = r.int(Math.max(2, y0 - 22), y0 - 4, 2), zt = r.int(Math.min(top, zc - R + 2), top);
    parts.push(part('肋板', 'add', 'left', { loop: [[yr, h], [W - t, h], [W - t, top], [y0, top], [y0, zt]], range: [cx - rw / 2, cx + rw / 2] }));
  }
  parts.push(part('轴孔', 'sub', 'front', { circle: [cx, zc, rb], range: 'through' }));
  if (r.chance(0.5)) {
    const rbo = r.int(4, Math.min(10, Math.round(R * 0.5))), ym = Math.round((y0 + y1) / 2), top = zc + R + r.int(4, 10, 2);
    if (ym - rbo > y0 + 1 && ym + rbo < y1 - 1) {
      parts.splice(parts.length - 1, 0, part('凸台', 'add', 'top', { circle: [cx, ym, rbo], range: [zc, top] }));
      parts.push(part('凸台孔', 'sub', 'top', { circle: [cx, ym, Math.max(2, rbo - r.int(2, 4))], range: [zc, top] }));
      H = top;
    }
  }
  if (r.chance(0.7)) { const rr = r.int(3, 5), c = fillet || rr + 6; parts.push(part('底板孔', 'sub', 'top', { circle: [c, c, rr], range: 'through' }), part('底板孔', 'sub', 'top', { circle: [L - c, c, rr], range: 'through' })); }
  if (r.chance(0.5)) { const g0 = r.int(Math.round(L * 0.3), Math.round(L * 0.42), 2); parts.push(part('底面通槽', 'sub', 'front', { loop: rect(g0, 0, L - g0, r.int(2, Math.max(2, h - 4))), range: 'through' })); }
  return { parts, dims: { x: L, y: Math.max(W, y1), z: H }, kind: 'seat' };
}

// 4. 回转体类：竖直圆柱（可叠一段小圆柱），开槽、切平面、中心孔
function cyl(r) {
  const R = r.int(10, 28), H = r.int(16, 60, 2), D = 2 * R;
  const parts = [part('圆柱', 'add', 'top', { circle: [R, R, R], range: [0, H] })];
  let top = H;
  if (r.chance(0.35)) { const r2 = r.int(Math.round(R * 0.4), R - 3), h2 = r.int(6, 20, 2); parts.push(part('上段圆柱', 'add', 'top', { circle: [R, R, r2], range: [H, H + h2] })); top = H + h2; }
  const n = r.int(1, 3);
  for (let i = 0; i < n; i++) {
    const k = r.pick(['slotX', 'slotY', 'flat', 'hole', 'holeX']);
    const w = r.int(4, Math.max(5, Math.round(R * 0.8)), 2), dep = r.int(4, Math.round(H * 0.5), 2);
    if (k === 'slotX') parts.push(part('左右通槽', 'sub', 'left', { loop: rect(R - w / 2, H - dep, R + w / 2, H), range: 'through' }));
    else if (k === 'slotY') parts.push(part('前后通槽', 'sub', 'front', { loop: rect(R - w / 2, H - dep, R + w / 2, H), range: 'through' }));
    else if (k === 'flat') { const c = r.int(Math.round(R * 0.4), R - 2); parts.push(part('切平面', 'sub', 'front', { loop: rect(D - (R - c), H - dep, D, H), range: 'through' })); }
    else if (k === 'hole') parts.push(part('中心孔', 'sub', 'top', { circle: [R, R, r.int(2, Math.max(2, Math.round(R * 0.4)))], range: 'through' }));
    else if (k === 'holeX') parts.push(part('横孔', 'sub', 'left', { circle: [R, r.int(4, Math.max(5, H - 6)), r.int(2, Math.max(2, Math.round(R * 0.25)))], range: 'through' }));
  }
  return { parts, dims: { x: D, y: D, z: top }, kind: 'cyl' };
}

// ---------- 质量检查：实体连成一块、包围盒和设计的一致、同方向的线不能挨得太近（照片上分不清） ----------
function oneBody(raw) {
  const parent = raw.pos.map((_, i) => i), find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const t of raw.tris) { const a = find(t[0]); for (const v of [t[1], t[2]]) { const b = find(v); if (a !== b) parent[b] = a; } }
  return new Set(raw.tris.map(t => find(t[0]))).size === 1;
}
function spacingOK(model, minGap) {
  for (const v of ['front', 'top', 'left']) {
    const xs = [], ys = [];
    for (const l of model.views[v].lines) {
      const dx = Math.abs(l.b[0] - l.a[0]), dy = Math.abs(l.b[1] - l.a[1]), L = Math.hypot(dx, dy);
      if (L < 0.5) continue;
      if (dx < 1e-6) xs.push(l.a[0]); else if (dy < 1e-6) ys.push(l.a[1]);
    }
    for (const arr of [xs, ys]) {
      const u = [...new Set(arr.map(x => Math.round(x * 100) / 100))].sort((a, b) => a - b);
      for (let i = 1; i < u.length; i++) if (u[i] - u[i - 1] > 0.05 && u[i] - u[i - 1] < minGap) return false;
    }
  }
  return true;
}

const r2 = x => Math.round(x * 100) / 100;
// 各类的抽样权重（轴承座类被“线太近”刷掉得多，权重给高些，最后各类数量大致均衡）
const ALL_KINDS = [['block', block, 0.22], ['bracket', bracket, 0.24], ['seat', seat, 0.34], ['cyl', cyl, 0.2]];
// --kinds seat,cyl 只生成这几类（用来留出一整类形体当测试集，检验没见过的类型）
const only = arg('kinds', '') ? arg('kinds', '').split(',') : null;
const picked = ALL_KINDS.filter(([k]) => !only || only.includes(k));
if (!picked.length) throw new Error('--kinds 只能是 block、bracket、seat、cyl');
const wsum = picked.reduce((t, q) => t + q[2], 0);
const KINDS = picked.map(([, g, w]) => [g, w / wsum]);
fs.mkdirSync(OUT.replace(/[^/\\]+$/, '') || '.', { recursive: true });
const out = fs.createWriteStream(OUT);
let made = 0, tried = 0;
const why = {}; const rej = (k, reason) => { why[k + ':' + reason] = (why[k + ':' + reason] || 0) + 1; };
const t0 = Date.now();
for (let s = SEED * 1000003; made < COUNT && tried < COUNT * 20; s++) {
  tried++;
  const r = rng(s);
  let x = r(), gen = KINDS[0][0];
  for (const [g, w] of KINDS) { if (x < w) { gen = g; break; } x -= w; }
  const { parts, dims, kind } = gen(r);
  const ops = partsToOps(parts, { dims });
  const def = { id: `${kind}-${s}`, name: kind, desc: '', points: [], level: '训练', ops };
  let raw, model;
  try { raw = buildMesh(M, def); if (!oneBody(raw)) { rej(kind, '不连通'); continue; } model = analyze(def, raw); } catch { rej(kind, '建模失败'); continue; }
  const [bmin, bmax] = model.bbox;
  if (bmin.some(v => Math.abs(v) > 0.01) || Math.abs(bmax[0] - dims.x) > 0.01 || Math.abs(bmax[1] - dims.y) > 0.01 || Math.abs(bmax[2] - dims.z) > 0.01) { rej(kind, '包围盒'); continue; }
  const size = Math.max(dims.x, dims.y, dims.z);
  if (!spacingOK(model, Math.max(1.5, size * 0.02))) { rej(kind, '线太近'); continue; }
  if (['front', 'top', 'left'].some(v => model.views[v].lines.length < 4)) continue;
  const vision = synthVision(model, {});
  let text = '';
  try { text = partsDrawingText(reconcile(fromVision(JSON.parse(JSON.stringify(vision))))); } catch { continue; }
  const views = {};
  for (const v of ['front', 'top', 'left']) views[v] = {
    lines: model.views[v].lines.map(l => [r2(l.a[0]), r2(l.a[1]), r2(l.b[0]), r2(l.b[1]), l.vis ? 1 : 0]),
    center: model.views[v].center.map(c => [r2(c.a[0]), r2(c.a[1]), r2(c.b[0]), r2(c.b[1])]),
  };
  out.write(JSON.stringify({ id: def.id, kind, dims, bbox: model.bbox.map(p => p.map(r2)), parts: parts.map(p => cleanPart({ ...p })), ops, views, vision, text }) + '\n');
  made++;
  if (made % 100 === 0) process.stderr.write(`  ${made}/${COUNT}（试了 ${tried} 个，${((Date.now() - t0) / 1000).toFixed(0)} 秒）\n`);
}
out.end();
if (process.env.WHY) process.stderr.write(JSON.stringify(why) + '\n');
process.stderr.write(`完成：${made} 个样本写入 ${OUT}（试了 ${tried} 个，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒）\n`);
