// 视图通 · 三视图图纸（SVG）
// 按 GB 第一角画法布置：主视图在左上，俯视图在主视图正下方，左视图在主视图正右方。
import { project, VIEW_KEYS, VIEWS } from './engine.js';

export function layoutOf(model) {
  const [bmin, bmax] = model.bbox;
  const L = bmax[0] - bmin[0], W = bmax[1] - bmin[1], H = bmax[2] - bmin[2];
  const m = 14, g = Math.max(16, 0.32 * Math.max(L, W, H));
  const front = { ox: m - bmin[0], oy: m + bmax[2] };
  const top = { ox: front.ox, oy: m + H + g + bmax[1] };
  const left = { ox: m + L + g + bmax[1], oy: front.oy };
  return { front, top, left, width: m + L + g + W + m, height: m + H + g + W + m, m, g, L, W, H, bmin, bmax };
}

export const toPaper = (lay, view, [u, v]) => [lay[view].ox + u, lay[view].oy - v];
export const fromPaper = (lay, view, [X, Y]) => [X - lay[view].ox, lay[view].oy - Y];

// 判断图纸上的点属于哪个视图（按各视图包围盒，留一点余量）
export function viewAtPaper(lay, P) {
  const { bmin, bmax } = lay;
  const box = {
    front: [[bmin[0], bmin[2]], [bmax[0], bmax[2]]],
    top: [[bmin[0], bmin[1]], [bmax[0], bmax[1]]],
    left: [[-bmax[1], bmin[2]], [-bmin[1], bmax[2]]],
  };
  let best = null, bd = Infinity;
  for (const v of VIEW_KEYS) {
    const [u, w] = fromPaper(lay, v, P);
    const [[u0, w0], [u1, w1]] = box[v];
    const du = Math.max(u0 - u, 0, u - u1), dw = Math.max(w0 - w, 0, w - w1);
    const d = Math.hypot(du, dw);
    if (d < bd) { bd = d; best = v; }
  }
  return bd < 6 ? best : null;
}

// 把首尾相接的同类线段串成折线，虚线、点画线的节奏才连贯
function chain(segs) {
  const key = p => p[0].toFixed(3) + ',' + p[1].toFixed(3);
  const used = new Array(segs.length).fill(false);
  const byPt = new Map();
  segs.forEach((s, i) => { for (const p of [s.a, s.b]) { const k = key(p); if (!byPt.has(k)) byPt.set(k, []); byPt.get(k).push(i); } });
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let pts = [segs[i].a, segs[i].b];
    for (const dirn of [1, -1]) {
      for (;;) {
        const end = dirn === 1 ? pts[pts.length - 1] : pts[0];
        const cand = (byPt.get(key(end)) || []).filter(j => !used[j]);
        if (cand.length !== 1 || byPt.get(key(end)).length > 2) break;
        const j = cand[0]; used[j] = true;
        const nxt = key(segs[j].a) === key(end) ? segs[j].b : segs[j].a;
        if (dirn === 1) pts.push(nxt); else pts.unshift(nxt);
      }
    }
    out.push(pts);
  }
  return out;
}

const pathD = (lay, view, pts) => pts.map((p, i) => { const [X, Y] = toPaper(lay, view, p); return (i ? 'L' : 'M') + X.toFixed(3) + ' ' + Y.toFixed(3); }).join('');

// 线宽按 GB/T 4457.4：粗实线 d，细线 d/2
export const STYLE = {
  vis: 'stroke="var(--ink)" stroke-width="0.7" fill="none" stroke-linecap="round" stroke-linejoin="round"',
  hid: 'stroke="var(--ink)" stroke-width="0.35" fill="none" stroke-dasharray="2.6 1.3"',
  cen: 'stroke="var(--center)" stroke-width="0.3" fill="none" stroke-dasharray="7 1.4 1 1.4"',
};

// 按制图规定，虚线、点画线两端都以“画”开始和结束（虚线和轮廓线相交处不留空）：按线长微调画和间隔
function fitDash(style, lay, view, pts) {
  const m = style.match(/stroke-dasharray="([^"]+)"/); if (!m) return style;
  const pat = m[1].split(' ').map(Number), P = pat.reduce((a, b) => a + b, 0), last = P - pat[0];
  let L = 0; for (let i = 1; i < pts.length; i++) { const [a, b] = [toPaper(lay, view, pts[i - 1]), toPaper(lay, view, pts[i])]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  const n = Math.max(1, Math.round((L + last) / P));
  if (n === 1) return style.replace(m[0], `stroke-dasharray="${(L + 1).toFixed(3)} 0"`);
  const k = L / (n * P - last);
  return style.replace(m[0], `stroke-dasharray="${pat.map(x => (x * k).toFixed(3)).join(' ')}"`);
}

