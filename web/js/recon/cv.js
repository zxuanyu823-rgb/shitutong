// 视图通 · 拍照重建 ①′：算法量线
import { VIEW_KEYS } from '../util.js';
// 视觉模型负责“认”（哪些线、属于哪个视图、大概在哪），本模块负责“量”：
// 在照片的墨迹里沿每条线附近搜索，用像素拟合出精确位置、端点和虚实，再统一比例。
// 这样形体尺寸来自像素，不依赖模型目测的坐标。


// ---------- 读图与二值化 ----------
export async function loadInk(dataURL, maxSide = 1800) {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('照片读不出来')); i.src = dataURL; });
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  return binarize(g.getImageData(0, 0, w, h));
}

// 局部自适应阈值：比周围平均亮度暗一定比例就算墨迹（适应光照不均）
export function binarize({ data, width: w, height: h }) {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += gray[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; } }
  const r = Math.max(8, Math.round(Math.max(w, h) / 45));
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const mean = (S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      const v = gray[y * w + x];
      if (v < mean * 0.82 && v < 210) ink[y * w + x] = 1;
    }
  }
  return { w, h, ink };
}

// ---------- 基本量测 ----------
const inkAt = (I, x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < I.w && y < I.h && I.ink[y * I.w + x] === 1; };
const inkNear = (I, x, y, nx, ny, r = 1) => { for (let o = -r; o <= r; o++) if (inkAt(I, x + nx * o, y + ny * o)) return true; return false; };

// 沿线段采样，返回覆盖率和逐点墨迹
function profile(I, p, q, r = 1) {
  const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy);
  if (L < 2) return { cov: 0, hits: [] };
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const n = Math.max(2, Math.round(L)), hits = new Uint8Array(n + 1);
  let c = 0;
  for (let i = 0; i <= n; i++) { const t = i / n; if (inkNear(I, p[0] + dx * t, p[1] + dy * t, nx, ny, r)) { hits[i] = 1; c++; } }
  return { cov: c / (n + 1), hits };
}

function rotateAbout(p, c, a) { const s = Math.sin(a), co = Math.cos(a), x = p[0] - c[0], y = p[1] - c[1]; return [c[0] + x * co - y * s, c[1] + x * s + y * co]; }

// 在预测位置附近平移、微转找墨迹。不是简单取覆盖率最高：先找出所有像样的峰，
// 再取离预测最近的那条，避免虚线被旁边更“黑”的实线吸走
function searchLine(I, p, q, band, { angles = [0], trim = 0.1, reject = null } = {}) {
  const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const ux = (q[0] - p[0]) / L, uy = (q[1] - p[1]) / L, nx = -uy, ny = ux;
  const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const row = [];
  for (let o = -band; o <= band; o++) {
    let b = null;
    for (const a of angles) {
      const P = rotateAbout(p, mid, a), Q = rotateAbout(q, mid, a);
      const a0 = [P[0] + nx * o + (Q[0] - P[0]) * trim, P[1] + ny * o + (Q[1] - P[1]) * trim];
      const a1 = [Q[0] + nx * o - (Q[0] - P[0]) * trim, Q[1] + ny * o - (Q[1] - P[1]) * trim];
      const { cov } = profile(I, a0, a1);
      if (!b || cov > b.cov + 1e-9 || (Math.abs(cov - b.cov) < 1e-9 && Math.abs(a) < Math.abs(b.a))) b = { o, a, cov, P: [P[0] + nx * o, P[1] + ny * o], Q: [Q[0] + nx * o, Q[1] + ny * o] };
    }
    row.push(b);
  }
  const top = Math.max(...row.map(r => r.cov));
  const floor = Math.max(0.35, 0.6 * top);
  let best = null;
  row.forEach((r, i) => {
    if (r.cov < floor || (i > 0 && row[i - 1].cov > r.cov) || (i < row.length - 1 && row[i + 1].cov > r.cov)) return;
    if (reject && reject(r.P, r.Q)) return;
    if (!best || Math.abs(r.o) < Math.abs(best.o)) best = r;
  });
  if (best || reject) return best;
  return row.reduce((a, b) => (b.cov > a.cov ? b : a));
}

// 候选线是否和已量好的某条线重合（平行、贴得很近、大部分重叠）
function coincides(P, Q, lines, tol = 4) {
  const d = [Q[0] - P[0], Q[1] - P[1]], L = Math.hypot(...d), u = [d[0] / L, d[1] / L];
  return lines.some(l => {
    const e = [l.q[0] - l.p[0], l.q[1] - l.p[1]], M = Math.hypot(...e);
    if (Math.abs(u[0] * e[1] - u[1] * e[0]) / M > 0.05) return false;
    const m = [(l.p[0] + l.q[0]) / 2, (l.p[1] + l.q[1]) / 2];
    if (Math.abs((m[0] - P[0]) * u[1] - (m[1] - P[1]) * u[0]) > tol) return false;
    const pr = pt => (pt[0] - P[0]) * u[0] + (pt[1] - P[1]) * u[1];
    const a = Math.min(pr(l.p), pr(l.q)), b = Math.max(pr(l.p), pr(l.q));
    return Math.min(L, b) - Math.max(0, a) > 0.5 * Math.min(L, M);
  });
}

// 用附近墨迹像素做主成分拟合，得到精确直线
function fitLine(I, p, q, r = 2) {
  const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const pts = [];
  for (let i = 0; i <= L; i++) for (let o = -r; o <= r; o++) {
    const x = Math.round(p[0] + ux * i + nx * o), y = Math.round(p[1] + uy * i + ny * o);
    if (inkAt(I, x, y)) pts.push([x, y]);
  }
  if (pts.length < 6) return null;
  return fitPts(pts, ux, uy, p, q);
}
function fitPts(pts, ux, uy, p, q) {
  let mx = 0, my = 0; for (const [x, y] of pts) { mx += x; my += y; } mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ex = Math.cos(ang), ey = Math.sin(ang); if (ex * ux + ey * uy < 0) { ex = -ex; ey = -ey; }
  const proj = pt => (pt[0] - mx) * ex + (pt[1] - my) * ey;
  return { c: [mx, my], e: [ex, ey], t0: proj(p), t1: proj(q) };
}

// 沿线逐段找墨迹中心再做稳健拟合：初始位置偏了几个像素也能拉回来（斜线主要靠它）
function refitAlong(I, p, q, w, maxRun = Math.max(8, w * 0.75)) {
  const L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L < 8) return null;
  const ux = (q[0] - p[0]) / L, uy = (q[1] - p[1]) / L, nx = -uy, ny = ux;
  const pts = [], runs = [];
  for (let t = L * 0.1; t <= L * 0.9; t += 2) {
    const mx = p[0] + ux * t, my = p[1] + uy * t;
    let best = null, run = null;
    for (let o = -w; o <= w + 1; o++) {
      const on = o <= w && inkAt(I, mx + nx * o, my + ny * o);
      if (on) { if (!run) run = [o, o]; else run[1] = o; }
      else if (run) { const c = (run[0] + run[1]) / 2; if (run[1] - run[0] + 1 <= maxRun && (best === null || Math.abs(c) < Math.abs(best[0]))) best = [c, run[1] - run[0] + 1]; run = null; }
    }
    if (best !== null) { pts.push([mx + nx * best[0], my + ny * best[0]]); runs.push(best[1]); }
  }
  if (pts.length < 6) return null;
  let use = pts, f = null;
  for (let it = 0; it < 3; it++) {
    f = fitPts(use, ux, uy, p, q);
    const res = pts.map(pt => Math.abs((pt[0] - f.c[0]) * -f.e[1] + (pt[1] - f.c[1]) * f.e[0]));
    const med = [...res].sort((a, b) => a - b)[res.length >> 1];
    const keep = pts.filter((_, i) => res[i] <= Math.max(1.5, 2.5 * med));
    if (keep.length < 6 || keep.length === use.length) break;
    use = keep;
  }
  if (use.length < pts.length * 0.4) return null;
  f.T = [...runs].sort((a, b) => a - b)[runs.length >> 1];
  return f;
}

// 从线中段向两端走，墨迹断开超过 gap 就停；延伸不超过 maxExt
function extent(I, f, gap, maxExt, minRun = 0, maxRun = 0) {
  const at = t => [f.c[0] + f.e[0] * t, f.c[1] + f.e[1] * t];
  const n = [-f.e[1], f.e[0]];
  // 横穿该点的墨迹宽度：粗实线走到细虚线上会明显变细
  const R = Math.ceil(Math.max(minRun * 2, maxRun));
  const width = (x, y) => { let k = 0; for (let o = -R; o <= R; o++) if (inkAt(I, x + n[0] * o, y + n[1] * o)) k++; return k; };
  const walk = (t, dir, limit) => {
    let last = t, miss = 0;
    for (let s = t; dir > 0 ? s <= limit : s >= limit; s += dir) {
      const [x, y] = at(s);
      if (inkNear(I, x, y, n[0], n[1], 1) && (!minRun || width(x, y) >= minRun) && (!maxRun || width(x, y) <= maxRun)) { last = s; miss = 0; } else if (++miss > gap) break;
    }
    return last;
  };
  const mid = (f.t0 + f.t1) / 2;
  return [walk(mid, -1, Math.min(f.t0, f.t1) - maxExt), walk(mid, 1, Math.max(f.t0, f.t1) + maxExt)];
}

