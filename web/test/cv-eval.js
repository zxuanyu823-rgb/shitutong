// 算法量线评测：用题库模型合成“照片”（倾斜、模糊、噪声、光照不均），
// 再生成带较大误差的“模型读数”，比较 只用模型读数 与 加上算法量线 两种情况的重建成功率。
import { MODELS } from '../js/models.js';
import { buildMesh, analyze } from '../js/engine.js';
import { drawingSVG, layoutOf } from '../js/views2d.js';
import { synthVision, fromVision, reconcile } from '../js/recon/drawing.js';
import { reconstruct, compare } from '../js/recon/reconstruct.js';
import { binarize, refineVision, thickInk } from '../js/recon/cv.js';

let st = 1; const rnd = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
const seed = (def, s) => { st = (s * 7919 + [...def.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 99991) % 2147483646 + 1; for (let i = 0; i < 4; i++) rnd(); };

// 尺寸标注（细线、箭头、数字）和视图名称，模拟课本题目里的干扰
function dimsSVG(model, lay) {
  const [bmin, bmax] = model.bbox, st = 'stroke="#222" stroke-width="0.25" fill="none"';
  let o = '';
  const arrow = (x, y, dx, dy) => { const L = 2.2, w = 0.7, n = Math.hypot(dx, dy), ux = dx / n, uy = dy / n; return `<path d="M${x} ${y} L${x - ux * L - uy * w} ${y - uy * L + ux * w} L${x - ux * L + uy * w} ${y - uy * L - ux * w}Z" fill="#222"/>`; };
  const hdim = (x0, x1, yEdge, off, text) => { const y = yEdge + off; o += `<line x1="${x0}" y1="${yEdge + 1}" x2="${x0}" y2="${y + 1.5}" ${st}/><line x1="${x1}" y1="${yEdge + 1}" x2="${x1}" y2="${y + 1.5}" ${st}/><line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" ${st}/>` + arrow(x0, y, -1, 0) + arrow(x1, y, 1, 0) + `<text x="${(x0 + x1) / 2}" y="${y - 0.8}" font-size="3.5" text-anchor="middle" fill="#222" font-family="sans-serif">${text}</text>`; };
  const vdim = (y0, y1, xEdge, off, text) => { const x = xEdge - off; o += `<line x1="${xEdge - 1}" y1="${y0}" x2="${x - 1.5}" y2="${y0}" ${st}/><line x1="${xEdge - 1}" y1="${y1}" x2="${x - 1.5}" y2="${y1}" ${st}/><line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" ${st}/>` + arrow(x, y0, 0, -1) + arrow(x, y1, 0, 1) + `<text x="${x - 0.8}" y="${(y0 + y1) / 2}" font-size="3.5" text-anchor="middle" fill="#222" font-family="sans-serif" transform="rotate(-90 ${x - 0.8} ${(y0 + y1) / 2})">${text}</text>`; };
  const F = lay.front, T = lay.top, Lf = lay.left;
  hdim(F.ox + bmin[0], F.ox + bmax[0], F.oy - bmin[2], 7, Math.round(bmax[0] - bmin[0]));
  vdim(F.oy - bmax[2], F.oy - bmin[2], F.ox + bmin[0], 7, Math.round(bmax[2] - bmin[2]));
  vdim(T.oy - bmax[1], T.oy - bmin[1], T.ox + bmin[0], 7, Math.round(bmax[1] - bmin[1]));
  hdim(Lf.ox - bmax[1], Lf.ox - bmin[1], Lf.oy - bmin[2], 7, Math.round(bmax[1] - bmin[1]));
  const lab = (x, y, t) => `<text x="${x}" y="${y}" font-size="4" text-anchor="middle" fill="#222" font-family="sans-serif">${t}</text>`;
  o += lab(F.ox + (bmin[0] + bmax[0]) / 2, F.oy - bmax[2] - 3, '主视图') + lab(Lf.ox - (bmin[1] + bmax[1]) / 2, Lf.oy - bmax[2] - 3, '左视图') + lab(T.ox + (bmin[0] + bmax[0]) / 2, T.oy - bmin[1] + 6, '俯视图');
  return o;
}

export async function fakePhoto(model, { tilt = 1.2, blur = 0.7, noise = 18, dims = false } = {}) {
  const d = drawingSVG(model, { labels: false, miter: false });
  const lay = d.lay, W = 1500, k = W / lay.width, H = Math.round(lay.height * k);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${d.viewBox}">${d.body.replaceAll('var(--ink)', '#222').replaceAll('var(--center)', '#555')}${dims ? dimsSVG(model, lay) : ''}</svg>`;
  const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
  const grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, '#f4f1e8'); grad.addColorStop(1, '#c9c4b8');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.save(); g.translate(W / 2, H / 2); g.rotate(tilt * Math.PI / 180); g.translate(-W / 2, -H / 2); g.filter = `blur(${blur}px)`; g.drawImage(img, 0, 0); g.restore();
  const id = g.getImageData(0, 0, W, H);
  for (let i = 0; i < id.data.length; i += 4) { const n = (rnd() - 0.5) * noise; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
  // 真实视图框（旋转后）
  const rot = (x, y) => { const a = tilt * Math.PI / 180, cx = W / 2, cy = H / 2, dx = x - cx, dy = y - cy; return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)]; };
  const [bmin, bmax] = model.bbox;
  const boxes = {
    front: [[lay.front.ox + bmin[0], lay.front.oy - bmax[2]], [lay.front.ox + bmax[0], lay.front.oy - bmin[2]]],
    top: [[lay.top.ox + bmin[0], lay.top.oy - bmax[1]], [lay.top.ox + bmax[0], lay.top.oy - bmin[1]]],
    left: [[lay.left.ox - bmax[1], lay.left.oy - bmax[2]], [lay.left.ox - bmin[1], lay.left.oy - bmin[2]]],
  };
  const nb = {};
  for (const v in boxes) { const [[x0, y0], [x1, y1]] = boxes[v]; const p = rot(x0 * k, y0 * k), q = rot(x1 * k, y1 * k); nb[v] = [p[0] / W, p[1] / H, q[0] / W, q[1] / H]; }
  return { image: id, boxes: nb };
}