export function drawingSVG(model, opts = {}) {
  const lay = layoutOf(model);
  const { hideLines = [], flipLines = [], labels = true } = opts; // 练习用：隐藏/改错某些线
  let body = '';
  // 45° 辅助线（宽相等）
  if (opts.miter !== false) {
    const { bmin, bmax } = lay;
    const a = [lay.left.ox - bmax[1] + 0, lay.top.oy - bmax[1]];
    const b = [lay.left.ox - bmin[1] + 0, lay.top.oy - bmin[1]];
    const ext = 4;
    body += `<line x1="${a[0] - ext}" y1="${a[1] - ext}" x2="${b[0] + ext}" y2="${b[1] + ext}" class="miter"/>`;
  }
  for (const v of VIEW_KEYS) {
    const vw = model.views[v];
    const lines = vw.lines.map((l, i) => ({ ...l, i }))
      .filter(l => !hideLines.some(h => h.view === v && h.i === l.i))
      .map(l => flipLines.some(h => h.view === v && h.i === l.i) ? { ...l, vis: !l.vis } : l);
    const cen = opts.hideCenter === v ? [] : chain(vw.center.map(c => ({ a: c.a, b: c.b })));
    body += `<g class="view" data-view="${v}">`;
    for (const pts of cen) body += `<path d="${pathD(lay, v, pts)}" ${fitDash(STYLE.cen, lay, v, pts)}/>`;
    for (const pts of chain(lines.filter(l => !l.vis))) body += `<path d="${pathD(lay, v, pts)}" ${fitDash(STYLE.hid, lay, v, pts)}/>`;
    for (const pts of chain(lines.filter(l => l.vis))) body += `<path d="${pathD(lay, v, pts)}" ${STYLE.vis}/>`;
    if (labels) {
      const [bmin, bmax] = [lay.bmin, lay.bmax];
      const anchor = v === 'front' ? [(bmin[0] + bmax[0]) / 2, bmin[2]] : v === 'top' ? [(bmin[0] + bmax[0]) / 2, bmin[1]] : [-(bmin[1] + bmax[1]) / 2, bmin[2]];
      const [X, Y] = toPaper(lay, v, anchor);
      const fs = Math.max(2.4, Math.min(3.6, Math.max(lay.L, lay.W, lay.H) * 0.065));
      body += `<text x="${X}" y="${Y + fs * 2}" class="vlabel" style="font-size:${fs}px" text-anchor="middle">${VIEWS[v].name}</text>`;
    }
    body += `</g>`;
  }
  return { lay, body, viewBox: `0 0 ${lay.width.toFixed(2)} ${lay.height.toFixed(2)}` };
}

// 高亮层：被选中的棱（含各视图中的投影）、面（积聚线或区域）
export function highlightSVG(model, lay, sel, opts = {}) {
  const curveIds = new Set(sel.curves || []), faceIds = new Set(sel.faces || []), occIds = new Set(sel.occluders || []);
  let out = '';
  const pts3 = [];
  for (const v of VIEW_KEYS) {
    const vw = model.views[v];
    // 面
    for (const f of model.faces) {
      if (!faceIds.has(f.id) && !occIds.has(f.id)) continue;
      const occ = !faceIds.has(f.id);
      if (vw.edgeOnFaces.includes(f.index)) {
        const segs = [];
        for (const t of f.tris) { const P = model.tris[t].map(k => project(v, model.pos[k])); segs.push([P[0], P[1]], [P[1], P[2]], [P[0], P[2]]); }
        for (const [a, b] of segs) {
          const [A, B] = [toPaper(lay, v, a), toPaper(lay, v, b)];
          out += `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" class="${occ ? 'hl-occ-edge' : 'hl-face-edge'}"/>`;
        }
      } else {
        let d = '';
        for (const t of f.tris) {
          const P = model.tris[t].map(k => toPaper(lay, v, project(v, model.pos[k])));
          d += `M${P[0][0]} ${P[0][1]}L${P[1][0]} ${P[1][1]}L${P[2][0]} ${P[2][1]}Z`;
        }
        out += `<path d="${d}" class="${occ ? 'hl-occ' : 'hl-face'}"/>`;
      }
    }
    // 棱 / 转向轮廓线
    for (const p of vw.pieces) {
      if (!curveIds.has(p.src)) continue;
      const [A, B] = [toPaper(lay, v, p.a), toPaper(lay, v, p.b)];
      out += `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" class="${p.vis ? 'hl-vis' : 'hl-hid'}"/>`;
    }
    // 积聚为点的棱
    for (const c of model.curves) {
      if (!curveIds.has(c.id) || !c.straight) continue;
      const a = project(v, c.ends[0]), b = project(v, c.ends[1]);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) {
        const [X, Y] = toPaper(lay, v, a);
        out += `<circle cx="${X}" cy="${Y}" r="1.4" class="hl-point"/>`;
      }
    }
  }
  // 投影连线（长对正、高平齐、宽相等）
  if (opts.construction !== false) {
    if (opts.points) pts3.push(...opts.points);
    else for (const c of model.curves) if (curveIds.has(c.id)) pts3.push(...(c.straight ? c.ends : [c.segs[0][0]]));
    const uniq = [];
    for (const p of pts3) if (!uniq.some(q => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-3)) uniq.push(p);
    for (const p of uniq.slice(0, 8)) out += constructionLines(lay, p);
  }
  return out;
}

export function constructionLines(lay, p) {
  const F = toPaper(lay, 'front', project('front', p));
  const T = toPaper(lay, 'top', project('top', p));
  const Lp = toPaper(lay, 'left', project('left', p));
  const M = [Lp[0], T[1]]; // 45° 线上的转折点
  return `<path d="M${F[0]} ${F[1]}L${T[0]} ${T[1]}" class="cons cons-x"/>` +
    `<path d="M${F[0]} ${F[1]}L${Lp[0]} ${Lp[1]}" class="cons cons-z"/>` +
    `<path d="M${T[0]} ${T[1]}L${M[0]} ${M[1]}L${Lp[0]} ${Lp[1]}" class="cons cons-y"/>` +
    [F, T, Lp].map(q => `<circle cx="${q[0]}" cy="${q[1]}" r="0.9" class="cons-pt"/>`).join('');
}

// 把屏幕上的点击换算成：哪个视图、该视图坐标
export function hitTest(model, lay, P) {
  const v = viewAtPaper(lay, P);
  if (!v) return null;
  return { view: v, uv: fromPaper(lay, v, P) };
}