// 虚实判断：覆盖率高、几乎不断开为实线；有规律的多次断开为虚线
function lineKind(I, p, q) {
  const { cov, hits } = profile(I, p, q);
  let gaps = 0, run = 0;
  const s = Math.floor(hits.length * 0.06), e = Math.ceil(hits.length * 0.94);
  for (let i = s; i < e; i++) { if (!hits[i]) run++; else { if (run >= 2) gaps++; run = 0; } }
  if (cov > 0.93 && gaps <= 1) return { kind: 'solid', cov };
  if (cov < 0.88 && gaps >= 3) return { kind: 'dashed', cov };
  return { kind: null, cov };
}

function fitCircle(pts) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0; const n = pts.length;
  for (const [x, y] of pts) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z; }
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], B = [sxz, syz, sz];
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A); if (Math.abs(D) < 1e-9) return null;
  const col = k => A.map((r, i) => r.map((v, j) => (j === k ? B[i] : v)));
  const a = det(col(0)) / D, b = det(col(1)) / D, c = det(col(2)) / D;
  const cx = a / 2, cy = b / 2, r = Math.sqrt(c + cx * cx + cy * cy);
  return Number.isFinite(r) ? { c: [cx, cy], r } : null;
}

// 沿径向在预测半径附近找墨迹段（取段中心；顺着射线方向的中心线会形成很长的墨迹段，直接跳过），
// 再做去掉离群点的圆拟合
function refineCircle(I, c, r, band, from = 0, to = 360, maxRun = 14) {
  band = Math.max(3, Math.min(band, r * 0.4));
  const pts = [];
  let a1 = to; while (a1 <= from) a1 += 360;
  for (let a = from; a <= a1; a += 3) {
    const t = a * Math.PI / 180, ux = Math.cos(t), uy = -Math.sin(t);
    let best = null, run = null;
    for (let d = -band; d <= band + 1; d++) {
      const on = d <= band && inkAt(I, c[0] + ux * (r + d), c[1] + uy * (r + d));
      if (on) { if (!run) run = [d, d]; else run[1] = d; }
      else if (run) { const m = (run[0] + run[1]) / 2; if (run[1] - run[0] + 1 <= maxRun && run[0] > -band && (best === null || Math.abs(m) < Math.abs(best))) best = m; run = null; }
    }
    if (best !== null) pts.push([c[0] + ux * (r + best), c[1] + uy * (r + best)]);
  }
  const need = Math.max(8, (a1 - from) / 3 * 0.4);
  if (pts.length < need) return null;
  let use = pts, f = null;
  for (let it = 0; it < 3; it++) {
    f = fitCircle(use); if (!f) return null;
    const res = pts.map(p => Math.abs(Math.hypot(p[0] - f.c[0], p[1] - f.c[1]) - f.r));
    const med = [...res].sort((x, y) => x - y)[res.length >> 1];
    const keep = pts.filter((_, i) => res[i] <= Math.max(1.5, 2.5 * med));
    if (keep.length < need || keep.length === use.length) break;
    use = keep;
  }
  if (Math.abs(f.r - r) > band * 1.5 || Math.hypot(f.c[0] - c[0], f.c[1] - c[1]) > band * 1.5) return null;
  return { ...f, cov: use.length / ((a1 - from) / 3 + 1) };
}

// 圆心粗搜：在预测圆心附近按网格试圆心和半径，取圆周上墨迹最多的那个（预测圆心偏得多时径向搜索会跑偏）
function coarseCircle(I, c, r, band, from = 0, to = 360) {
  band = Math.max(3, Math.min(band, r * 0.4));
  let a1 = to; while (a1 <= from) a1 += 360;
  const angs = []; for (let a = from; a <= a1; a += 5) { const t = a * Math.PI / 180; angs.push([Math.cos(t), -Math.sin(t)]); }
  const step = Math.max(2, Math.round(band / 7));
  let best = null;
  for (let dx = -band; dx <= band; dx += step) for (let dy = -band; dy <= band; dy += step) {
    const cx = c[0] + dx, cy = c[1] + dy;
    for (let dr = -band * 0.6; dr <= band * 0.6; dr += step) {
      const R = r + dr; if (R < 3) continue;
      let k = 0; for (const [ux, uy] of angs) if (inkNear(I, cx + ux * R, cy + uy * R, ux, uy, 1)) k++;
      const sc = k / angs.length - 0.05 * Math.hypot(dx, dy, dr) / band;
      if (!best || sc > best.sc) best = { sc, c: [cx, cy], r: R };
    }
  }
  return best;
}

// 线端点落在圆或圆弧上：取直线与圆的交点；近乎相切时取切点
function snapToCircles(lines, rings, tol) {
  for (const l of lines) {
    if (!l.ok || l.t === 'center') continue;
    const d = [l.q[0] - l.p[0], l.q[1] - l.p[1]], L = Math.hypot(...d), u = [d[0] / L, d[1] / L];
    for (const end of ['p', 'q']) {
      const E = l[end];
      let best = null;
      for (const g of rings) {
        if (Math.abs(Math.hypot(E[0] - g.pc[0], E[1] - g.pc[1]) - g.pr) > tol) continue;
        // 直线上离圆心最近的点 F，圆心到直线距离 h
        const w = [g.pc[0] - E[0], g.pc[1] - E[1]], tF = w[0] * u[0] + w[1] * u[1];
        const F = [E[0] + u[0] * tF, E[1] + u[1] * tF], h = Math.hypot(g.pc[0] - F[0], g.pc[1] - F[1]);
        let X;
        if (h >= g.pr - tol * 0.5) X = F; // 相切
        else { const k = Math.sqrt(g.pr * g.pr - h * h); const X1 = [F[0] - u[0] * k, F[1] - u[1] * k], X2 = [F[0] + u[0] * k, F[1] + u[1] * k]; X = Math.hypot(X1[0] - E[0], X1[1] - E[1]) < Math.hypot(X2[0] - E[0], X2[1] - E[1]) ? X1 : X2; }
        if (g.from != null) {
          let ang = Math.atan2(-(X[1] - g.pc[1]), X[0] - g.pc[0]) * 180 / Math.PI; ang = (ang + 360) % 360;
          let a0 = g.from % 360, span = ((g.to - g.from) % 360 + 360) % 360 || 360, rel = ((ang - a0) % 360 + 360) % 360;
          if (rel > span + 8 && rel < 352) continue;
        }
        const dist = Math.hypot(X[0] - E[0], X[1] - E[1]);
        if (dist < tol * 1.5 && (!best || dist < best.dist)) best = { dist, X };
      }
      if (best) { const other = end === 'p' ? l.q : l.p; if (Math.hypot(best.X[0] - other[0], best.X[1] - other[1]) >= 3) l[end] = best.X; }
    }
  }
}

// 同心的圆、圆弧（沉孔、带孔的圆头）圆心统一
function unifyCenters(rings, tol) {
  for (let i = 0; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++) {
    const A = rings[i], B = rings[j];
    if (Math.hypot(A.pc[0] - B.pc[0], A.pc[1] - B.pc[1]) > Math.max(tol, 0.12 * Math.min(A.pr, B.pr))) continue;
    const wa = A.pr, wb = B.pr, c = [(A.pc[0] * wa + B.pc[0] * wb) / (wa + wb), (A.pc[1] * wa + B.pc[1] * wb) / (wa + wb)];
    A.pc = c; B.pc = [...c];
  }
}

// 在一团墨迹点里找直线（RANSAC）：可能是一条，也可能是相连的几条（比如顶边 + 倒角）
function ransacLines(pts, tol, minPts, minLen, maxLines = 4) {
  const out = [];
  let rest = pts;
  let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < maxLines && rest.length >= minPts; k++) {
    let best = null;
    for (let it = 0; it < 80; it++) {
      const a = rest[Math.floor(rnd() * rest.length)], b = rest[Math.floor(rnd() * rest.length)];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); if (L < minLen * 0.3) continue;
      const nx = -dy / L, ny = dx / L;
      let n = 0; for (const p of rest) if (Math.abs((p[0] - a[0]) * nx + (p[1] - a[1]) * ny) < tol) n++;
      if (!best || n > best.n) best = { n, a, nx, ny };
    }
    if (!best || best.n < minPts) break;
    const inl = rest.filter(p => Math.abs((p[0] - best.a[0]) * best.nx + (p[1] - best.a[1]) * best.ny) < tol);
    // 主成分拟合 + 端点（取 2%～98% 分位，去掉零星点）
    let mx = 0, my = 0; for (const [x, y] of inl) { mx += x; my += y; } mx /= inl.length; my /= inl.length;
    let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of inl) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ex = Math.cos(ang), ey = Math.sin(ang);
    const ts = inl.map(([x, y]) => (x - mx) * ex + (y - my) * ey).sort((a, b) => a - b);
    const t0 = ts[Math.floor(ts.length * 0.02)], t1 = ts[Math.floor(ts.length * 0.98)];
    // 墨迹要连续：沿线的空档不能太大（防止把两条平行线或零散字迹连成一条）
    let gapMax = 0; for (let i = 1; i < ts.length; i++) gapMax = Math.max(gapMax, ts[i] - ts[i - 1]);
    if (t1 - t0 >= minLen && gapMax < Math.max(6, tol * 3)) out.push({ p: [mx + ex * t0, my + ey * t0], q: [mx + ex * t1, my + ey * t1], n: inl.length });
    const inSet = new Set(inl);
    rest = rest.filter(p => !inSet.has(p));
  }
  return out;
}