export function truthScore(best, truth) {
  const td = reconcile(fromVision(synthVision(truth, {})));
  const [b0, b1] = best.model.bbox, k = { x: (b1[0] - b0[0]) / td.dims.x, y: (b1[1] - b0[1]) / td.dims.y, z: (b1[2] - b0[2]) / td.dims.z };
  const sc = { front: [k.x, k.z], top: [k.x, k.y], left: [k.y, k.z] };
  for (const v of ['front', 'top', 'left']) { const [su, sv] = sc[v], dv = td.views[v]; const f = p => { p[0] *= su; p[1] *= sv; }; dv.segs.forEach(s => { f(s.a); f(s.b); }); dv.circles.forEach(c => { f(c.c); c.r *= Math.sqrt(su * sv); }); dv.arcs.forEach(a => { f(a.c); a.r *= Math.sqrt(su * sv); }); }
  return compare(best.model, td, Math.max(0.8, td.tol * 0.7)).score;
}

// 模拟大模型读错：去掉一条外轮廓实线（漏读），再加一条照片里没有的实线（脑补）
function corruptReading(vj) {
  const views = ['front', 'top', 'left'].filter(v => vj.views[v]?.lines?.some(l => l.t === 'solid'));
  const v = views[Math.floor(rnd() * views.length)], L = vj.views[v].lines;
  const solids = L.filter(l => l.t === 'solid' && Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]) > 4);
  const victim = solids[Math.floor(rnd() * solids.length)];
  L.splice(L.indexOf(victim), 1);
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const l of L) for (const p of [l.a, l.b]) { u0 = Math.min(u0, p[0]); v0 = Math.min(v0, p[1]); u1 = Math.max(u1, p[0]); v1 = Math.max(v1, p[1]); }
  const w = u1 - u0, h = v1 - v0, y = v0 + h * (0.55 + rnd() * 0.4), x = u0 + w * (0.1 + rnd() * 0.3);
  L.push({ a: [x, y], b: [x + w * (0.3 + rnd() * 0.3), y], t: 'solid' });
  return v;
}

export async function run({ noise = 0.025, scaleErr = 0.08, boxErr = 0.04, seeds = 1, only, tiltMax = 3, noBox = false, dims = false, corrupt = false } = {}) {
  const { default: Module } = await import('../vendor/manifold.js'); const M = await Module(); M.setup();
  const rows = []; let okA = 0, okB = 0, n = 0;
  for (const def of MODELS) {
    if (only && def.id !== only) continue;
    if (def.id === 'bearing-seat') continue;
    const truth = analyze(def, buildMesh(M, def));
    for (let s = 1; s <= seeds; s++) {
      seed(def, s);
      const photo = await fakePhoto(truth, { tilt: (rnd() - 0.5) * tiltMax, dims });
      const vj = synthVision(truth, { noise, scaleErr, seed: s * 131 + def.id.length });
      for (const v of ['front', 'top', 'left']) { const b = photo.boxes[v]; const bb = b.map(x => x + (rnd() - 0.5) * 2 * boxErr); if (!noBox) vj.views[v].box = bb; }
      if (corrupt) corruptReading(vj);
      let a = 0, b = 0, info = '';
      try { const { cands } = await reconstruct(M, reconcile(fromVision(vj)), {}); a = cands[0]?.model ? truthScore(cands[0], truth) : 0; } catch (e) { info += ' A:' + e.message; }
      try {
        const I = binarize(photo.image);
        const { json, report } = refineVision(vj, I);
        const { cands } = await reconstruct(M, reconcile(fromVision(json)), {});
        b = cands[0]?.model ? truthScore(cands[0], truth) : 0;
        info += ` 量线 ${report.moved}/${report.total} 虚实改判 ${report.typeFixed} 倾斜 ${report.tiltDeg}°`;
      } catch (e) { info += ' B:' + e.message; }
      n++; if (a > 0.95) okA++; if (b > 0.95) okB++;
      rows.push(`${def.id.padEnd(17)} 仅模型读数 ${(a * 100).toFixed(1).padStart(5)}%  加算法量线 ${(b * 100).toFixed(1).padStart(5)}% ${info}`);
    }
  }
  return rows.join('\n') + `\n\n成功（与原题三视图吻合 >95%）：仅模型读数 ${okA}/${n}，加算法量线 ${okB}/${n}`;
}

export async function makeCase(id, s = 1) {
  const { default: Module } = await import('../vendor/manifold.js'); const M = await Module(); M.setup();
  const def = MODELS.find(m => m.id === id); const truth = analyze(def, buildMesh(M, def));
  seed(def, s);
  const photo = await fakePhoto(truth, { tilt: (rnd() - 0.5) * 3 });
  const vj = synthVision(truth, { noise: 0.025, scaleErr: 0.08, seed: s * 131 + def.id.length });
  for (const v of ['front', 'top', 'left']) { const b = photo.boxes[v]; vj.views[v].box = b.map(x => +(x + (rnd() - 0.5) * 0.08).toFixed(3)); }
  const c = document.createElement('canvas'); c.width = photo.image.width; c.height = photo.image.height; c.getContext('2d').putImageData(photo.image, 0, 0);
  return { png: c.toDataURL('image/jpeg', 0.9), json: JSON.stringify({ unit: 'mm', shape: def.name || id, features: [], ...vj }) };
}
