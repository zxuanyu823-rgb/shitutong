// 重建算法离线评测：用题库模型生成“模拟识图结果”（可加噪声、可去掉一个视图），重建后与真实三视图比对
//   node tools/eval-recon.mjs [noise] [scaleErr] [drop] [seeds]
import Module from '../node_modules/manifold-3d/manifold.js';
import { MODELS } from '../web/js/models.js';
import { buildMesh, analyze } from '../web/js/engine.js';
import { synthVision, fromVision, reconcile } from '../web/js/recon/drawing.js';
import { reconstruct, compare } from '../web/js/recon/reconstruct.js';
const M = await Module(); M.setup();
const noise = +(process.argv[2] || 0), scaleErr = +(process.argv[3] || 0), drop = process.argv[4] && process.argv[4] !== '-' ? process.argv[4] : null, seeds = +(process.argv[5] || 1);
const only = process.argv[6];
let ok = 0, n = 0; const rows = [];
for (const def of MODELS) {
  if (only && def.id !== only) continue;
  if (!only && process.env.SKIP && process.env.SKIP.split(',').includes(def.id)) continue;
  const truth = analyze(def, buildMesh(M, def));
  for (let s = 1; s <= seeds; s++) {
    const t0 = Date.now();
    const vj = synthVision(truth, { noise, scaleErr, drop, seed: s * 7919 });
    const d = reconcile(fromVision(vj));
    const { cands } = await reconstruct(M, d, {});
    const best = cands[0];
    // 与真实（无噪声、三视图齐全）比对
    const td = reconcile(fromVision(synthVision(truth, {})));
    // 识图有比例误差，重建形体的总尺寸会略有不同；把真值图按各轴比例缩放到同一尺寸再比
    if (best.model) {
      const [b0, b1] = best.model.bbox, k = { x: (b1[0] - b0[0]) / td.dims.x, y: (b1[1] - b0[1]) / td.dims.y, z: (b1[2] - b0[2]) / td.dims.z };
      const sc = { front: [k.x, k.z], top: [k.x, k.y], left: [k.y, k.z] };
      for (const v of ['front', 'top', 'left']) {
        const [su, sv] = sc[v], dv = td.views[v];
        const f = p => { p[0] *= su; p[1] *= sv; };
        dv.segs.forEach(s => { f(s.a); f(s.b); }); dv.circles.forEach(c => { f(c.c); c.r *= Math.sqrt(su * sv); }); dv.arcs.forEach(a => { f(a.c); a.r *= Math.sqrt(su * sv); });
      }
    }
    const truthCmp = best.model ? compare(best.model, td, Math.max(0.8, td.tol * 0.7)) : { score: 0 };
    const pass = truthCmp.score > 0.97;
    n++; if (pass) ok++;
    rows.push(`${def.id.padEnd(17)} seed${s} 输入吻合 ${(best.score * 100).toFixed(1).padStart(5)}%  真值吻合 ${(truthCmp.score * 100).toFixed(1).padStart(5)}%  ${pass ? '✓' : '✗'}  [${best.name}] ${Date.now() - t0}ms`);
  }
}
console.log(rows.join('\n'));
console.log(`\n噪声 ${noise} 比例误差 ${scaleErr} 缺视图 ${drop || '无'}：成功 ${ok}/${n}`);