// ---------- 主流程 ----------
function extents(v) {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  const take = (u, w) => { u0 = Math.min(u0, u); v0 = Math.min(v0, w); u1 = Math.max(u1, u); v1 = Math.max(v1, w); };
  for (const l of v.lines || []) if (l.t !== 'center') { take(...l.a); take(...l.b); }
  for (const c of v.circles || []) { take(c.c[0] - c.r, c.c[1] - c.r); take(c.c[0] + c.r, c.c[1] + c.r); }
  for (const a of v.arcs || []) { take(a.c[0] - a.r, a.c[1] - a.r); take(a.c[0] + a.r, a.c[1] + a.r); }
  return u0 === Infinity ? null : [u0, v0, u1, v1];
}

// 模型给的视图框可能是 0~1 比例、像素坐标（相对发给它的那张图）或 0~1000 比例，统一成 0~1
export function normalizeBoxes(json, w, h) {
  for (const k of VIEW_KEYS) {
    const v = json.views?.[k], b = v?.box;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) { if (v) delete v.box; continue; }
    const m = Math.max(...b);
    if (m <= 1.5) continue;
    const per1000 = m <= 1000 && (b[0] > w * 1.02 || b[2] > w * 1.02 || b[1] > h * 1.02 || b[3] > h * 1.02);
    v.box = per1000 ? b.map(x => x / 1000) : [b[0] / w, b[1] / h, b[2] / w, b[3] / h];
  }
  return json;
}

// 视图在照片中的位置：优先用模型给的 box（0~1 比例），否则按第一角画法的大致位置
function initialBox(I, view, key) {
  const b = view.box;
  if (Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) {
    const s = b.some(x => x > 1.5) ? [1, 1] : [I.w, I.h];
    const r = [Math.min(b[0], b[2]) * s[0], Math.min(b[1], b[3]) * s[1], Math.max(b[0], b[2]) * s[0], Math.max(b[1], b[3]) * s[1]];
    if (r[2] - r[0] > 8 && r[3] - r[1] > 8) return r;
  }
  const W = I.w, H = I.h;
  return { front: [0.05 * W, 0.05 * H, 0.55 * W, 0.48 * H], top: [0.05 * W, 0.52 * H, 0.55 * W, 0.95 * H], left: [0.58 * W, 0.05 * H, 0.95 * W, 0.48 * H] }[key];
}

// 粗实线掩膜：横、竖两个方向的墨迹宽度都够粗的像素才保留。
// 细的尺寸线、引出线、虚线、中心线和多数文字笔画会被去掉，外轮廓（粗实线）完整保留。
export function thickInk(I) {
  if (I._thick) return I._thick;
  const { w, h, ink } = I, hr = new Uint16Array(w * h), vr = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) { const o = y * w; let x = 0; while (x < w) { if (!ink[o + x]) { x++; continue; } let e = x; while (e < w && ink[o + e]) e++; const L = Math.min(65535, e - x); for (let k = x; k < e; k++) hr[o + k] = L; x = e; } }
  for (let x = 0; x < w; x++) { let y = 0; while (y < h) { if (!ink[y * w + x]) { y++; continue; } let e = y; while (e < h && ink[e * w + x]) e++; const L = Math.min(65535, e - y); for (let k = y; k < e; k++) vr[k * w + x] = L; y = e; } }
  // 粗线线宽：按像素数取 85% 分位（粗线像素多，落在粗线那一档）
  const hist = new Uint32Array(65); let n = 0;
  for (let i = 0; i < w * h; i++) if (ink[i]) { hist[Math.min(64, hr[i], vr[i])]++; n++; }
  let acc = 0, T = 1; for (let t = 1; t <= 64; t++) { acc += hist[t]; if (acc >= 0.85 * n) { T = t; break; } }
  const k = Math.max(2, Math.round(T * 0.6)), m = new Uint8Array(w * h); let kept = 0;
  for (let i = 0; i < w * h; i++) if (ink[i] && hr[i] >= k && vr[i] >= k) { m[i] = 1; kept++; }
  return (I._thick = { w, h, ink: m, T, k, frac: n ? kept / n : 0 });
}

// 墨迹团块：把照片缩成粗网格、略微膨胀，让同一个视图的线连成一团，视图之间的空白把它们分开
function inkBlobs(I) {
  if (I._blobs) return I._blobs;
  const c = Math.max(4, Math.round(Math.max(I.w, I.h) / 260)), gw = Math.ceil(I.w / c), gh = Math.ceil(I.h / c);
  const g = new Uint8Array(gw * gh);
  for (let y = 0; y < I.h; y++) for (let x = 0; x < I.w; x++) if (I.ink[y * I.w + x]) g[((y / c) | 0) * gw + ((x / c) | 0)]++;
  // 一格里只有一两个墨点多半是噪点
  const on = new Uint8Array(gw * gh); for (let i = 0; i < g.length; i++) on[i] = g[i] >= Math.max(2, c * 0.4) ? 1 : 0;
  const R = 3, d = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (on[y * gw + x]) for (let j = Math.max(0, y - R); j <= Math.min(gh - 1, y + R); j++) for (let i = Math.max(0, x - R); i <= Math.min(gw - 1, x + R); i++) d[j * gw + i] = 1;
  const lab = new Int32Array(gw * gh).fill(-1), blobs = [], st = [];
  for (let s0 = 0; s0 < d.length; s0++) {
    if (!d[s0] || lab[s0] >= 0) continue;
    const b = { id: blobs.length, n: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, cells: [] };
    lab[s0] = b.id; st.push(s0);
    while (st.length) {
      const k = st.pop(), x = k % gw, y = (k / gw) | 0;
      if (on[k]) { b.n++; b.cells.push(k); b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y); }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue; const kk = Y * gw + X; if (d[kk] && lab[kk] < 0) { lab[kk] = b.id; st.push(kk); } }
    }
    if (b.n) blobs.push(b);
  }
  return (I._blobs = { c, gw, blobs });
}

// 用墨迹团块把模型给的大致位置校准成视图的真实范围
function blobBox(I, box) {
  const { c, gw, blobs } = inkBlobs(I);
  const ex = 0.15 * Math.max(box[2] - box[0], box[3] - box[1]);
  const B = [box[0] - ex, box[1] - ex, box[2] + ex, box[3] + ex].map(v => v / c);
  const inside = b => { let k = 0; for (const cell of b.cells) { const x = cell % gw, y = (cell / gw) | 0; if (x >= B[0] && x <= B[2] && y >= B[1] && y <= B[3]) k++; } return k; };
  const cand = blobs.map(b => ({ b, k: inside(b) })).filter(o => o.k >= 0.5 * o.b.n);
  if (!cand.length) return null;
  const big = Math.max(...cand.map(o => o.b.n));
  const sel = cand.filter(o => o.b.n >= 0.08 * big).map(o => o.b);
  const r = [Math.min(...sel.map(b => b.x0)) * c, Math.min(...sel.map(b => b.y0)) * c, (Math.max(...sel.map(b => b.x1)) + 1) * c, (Math.max(...sel.map(b => b.y1)) + 1) * c];
  // 与模型给的范围差得离谱就不采用
  const w0 = box[2] - box[0], h0 = box[3] - box[1], w = r[2] - r[0], h = r[3] - r[1];
  if (w < 0.3 * w0 || w > 3.5 * w0 || h < 0.3 * h0 || h > 3.5 * h0) return null;
  return r;
}

// 视图外轮廓的像素范围：外轮廓是一圈连通的粗实线，取框内最大的粗墨迹连通块的范围。
// 视图名称、尺寸数字、箭头和外轮廓不相连，细的尺寸线、虚线、中心线已经被粗线掩膜去掉
function outlineBox(I, b) {
  const x0 = Math.max(0, Math.floor(b[0])), y0 = Math.max(0, Math.floor(b[1])), x1 = Math.min(I.w - 1, Math.ceil(b[2])), y1 = Math.min(I.h - 1, Math.ceil(b[3]));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  const c = 3, gw = Math.ceil((x1 - x0 + 1) / c), gh = Math.ceil((y1 - y0 + 1) / c), on = new Uint8Array(gw * gh);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (I.ink[y * I.w + x]) on[((y - y0) / c | 0) * gw + ((x - x0) / c | 0)] = 1;
  const lab = new Int32Array(gw * gh).fill(-1), st = [];
  let best = null, total = 0;
  for (let s0 = 0; s0 < on.length; s0++) {
    if (!on[s0] || lab[s0] >= 0) continue;
    const blob = { n: 0, a: Infinity, b: Infinity, c: -Infinity, d: -Infinity };
    lab[s0] = s0; st.push(s0);
    while (st.length) {
      const k = st.pop(), x = k % gw, y = (k / gw) | 0;
      blob.n++; blob.a = Math.min(blob.a, x); blob.b = Math.min(blob.b, y); blob.c = Math.max(blob.c, x); blob.d = Math.max(blob.d, y);
      // 8 邻域，并允许跨过 1 格的小缺口（二值化造成的断点）
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
        const kk = Y * gw + X; if (on[kk] && lab[kk] < 0) { lab[kk] = s0; st.push(kk); }
      }
    }
    total += blob.n;
    if (!best || blob.n > best.n) best = blob;
  }
  if (!best || best.n < 0.3 * total) return null;
  return [x0 + best.a * c, y0 + best.b * c, x0 + (best.c + 1) * c, y0 + (best.d + 1) * c];
}

