import Module from '../node_modules/manifold-3d/manifold.js';
import { getModel } from '../web/js/models.js';
import { buildMesh, analyze } from '../web/js/engine.js';
import { synthVision, fromVision, reconcile } from '../web/js/recon/drawing.js';
import { reconstruct, diffText, contoursOf } from '../web/js/recon/reconstruct.js';
const M = await Module(); M.setup();
const def = getModel(process.argv[2]);
const truth = analyze(def, buildMesh(M, def));
const vj = synthVision(truth, { noise: +(process.argv[4]||0), scaleErr: +(process.argv[5]||0), seed: 7919, drop: process.argv[6]||null });
if (process.argv[3] === 'json') console.log(JSON.stringify(vj));
const d = reconcile(fromVision(vj));
console.log('dims', d.dims, 'tol', d.tol.toFixed(2), d.log);
const cs = contoursOf(d); for (const v in cs) console.log(v, JSON.stringify(cs[v]?.map(p=>p.map(x=>+x.toFixed(2)))));
const { cands } = await reconstruct(M, d, { onStep: s => console.log('·', s) });
for (const c of cands.slice(0, 3)) { console.log('==', c.name, (c.score*100).toFixed(1), c.error||''); console.log(JSON.stringify(c.ops.slice(-3).map(({poly,...o})=>o))); console.log(diffText(c.cmp?.diffs||[], 10)); }