const isV = l => l.a[0] === l.b[0], isH = l => l.a[1] === l.b[1];
const len = l => Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]);

// 模型读数里接近水平/竖直的线先拉正：工程图绝大多数线横平竖直，目测出来的歪斜多半是误差
function straighten(view, size) {
  for (const l of view.lines || []) {
    const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], L = Math.hypot(dx, dy); if (!L) continue;
    const a = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI) % 180, dev = Math.min(a, 180 - a), devV = Math.abs(a - 90);
    const orig = [l.a, l.b], lim = l.t === 'center' ? 25 : 12;
    if (dev < lim || (dev < 30 && Math.abs(dy) < 0.03 * size)) { l._orig = orig; const m = (l.a[1] + l.b[1]) / 2; l.a = [l.a[0], m]; l.b = [l.b[0], m]; }
    else if (devV < lim || (devV < 30 && Math.abs(dx) < 0.03 * size)) { l._orig = orig; const m = (l.a[0] + l.b[0]) / 2; l.a = [m, l.a[1]]; l.b = [m, l.b[1]]; }
    // 偏得更多的短线：既可能是真斜线，也可能是读歪了，量线时两种都试
    // 短线（尤其短虚线）目测角度误差很大，放宽到 40°
    else if (dev < (L < 0.3 * size ? 40 : 25) || devV < (L < 0.3 * size ? 40 : 25)) {
      const my = (l.a[1] + l.b[1]) / 2, mx = (l.a[0] + l.b[0]) / 2;
      const h = [[l.a[0], my], [l.b[0], my]], v = [[mx, l.a[1]], [mx, l.b[1]]];
      l._alt = dev <= devV ? h : v;
      // 很短又接近 45° 的线，横竖两种都试
      if (L < 0.12 * size && Math.abs(dev - devV) < 30) l._alt2 = dev <= devV ? v : h;
    }
  }
}

// 断续图线的类型：中间夹着短点的是点画线（中心线），墨迹段长短均匀的是虚线
function dashKind(I, p, q) {
  const { hits } = profile(I, p, q);
  const runs = []; let run = 0;
  for (let i = 0; i < hits.length; i++) { if (hits[i]) run++; else if (run) { runs.push(run); run = 0; } }
  if (run) runs.push(run);
  if (runs.length < 3) return null;
  const inner = runs.slice(1, -1), longest = Math.max(...runs), shortest = Math.min(...inner);
  if (shortest < 0.4 * longest && longest >= 3 * shortest) return 'dashdot';
  return 'dashed';
}
const looksDashDot = (I, p, q) => dashKind(I, p, q) === 'dashdot';

// 虚线的间隔：沿拟合线统计最长的空白段，走线时允许跨过它
function dashGap(I, p, q) {
  const { hits } = profile(I, p, q);
  let run = 0, mx = 0;
  const s = Math.floor(hits.length * 0.1), e = Math.ceil(hits.length * 0.9);
  for (let i = s; i < e; i++) { if (!hits[i]) { run++; mx = Math.max(mx, run); } else run = 0; }
  return mx;
}

// 外轮廓的四条边：最靠外的竖线、横线（不必很长，但要靠近视图边界）
function sideLines(view, ext) {
  const [U0, V0, U1, V1] = ext, W = U1 - U0, H = V1 - V0;
  // 读歪了的短线也按拉正后的样子参与
  const lines = (view.lines || []).filter(l => l.t !== 'center').map(l => (l._alt ? { ...l, a: l._alt[0], b: l._alt[1] } : l));
  const vs = lines.filter(l => isV(l) && len(l) >= 0.12 * H), hs = lines.filter(l => isH(l) && len(l) >= 0.12 * W);
  const side = (cands, k, target, span) => {
    const c = cands.filter(l => Math.abs(l.a[k] - target) < 0.12 * span);
    return c.length ? c.reduce((a, b) => (Math.abs(b.a[k] - target) < Math.abs(a.a[k] - target) - 0.02 * span || (Math.abs(b.a[k] - target) < Math.abs(a.a[k] - target) + 0.02 * span && len(b) > len(a)) ? b : a)) : null;
  };
  const two = (a, b) => [a, b].filter((x, i, arr) => x && arr.indexOf(x) === i);
  return { u: two(side(vs, 0, U0, W), side(vs, 0, U1, W)), v: two(side(hs, 1, V0, H), side(hs, 1, V1, H)) };
}

// 两点确定一条轴向的线性映射；只有一个点时借用另一方向/预估的比例
function axisMap(found, guess) {
  if (found.length >= 2) {
    const [[u0, x0], [u1, x1]] = found;
    if (Math.abs(u1 - u0) > 1e-6) { const k = (x1 - x0) / (u1 - u0); if (k * guess.k > 0 && Math.abs(k / guess.k - 1) < 0.5) return { k, o: x0 - u0 * k, n: 2 }; }
  }
  if (found.length) return { k: guess.k, o: found[0][1] - found[0][0] * guess.k, n: 1 };
  return { ...guess, n: 0 };
}

// 把端点吸到与其它线的交点上：拐角、T 形接头处的端点由两条线的交点精确确定
function snapJunctions(lines, tol) {
  const ok = lines.filter(l => l.ok && l.t !== 'center');
  const geo = ok.map(l => { const d = [l.q[0] - l.p[0], l.q[1] - l.p[1]], L = Math.hypot(...d); return { p: l.p, q: l.q, d: [d[0] / L, d[1] / L], L }; });
  ok.forEach((l, i) => {
    const gi = geo[i];
    for (const end of ['p', 'q']) {
      const E = gi[end];
      let best = null;
      geo.forEach((gj, j) => {
        if (i === j) return;
        const cr = gi.d[0] * gj.d[1] - gi.d[1] * gj.d[0];
        if (Math.abs(cr) < 0.25) return;
        // 线 i 上的点 E + t·di 与线 j 相交
        const w = [gj.p[0] - E[0], gj.p[1] - E[1]];
        const t = (w[0] * gj.d[1] - w[1] * gj.d[0]) / cr;
        const X = [E[0] + gi.d[0] * t, E[1] + gi.d[1] * t];
        const sj = (X[0] - gj.p[0]) * gj.d[0] + (X[1] - gj.p[1]) * gj.d[1];
        if (Math.abs(t) > tol || sj < -tol || sj > gj.L + tol) return;
        if (!best || Math.abs(t) < best.t) best = { t: Math.abs(t), X };
      });
      if (best) l[end] = best.X;
    }
  });
}

export function refineVision(json, I) {
  const out = JSON.parse(JSON.stringify(json));
  const rep = { moved: 0, typeFixed: 0, weak: 0, total: 0, shift: [], views: {} };
  const trace = json._debug ? (...a) => (rep.trace ||= []).push(a.map(x => (typeof x === 'number' ? Math.round(x) : Array.isArray(x) ? x.map(Math.round).join(',') : x)).join(' ')) : () => {};
  const views = {};
  // 外轮廓都是粗实线：找视图范围、量外框和实线都在“只留粗线”的图上做，尺寸线、文字不会干扰
  const T0 = thickInk(I), IT = T0.frac > 0.2 ? T0 : I;
  for (const key of VIEW_KEYS) {
    const view = out.views?.[key];
    if (!view || view.present === false) continue;
    let ext = extents(view); if (!ext || ext[2] - ext[0] < 1e-6 || ext[3] - ext[1] < 1e-6) continue;
    straighten(view, Math.max(ext[2] - ext[0], ext[3] - ext[1]));
    ext = extents(view);
    const box0 = initialBox(I, view, key), bb = blobBox(IT, box0) || blobBox(I, box0) || box0;
    const pad = 0.02 * Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    // 外轮廓碰到搜索框边上说明框给小了，放大再找
    let reg = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad], box = null;
    for (let it = 0; it < 3; it++) {
      box = outlineBox(IT, reg); if (!box) break;
      const m = 4, grow = 0.25 * Math.max(reg[2] - reg[0], reg[3] - reg[1]);
      const touch = [box[0] - reg[0] < m, box[1] - reg[1] < m, reg[2] - box[2] < m, reg[3] - box[3] < m];
      if (!touch.some(Boolean)) break;
      reg = reg.map((v, i) => (touch[i] ? v + (i < 2 ? -grow : grow) : v));
    }
    box = box || bb;
    trace('box', key, box0, bb, box);
    const [U0, V0, U1, V1] = ext;
    const guess = { u: { k: (box[2] - box[0]) / (U1 - U0), o: box[0] - U0 * (box[2] - box[0]) / (U1 - U0) }, v: { k: -(box[3] - box[1]) / (V1 - V0), o: box[3] + V0 * (box[3] - box[1]) / (V1 - V0) } };
    views[key] = { view, ext, box, guess, sides: sideLines(view, ext), size: Math.max(box[2] - box[0], box[3] - box[1]) };
  }
  const keys = Object.keys(views);
  if (!keys.length) return { json, report: { ...rep, skipped: true } };
  // 墨迹太多（方格纸、阴影很重的照片）时像素量线不可靠，直接沿用模型读数
  let inkN = 0; for (let i = 0; i < I.ink.length; i += 7) inkN += I.ink[i];
  if (inkN / (I.ink.length / 7) > 0.15) return { json, report: { ...rep, skipped: true, reason: '照片里墨迹太密（可能是方格纸或阴影）' } };

  // 第一步：量外轮廓边，顺便估计照片倾斜和粗实线线宽
  const devs = [], strokes = [];
  for (const k of keys) {
    const V = views[k], band = Math.round(Math.max(6, 0.12 * V.size));
    const map = (u, v) => [V.guess.u.o + u * V.guess.u.k, V.guess.v.o + v * V.guess.v.k];
    V.sideFits = [];
    for (const ax of ['u', 'v']) for (const l of V.sides[ax]) {
      const r = searchLine(IT, map(...l.a), map(...l.b), band, { trim: 0.15, angles: [-0.06, -0.045, -0.03, -0.015, 0, 0.015, 0.03, 0.045, 0.06] });
      if (!r || r.cov < 0.45) continue;
      // 粗线上用小窗口做主成分拟合会贴着搜索方向，量不出角度；按线宽取中心再拟合
      const g = refitAlong(IT, r.P, r.Q, 14);
      let f = g;
      if (g) { strokes.push(g.T); const at = t => [g.c[0] + g.e[0] * t, g.c[1] + g.e[1] * t]; f = refitAlong(IT, at(g.t0), at(g.t1), Math.ceil(g.T) + 5, g.T * 1.8 + 2) || g; }
      f = f || fitLine(I, r.P, r.Q, 2); if (!f) continue;
      const L = Math.hypot(r.Q[0] - r.P[0], r.Q[1] - r.P[1]);
      let d = Math.atan2(f.e[1], f.e[0]); d = ((d % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2); if (d > Math.PI / 4) d -= Math.PI / 2;
      devs.push([d, L]);
      V.sideFits.push({ ax, val: l.a[ax === 'u' ? 0 : 1], c: f.c });
    }
  }
  devs.sort((a, b) => a[0] - b[0]);
  let tilt = 0;
  if (devs.length) { const half = devs.reduce((s, x) => s + x[1], 0) / 2; let acc = 0; for (const [d, L] of devs) { acc += L; if (acc >= half) { tilt = d; break; } } }
  const stroke = strokes.length ? strokes.sort((a, b) => a - b)[strokes.length >> 1] : 0;
  const ctr = [I.w / 2, I.h / 2], unrot = p => rotateAbout(p, ctr, -tilt), rerot = p => rotateAbout(p, ctr, tilt);

  // 第二步：在“转正后”的坐标里确定每个视图的比例和位置
  for (const k of keys) {
    const V = views[k];
    const fu = V.sideFits.filter(f => f.ax === 'u').map(f => [f.val, unrot(f.c)[0]]);
    const fv = V.sideFits.filter(f => f.ax === 'v').map(f => [f.val, unrot(f.c)[1]]);
    // 只量到一边时，另一边用外轮廓像素范围补上
    const [U0, V0, U1, V1] = V.ext, W = U1 - U0, H = V1 - V0;
    const bc = unrot([(V.box[0] + V.box[2]) / 2, (V.box[1] + V.box[3]) / 2]), bw = (V.box[2] - V.box[0]) / 2, bh = (V.box[3] - V.box[1]) / 2;
    if (fu.length === 1) fu.push(Math.abs(fu[0][0] - U0) < Math.abs(fu[0][0] - U1) ? [U1, bc[0] + bw] : [U0, bc[0] - bw]);
    if (fv.length === 1) fv.push(Math.abs(fv[0][0] - V0) < Math.abs(fv[0][0] - V1) ? [V1, bc[1] - bh] : [V0, bc[1] + bh]);
    if (fu.length === 2 && Math.abs(fu[0][0] - fu[1][0]) < 0.3 * W) fu.pop();
    if (fv.length === 2 && Math.abs(fv[0][0] - fv[1][0]) < 0.3 * H) fv.pop();
    let mu = axisMap(fu, V.guess.u), mv = axisMap(fv, V.guess.v);
    // 只量到一边时，借用另一方向的比例（照片里横竖比例基本一致）
    if (mu.n < 2 && mv.n === 2) mu = axisMap(fu, { k: -mv.k, o: V.guess.u.o });
    if (mv.n < 2 && mu.n === 2) mv = axisMap(fv, { k: -mu.k, o: V.guess.v.o });
    V.mu = mu; V.mv = mv;
    V.map = (u, v) => rerot([mu.o + u * mu.k, mv.o + v * mv.k]);
  }

  // 第三步：逐条量线
  const AX = [-0.012, -0.006, 0, 0.006, 0.012], SL = [-0.1, -0.075, -0.05, -0.025, 0, 0.025, 0.05, 0.075, 0.1];
  const px = {};
  for (const k of keys) {
    const V = views[k], view = V.view, map = V.map;
    const size = Math.max(Math.abs(V.mu.k) * (V.ext[2] - V.ext[0]), Math.abs(V.mv.k) * (V.ext[3] - V.ext[1]));
    const band = Math.round(Math.max(5, size * 0.06)), gap = Math.round(Math.max(5, size * 0.02));
    // 判断“重合”的距离按线宽放宽：搜索到的位置可能贴在粗线的一侧
    const tolC = Math.max(5, stroke * 0.8 + 2);
    const P = { lines: [], circles: [], arcs: [] };
    // 拟合 + 端点：PCA 拟合两遍让线居中，再沿线走到墨迹断开处
    const settle = (l, r, L, slant) => {
      const I = r.img || I0;
      // 先宽窗口找到这道墨迹，再按实测线宽收窄窗口取中心
      let f = refitAlong(I, r.P, r.Q, slant ? Math.min(band, 24) : 14);
      if (f) { const at = t => [f.c[0] + f.e[0] * t, f.c[1] + f.e[1] * t]; f = refitAlong(I, at(f.t0), at(f.t1), Math.ceil(f.T) + 5, f.T * 1.8 + 2) || f; }
      else { f = fitLine(I, r.P, r.Q, 2); if (f) { const at = t => [f.c[0] + f.e[0] * t, f.c[1] + f.e[1] * t]; f = fitLine(I, at(f.t0), at(f.t1), 2) || f; } }
      if (!f) return [r.P, r.Q];
      const at = t => [f.c[0] + f.e[0] * t, f.c[1] + f.e[1] * t];
      // 实线断开 4 像素就停，虚线允许跨过间隔
      const g = l.t !== 'solid' ? Math.min(size * 0.08, Math.max(gap, dashGap(I, at(f.t0), at(f.t1)) * 1.3 + 2)) : Math.min(gap, 4);
      // 实线走到细线上就停；虚线、中心线走进粗实线就停（共线的实线段不归它）
      const thin = l.t !== 'solid' && f.T && stroke && f.T < stroke * 0.8 ? Math.max(f.T * 1.5, f.T + 2) : 0;
      const [t0, t1] = extent(I, f, g, Math.max(L * 0.15, size * 0.08), I === I0 && l.t === 'solid' && (f.T || stroke) >= 4 ? (f.T || stroke) * 0.65 : 0, thin);
      if (t1 - t0 <= L * 0.4) return [at(f.t0), at(f.t1)];
      // 粗实线的墨迹在端点处会多出半个线宽（圆头、或拐角处另一条线的墨迹），往回收半个线宽
      const half = l.t === 'solid' ? (f.T || stroke) / 2 : 0;
      return t1 - t0 > 4 * half + 4 ? [at(t0 + half), at(t1 - half)] : [at(t0), at(t1)];
    };
    const I0 = I;
    // 实线先在粗线图上找，找不到再回到完整墨迹（照片里粗细分不清时）
    const find = (l, p, q, b, opts) => {
      if (l.t === 'solid' && IT !== I) { const r = searchLine(IT, p, q, b, opts); if (r && r.cov >= 0.35) return { ...r, img: IT }; }
      return searchLine(I, p, q, b, opts);
    };
    const accept = (l, rec, np, nq) => {
      const kd = l.t === 'center' ? {} : lineKind(I, np, nq);
      if (kd.kind && kd.kind !== l.t) { rec.t = kd.kind; rep.typeFixed++; }
      Object.assign(rec, { p: np, q: nq, ok: true });
    };
    const recs = (view.lines || []).map(l => {
      rep.total++;
      const p = map(...l.a), q = map(...l.b);
      const rest = Object.fromEntries(Object.entries(l).filter(([k]) => k[0] !== '_'));
      return { l, rec: { ...rest, p, q, p0: p, q0: q, ok: false }, L: Math.hypot(q[0] - p[0], q[1] - p[1]) };
    });
    // 先量横平竖直的线
    // 顺序：实线 → 中心线 → 虚线；后量的不许占用先量好的线（虚线常被旁边的中心线吸走）
    const slanted = [], rank = { solid: 0, center: 1, dashed: 2 };
    // 读得端正的线先量，拉正出来的线后量（这样它们不会抢走别人的线）
    const order = [...recs].sort((a, b) => (a.l._alt ? 1 : 0) - (b.l._alt ? 1 : 0) || (rank[a.l.t] ?? 0) - (rank[b.l.t] ?? 0));
    // 很短的线（台阶的小边、倒角）单独放到最后：靠两端已量好的线的端点来定
    const tinyL = Math.max(30, size * 0.06), tiny = [];
    for (const { l, rec, L } of order) {
      if (L < tinyL && l.t !== 'center') { tiny.push({ l, rec, L }); continue; }
      if (L < 6) continue;
      const axis = isV(l) || isH(l);
      if (l.t === 'center' && !axis) continue;
      if (!axis && !l._alt) { slanted.push({ l, rec, L }); continue; }
      const claimed = l.t === 'solid' ? null : recs.filter(o => o.rec.ok && (l.t === 'dashed' || o.rec.t === 'solid')).map(o => o.rec);
      // 虚线不许落到点画线上，中心线也不许落到长短均匀的虚线上
      const reject = claimed ? (P, Q) => coincides(P, Q, claimed, tolC) || (l.t === 'dashed' && looksDashDot(I, P, Q)) || (l.t === 'center' && dashKind(I, P, Q) === 'dashed') : null;
      let r = axis ? find(l, rec.p, rec.q, band, { angles: AX, reject }) : null;
      if (l.t === 'center') { if (r && r.cov >= 0.35) accept(l, rec, ...settle(l, r, L)); continue; }
      if (l._alt) {
        // 拉正后墨迹够连续才算横竖线，否则当斜线处理
        const rj = (P, Q) => coincides(P, Q, recs.filter(o => o.rec.ok).map(o => o.rec), tolC) || (reject ? reject(P, Q) : false);
        let ra = find(l, map(...l._alt[0]), map(...l._alt[1]), band, { angles: AX, reject: rj });
        if (l._alt2) { const rb = find(l, map(...l._alt2[0]), map(...l._alt2[1]), band, { angles: AX, reject: rj }); if (rb && (!ra || rb.cov > ra.cov + 0.05)) ra = rb; }
        if (!ra || ra.cov < (l.t === 'dashed' ? 0.5 : 0.8)) { slanted.push({ l, rec, L }); continue; }
        r = ra;
      }
      trace('axis', l.t, rec.p0, rec.q0, r ? r.cov.toFixed(2) : 'none', r ? r.P : '', r ? r.Q : '');
      if (!r || r.cov < 0.35) { rec.weak = true; continue; }
      accept(l, rec, ...settle(l, r, L));
    }
    // 两条本来分开的线被吸到同一道墨迹上：偏得多的那条退回模型读数，稍后放宽范围重找
    const dedupe = () => {
      const ok = recs.map(o => o.rec).filter(l => l.ok && l.t !== 'center');
      for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
        const A = ok[i], B = ok[j]; if (!A.ok || !B.ok) continue;
        const dA = [A.q[0] - A.p[0], A.q[1] - A.p[1]], LA = Math.hypot(...dA), uA = [dA[0] / LA, dA[1] / LA];
        const dB = [B.q[0] - B.p[0], B.q[1] - B.p[1]], LB = Math.hypot(...dB);
        if (Math.abs(uA[0] * dB[1] - uA[1] * dB[0]) / LB > 0.03) continue;
        const perp = (pt, o, u) => Math.abs((pt[0] - o[0]) * u[1] - (pt[1] - o[1]) * u[0]);
        const mB = [(B.p[0] + B.q[0]) / 2, (B.p[1] + B.q[1]) / 2];
        if (perp(mB, A.p, uA) > 3) continue;
        const pr = pt => (pt[0] - A.p[0]) * uA[0] + (pt[1] - A.p[1]) * uA[1];
        const b0 = Math.min(pr(B.p), pr(B.q)), b1 = Math.max(pr(B.p), pr(B.q));
        if (Math.min(LA, b1) - Math.max(0, b0) < 0.5 * Math.min(LA, LB)) continue;
        const m0B = [(B.p0[0] + B.q0[0]) / 2, (B.p0[1] + B.q0[1]) / 2];
        if (perp(m0B, A.p0, uA) < band * 0.4) continue;
        const shift = l => Math.hypot((l.p[0] + l.q[0] - l.p0[0] - l.q0[0]) / 2, (l.p[1] + l.q[1] - l.p0[1] - l.q0[1]) / 2);
        const W = shift(A) > shift(B) ? A : B;
        trace('dedupe revert', W.p, W.q);
        Object.assign(W, { p: W.p0, q: W.q0, ok: false, weak: true });
      }
    };
    dedupe();
    // 没找到的横竖线放宽搜索范围再找一次，但不许和已量好的线重合
    for (const { l, rec, L } of recs) {
      if (!rec.weak || !(isV(l) || isH(l))) continue;
      const done = recs.filter(o => o.rec.ok).map(o => o.rec);
      const r = find(l, rec.p, rec.q, band * 2, { angles: AX, reject: (P, Q) => coincides(P, Q, done, tolC) });
      trace('retry', rec.p0, rec.q0, r ? r.cov.toFixed(2) : 'none', r ? r.P : '', r ? r.Q : '');
      if (r && r.cov >= 0.5) { delete rec.weak; accept(l, rec, ...settle(l, r, L)); }
    }
    // 横竖线怎么也找不到：可能其实是斜线被读成了横竖线，按原始读数交给斜线流程
    for (const o of recs) if (o.rec.weak && o.l.t !== 'center' && o.L >= 6) {
      delete o.rec.weak;
      if (o.l._orig) { o.rec.p = map(...o.l._orig[0]); o.rec.q = map(...o.l._orig[1]); }
      slanted.push(o);
    }
    // 再量斜线：端点多半落在已量好的线的端点上；不行再大范围转角搜索
    const R = size * 0.12;
    const tryEnds = ({ l, rec, L }) => {
      const ends = recs.filter(o => o.rec.ok && o.rec !== rec).flatMap(o => [o.rec.p, o.rec.q]);
      const near = pt => ends.map(e => [e, Math.hypot(e[0] - pt[0], e[1] - pt[1])]).filter(x => x[1] < R).sort((a, b) => a[1] - b[1]).slice(0, 4);
      const ca = [[rec.p, 0], ...near(rec.p)], cb = [[rec.q, 0], ...near(rec.q)];
      let best = null;
      const taken = recs.filter(o => o.rec.ok && o.rec !== rec && o.rec.t !== 'center').map(o => o.rec);
      for (const [A, da] of ca) for (const [B, db] of cb) {
        const LL = Math.hypot(B[0] - A[0], B[1] - A[1]); if (LL < L * 0.5) continue;
        if (coincides(A, B, taken, tolC)) continue;
        const ux = (B[0] - A[0]) / LL, uy = (B[1] - A[1]) / LL, tr = Math.min(0.15 * LL, band * 1.5);
        const { cov } = profile(l.t === 'solid' ? IT : I, [A[0] + ux * tr, A[1] + uy * tr], [B[0] - ux * tr, B[1] - uy * tr]);
        const sc = cov - 0.1 * (da + db) / R;
        if (!best || sc > best.sc) best = { sc, cov, P: A, Q: B, img: l.t === 'solid' ? IT : I };
      }
      return best && best.cov >= (l.t === 'dashed' ? 0.45 : 0.75) ? best : null;
    };
    const SW = Array.from({ length: 25 }, (_, i) => (i - 12) * 0.025);
    for (const o of slanted) {
      let r = tryEnds(o);
      const taken = recs.filter(x => x.rec.ok && x.rec !== o.rec && x.rec.t !== 'center').map(x => x.rec);
      const rs = find(o.l, o.rec.p, o.rec.q, band * 2, { angles: SW, reject: (P, Q) => coincides(P, Q, taken, tolC) });
      if (rs && rs.cov >= 0.5 && (!r || rs.cov > r.cov + 0.08)) r = rs;
      if (r) accept(o.l, o.rec, ...settle(o.l, r, o.L, true));
    }
    // 没量到的斜线再试一次：这时其它斜线的端点也能当候选（比如 V 形槽的谷底）
    for (const o of slanted) if (!o.rec.ok) { const r = tryEnds(o); if (r) accept(o.l, o.rec, ...settle(o.l, r, o.L, true)); else o.rec.weak = true; }
    for (const o of tiny) {
      const { l, rec, L } = o;
      const taken = recs.filter(x => x.rec.ok && x.rec !== rec && x.rec.t !== 'center').map(x => x.rec);
      const ends = taken.flatMap(x => [x.p, x.q]);
      const R2 = Math.max(3 * L, size * 0.1);
      const near = pt => [[pt, 0], ...ends.map(e => [e, Math.hypot(e[0] - pt[0], e[1] - pt[1])]).filter(x => x[1] < R2).sort((a, b) => a[1] - b[1]).slice(0, 5)];
      let best = null;
      for (const [A, da] of near(rec.p)) for (const [B, db] of near(rec.q)) {
        // 比线宽还短的“线”只是拐角处的一团墨迹
        const LL = Math.hypot(B[0] - A[0], B[1] - A[1]); if (LL < Math.max(4, L * 0.3, stroke * 1.2, tolC) || LL > Math.max(L * 3 + 10, R2)) continue;
        if (coincides(A, B, taken, tolC)) continue;
        const ux = (B[0] - A[0]) / LL, uy = (B[1] - A[1]) / LL, tr = Math.min(LL * 0.25, 3);
        const { cov } = profile(I, [A[0] + ux * tr, A[1] + uy * tr], [B[0] - ux * tr, B[1] - uy * tr]);
        // 两端都落在已量好的端点上最可信
        const sc = cov + (da ? 0.15 : 0) + (db ? 0.15 : 0) - 0.2 * (da + db) / R2;
        if (cov >= (l.t === 'dashed' ? 0.4 : 0.7) && (!best || sc > best.sc)) best = { sc, P: A, Q: B, both: da > 0 && db > 0 };
      }
      trace('tiny', l.t, rec.p0, rec.q0, 'L', L, 'R2', R2, best ? best.P : 'none', best ? best.Q : '', best ? best.sc.toFixed(2) : '', 'cands', near(rec.p).length, near(rec.q).length);
      if (best) Object.assign(rec, { p: [...best.P], q: [...best.Q], ok: true });
      else rec.weak = true;
    }
    // 量完后长度几乎为 0 的线不可信，退回模型读数
    for (const { rec } of recs) if (rec.ok && Math.hypot(rec.q[0] - rec.p[0], rec.q[1] - rec.p[1]) < 3) Object.assign(rec, { p: rec.p0, q: rec.q0, ok: false, weak: true });
    // 外轮廓以外不会有实线、虚线：落到外面的是认错了墨迹（尺寸线、引线、文字），退回模型读数
    {
      const b = V.box, m = Math.max(6, stroke * 1.5 + size * 0.03);
      const outside = pt => pt[0] < b[0] - m || pt[0] > b[2] + m || pt[1] < b[1] - m || pt[1] > b[3] + m;
      for (const { rec } of recs) if (rec.ok && rec.t !== 'center' && (outside(rec.p) || outside(rec.q))) { trace('outside', rec.p, rec.q); Object.assign(rec, { p: rec.p0, q: rec.q0, ok: false, weak: true }); }
    }
    for (const { l } of recs) { delete l._alt; delete l._alt2; delete l._orig; }
    P.lines = recs.map(o => o.rec);
    dedupe();
    snapJunctions(P.lines, Math.max(4, size * 0.03));
    const ring = (c, from, to) => {
      const cc = map(...c.c), rr = c.r * (Math.abs(V.mu.k) + Math.abs(V.mv.k)) / 2;
      const J = c.t === 'dashed' ? I : IT;
      const g = coarseCircle(J, cc, rr, band, from, to);
      const f = refineCircle(J, g ? g.c : cc, g ? g.r : rr, Math.max(4, band / 3), from, to) || refineCircle(J, cc, rr, band, from, to) || (J !== I ? refineCircle(I, cc, rr, band, from, to) : null);
      if (f) rep.moved++; else rep.weak++;
      return { ...c, pc: f ? f.c : cc, pr: f ? f.r : rr };
    };
    for (const c of view.circles || []) { rep.total++; P.circles.push(ring(c)); }
    for (const a of view.arcs || []) { rep.total++; P.arcs.push(ring(a, a.from, a.to)); }
    unifyCenters([...P.circles, ...P.arcs], Math.max(3, size * 0.015));
    snapToCircles(P.lines, [...P.circles, ...P.arcs], Math.max(4, size * 0.03));

    // 模型“脑补”的线：照片里找不到墨迹的线不能拿去建模（以照片为准）。
    // 实线决定外轮廓，这个视图大部分线都量到了时，没量到的实线一律去掉（真漏掉的会在下面从墨迹里补回来）；
    // 虚线只在附近完全没有墨迹时去掉
    {
      const real = P.lines.filter(l => l.t !== 'center' && Math.hypot(l.q0[0] - l.p0[0], l.q0[1] - l.p0[1]) >= 6);
      const trusted = real.length && real.filter(l => l.ok).length / real.length >= 0.75;
      for (const l of P.lines) {
        if (!l.weak || l.t === 'center') continue;
        let drop = false;
        if (l.t === 'solid') drop = trusted;
        else { const r = searchLine(I, l.p0, l.q0, band * 2, { angles: [-0.15, -0.075, 0, 0.075, 0.15] }); drop = !r || r.cov < 0.25; }
        if (drop) { l.dropped = true; l.weak = false; rep.dropped = (rep.dropped || 0) + 1; }
      }
    }

    // 模型漏读的线：外轮廓范围内的粗墨迹离所有已识别的线、圆都很远，就从墨迹里把直线找出来补上
    {
      const b = V.box, near = Math.max(6, stroke * 1.2 + 4), pad = stroke * 2 + 4;
      // 中心线是细线，和它重合的粗墨迹（比如槽边正好在孔的中心线上）仍然算没读到
      const segs = P.lines.filter(l => l.ok && l.t !== 'center').map(l => [l.p, l.q]);
      const rings = [...P.circles, ...P.arcs].map(c => [c.pc, c.pr]);
      // 只扣掉已识别线条本身的笔画（线宽 + 圆头），不多扣：和它相交的漏读线只会断开一个线宽，仍然连成一团
      const cap = stroke * 0.75 + 2;
      const dSeg = (x, y, [p, q]) => { const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1, t = ((x - p[0]) * dx + (y - p[1]) * dy) / L; if (t < -cap || t > L + cap) return Infinity; return Math.abs((x - p[0]) * dy - (y - p[1]) * dx) / L; };
      const x0 = Math.max(0, Math.floor(b[0] - pad)), x1 = Math.min(I.w - 1, Math.ceil(b[2] + pad)), y0 = Math.max(0, Math.floor(b[1] - pad)), y1 = Math.min(I.h - 1, Math.ceil(b[3] + pad));
      const W = x1 - x0 + 1, mask = new Uint8Array(W * (y1 - y0 + 1));
      let cnt = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (!IT.ink[y * I.w + x]) continue;
        let ok = false;
        for (const sg of segs) if (dSeg(x, y, sg) < cap) { ok = true; break; }
        if (!ok) for (const [c, r] of rings) if (Math.abs(Math.hypot(x - c[0], y - c[1]) - r) < cap) { ok = true; break; }
        if (!ok) { mask[(y - y0) * W + (x - x0)] = 1; cnt++; }
      }
      const minLen = Math.max(18, size * 0.05);
      // 比 minLen 短的线也收，但要两头都接在已识别的线上（比如槽的侧边，扣掉两端拐角后只剩一小段）
      const minLenS = Math.min(minLen, Math.max(12, stroke * 3)), minPts = Math.max(20, minLenS * stroke * 0.5);
      const bridged = (p, q) => {
        const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, e = cap + stroke + 2;
        const cross = sg => { const sx = sg[1][0] - sg[0][0], sy = sg[1][1] - sg[0][1]; return Math.abs(ux * sy - uy * sx) / (Math.hypot(sx, sy) || 1) > 0.7; };
        const hit = pt => segs.some(sg => cross(sg) && dSeg(pt[0], pt[1], sg) < near);
        return hit([p[0] - ux * e, p[1] - uy * e]) && hit([q[0] + ux * e, q[1] + uy * e]);
      };
      if (cnt >= minPts) {
        // 连通块（8 邻域，允许 2 像素的小断口）
        const lab = new Int32Array(mask.length).fill(-1), st = [];
        for (let s0 = 0; s0 < mask.length; s0++) {
          if (!mask[s0] || lab[s0] >= 0) continue;
          const pts = []; lab[s0] = s0; st.push(s0);
          while (st.length) {
            const k2 = st.pop(), x = k2 % W, y = (k2 / W) | 0; pts.push([x + x0, y + y0]);
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y > y1 - y0) continue; const kk = Y * W + X; if (mask[kk] && lab[kk] < 0) { lab[kk] = s0; st.push(kk); } }
          }
          if (pts.length < minPts) continue;
          for (const sg of ransacLines(pts, Math.max(2.5, stroke * 0.7), minPts, minLenS)) {
            const rec = { a: [0, 0], b: [0, 0], t: 'solid', p: sg.p, q: sg.q, p0: sg.p, q0: sg.q, ok: true, found: true };
            // 按线宽收紧到墨迹中心
            const f = refitAlong(IT, sg.p, sg.q, Math.ceil(stroke) + 5, stroke * 1.8 + 2);
            if (f) { const at = t => [f.c[0] + f.e[0] * t, f.c[1] + f.e[1] * t]; rec.p = at(f.t0); rec.q = at(f.t1); }
            const len = Math.hypot(rec.q[0] - rec.p[0], rec.q[1] - rec.p[1]);
            if (len < minLenS || (len < minLen && !bridged(rec.p, rec.q))) continue;
            // 大半段贴着已识别的线（拐角处的墨迹团、已有线的残余）不算漏读
            // 只看和它方向相近的线：夹在两条平行线之间的短竖边（槽的侧边）两端贴着横线，不算残余
            const ex = rec.q[0] - rec.p[0], ey = rec.q[1] - rec.p[1], eL = Math.hypot(ex, ey) || 1;
            const para = segs.filter(([a, c]) => { const dx = c[0] - a[0], dy = c[1] - a[1]; return Math.abs(ex * dy - ey * dx) / (eL * (Math.hypot(dx, dy) || 1)) < 0.5; });
            let nearN = 0, n = 0;
            for (let t = 0; t <= 1; t += 0.1) { n++; const x = rec.p[0] + ex * t, y = rec.p[1] + ey * t; if (para.some(sg2 => dSeg(x, y, sg2) < near)) nearN++; }
            if (nearN / n > 0.5) continue;
            // 照片里这段要真有连续的墨迹；断续均匀的是虚线
            const kd = lineKind(I, rec.p, rec.q);
            if (kd.cov < 0.6) continue;
            if (kd.kind === 'dashed') rec.t = 'dashed';
            P.lines.push(rec);
            rep.added = (rep.added || 0) + 1;
          }
        }
        if (rep.added) { snapJunctions(P.lines, Math.max(4, size * 0.03)); snapToCircles(P.lines, [...P.circles, ...P.arcs], Math.max(4, size * 0.03)); }
      }
    }
    P.dropped = P.lines.filter(l => l.dropped);
    P.lines = P.lines.filter(l => !l.dropped);
    for (const l of P.lines) if (l.ok && !l.found) { rep.moved++; rep.shift.push(Math.max(Math.hypot(l.p[0] - l.p0[0], l.p[1] - l.p0[1]), Math.hypot(l.q[0] - l.q0[0], l.q[1] - l.q0[1])) / size); } else if (l.weak) rep.weak++;
    px[k] = P;
  }

  // 漏读检查：视图范围内的墨迹，离所有已识别的线、圆都很远的占多少（多了说明模型漏读了线）
  {
    let ink = 0, far = 0;
    const near = Math.max(6, stroke * 1.2 + 4);
    for (const k of keys) {
      const V = views[k], P = px[k], b = V.box, m = 0.03 * V.size;
      const segs = P.lines.map(l => [l.p, l.q]);
      const rings = [...P.circles, ...P.arcs].map(c => [c.pc, c.pr]);
      const dSeg = (x, y, [p, q]) => { const dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / L2)); return Math.hypot(x - p[0] - t * dx, y - p[1] - t * dy); };
      for (let y = Math.max(0, Math.round(b[1] + m)); y < Math.min(I.h, b[3] - m); y += 3) for (let x = Math.max(0, Math.round(b[0] + m)); x < Math.min(I.w, b[2] - m); x += 3) {
        if (!I.ink[y * I.w + x]) continue;
        ink++;
        let ok = false;
        for (const sg of segs) if (dSeg(x, y, sg) < near) { ok = true; break; }
        if (!ok) for (const [c, r] of rings) if (Math.abs(Math.hypot(x - c[0], y - c[1]) - r) < near) { ok = true; break; }
        if (!ok) far++;
      }
    }
    rep.uncovered = ink ? far / ink : 0;
  }

  // 统一比例：所有视图用同一个“像素/单位”，形体比例完全由像素决定
  const scales = keys.flatMap(k => [Math.abs(views[k].mu.k), Math.abs(views[k].mv.k)]).filter(x => x > 0).sort((a, b) => a - b);
  const s = scales[Math.floor(scales.length / 2)];
  const r05 = x => Math.round(x * 10) / 10; // 像素量出来的坐标精度比目测高，保留一位小数，交给三等对齐去归并
  for (const k of keys) {
    const P = px[k], view = views[k].view;
    // 原点取在外轮廓（实线）上，避免误量的虚线、中心线把整张视图带偏
    const solid = P.lines.filter(l => l.t === 'solid' && l.ok);
    const cpts = P.circles.filter(c => c.t !== 'dashed').flatMap(c => { const q = unrot(c.pc); return [[q[0] - c.pr, q[1] - c.pr], [q[0] + c.pr, q[1] + c.pr]]; });
    const all = solid.length >= 2 ? [...solid.flatMap(l => [unrot(l.p), unrot(l.q)]), ...cpts] : [...P.lines.filter(l => l.t !== 'center').flatMap(l => [unrot(l.p), unrot(l.q)]), ...P.circles.flatMap(c => { const q = unrot(c.pc); return [[q[0] - c.pr, q[1] - c.pr], [q[0] + c.pr, q[1] + c.pr]]; }), ...P.arcs.map(a => unrot(a.pc))];
    const minX = Math.min(...all.map(p => p[0])), maxY = Math.max(...all.map(p => p[1]));
    const cvt = q => [r05((q[0] - minX) / s), r05((maxY - q[1]) / s)];
    const loc = p => cvt(unrot(p));
    // 转正后差不到 3° 的线直接摆正，免得取整后短线变成斜线
    const pair = (p, q) => {
      const A = unrot(p), B = unrot(q), a = Math.abs(Math.atan2(B[1] - A[1], B[0] - A[0]) * 180 / Math.PI) % 180;
      if (Math.min(a, 180 - a) < 3) { const m = (A[1] + B[1]) / 2; A[1] = B[1] = m; }
      else if (Math.abs(a - 90) < 3) { const m = (A[0] + B[0]) / 2; A[0] = B[0] = m; }
      return [cvt(A), cvt(B)];
    };
    view.lines = P.lines.map(({ p, q, p0, q0, ok, weak, ...l }) => { const [a, b] = pair(p, q); return { ...l, a, b, ...(weak ? { weak: true } : {}) }; });
    // 圆心、半径取到 0.5：三等对齐时圆心会按 0.5 取整，半径跟着取整才不会让外框差半格
    const h05 = x => Math.round(x * 2) / 2;
    view.circles = P.circles.map(({ pc, pr, ...c }) => ({ ...c, c: loc(pc).map(h05), r: h05(pr / s) }));
    view.arcs = P.arcs.map(({ pc, pr, ...a }) => ({ ...a, c: loc(pc).map(h05), r: h05(pr / s) }));
    const V = views[k], fr = [V.map(V.ext[0], V.ext[3]), V.map(V.ext[2], V.ext[1])];
    if (json._debug) rep.views[k + 'Px'] = P.lines.map(l => [unrot(l.p).map(Math.round), unrot(l.q).map(Math.round), minX | 0, maxY | 0]);
    // 叠加显示用：照片像素坐标下量到的线（ok）、没找到的线（weak）
    const ov = (rep.overlay ||= { w: I.w, h: I.h, lines: [], rings: [] });
    for (const l of P.lines) ov.lines.push([...l.p, ...l.q, l.t, l.found ? 'found' : l.ok ? 'ok' : l.weak ? 'weak' : 'model'].map(x => (typeof x === 'number' ? Math.round(x) : x)));
    for (const l of P.dropped || []) ov.lines.push([...l.p0, ...l.q0, l.t, 'dropped'].map(x => (typeof x === 'number' ? Math.round(x) : x)));
    for (const c of [...P.circles, ...P.arcs]) ov.rings.push([Math.round(c.pc[0]), Math.round(c.pc[1]), Math.round(c.pr), c.from ?? null, c.to ?? null, c.t]);
    rep.views[k] = { frame: [fr[0][0], fr[0][1], fr[1][0], fr[1][1]].map(Math.round), sides: V.sideFits.length };
  }
  // 大部分线都没在照片里找到：多半是视图位置或照片本身有问题，不冒险替换
  const lineTotal = keys.reduce((n, k) => n + px[k].lines.filter(l => l.t !== 'center').length, 0);
  const found = keys.reduce((n, k) => n + px[k].lines.filter(l => l.ok && l.t !== 'center').length, 0);
  if (lineTotal && found / lineTotal < 0.5) return { json, report: { ...rep, skipped: true, reason: `只在照片里找到 ${found}/${lineTotal} 条线` } };
  rep.tiltDeg = +(tilt * 180 / Math.PI).toFixed(2);
  rep.meanShift = rep.shift.length ? rep.shift.reduce((a, b) => a + b, 0) / rep.shift.length : 0;
  return { json: out, report: rep };
}

export function reportText(r) {
  if (r.skipped) return `算法量线：${r.reason || '没有找到可量的视图'}，沿用模型读数`;
  const parts = [`算法量线：${r.moved}/${r.total} 条图线按像素重新定位`];
  if (r.meanShift > 0.005) parts.push(`平均修正 ${(r.meanShift * 100).toFixed(1)}%（相对视图尺寸）`);
  if (r.typeFixed) parts.push(`${r.typeFixed} 条线按断续规律改判虚实`);
  if (Math.abs(r.tiltDeg) > 0.3) parts.push(`照片倾斜 ${r.tiltDeg}° 已转正`);
  if (r.dropped) parts.push(`${r.dropped} 条模型读出的线在照片里根本没有，已去掉`);
  if (r.added) parts.push(`从照片里补上 ${r.added} 条模型漏读的线`);
  if (r.weak) parts.push(`${r.weak} 条在照片里没找到对应墨迹，可能是误读，请留意`);
  if (r.uncovered > 0.025) parts.push(`照片里约 ${Math.round(r.uncovered * 100)}% 的图线墨迹没有对应的识别结果，可能漏读了线`);
  return parts.join('，');
}

// 量线结果是否可疑（需要让大模型再对照照片自检一遍）
export function suspicious(r) {
  if (!r || r.skipped) return true;
  return r.weak / Math.max(1, r.total) > 0.1 || r.uncovered > 0.025;
}
