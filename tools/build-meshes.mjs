// 预先把题库模型做成网格，网页加载更快；修改 web/js/models.js 后重新运行：
//   node tools/build-meshes.mjs
import Module from '../node_modules/manifold-3d/manifold.js';
import { MODELS } from '../web/js/models.js';
import { buildMesh } from '../web/js/engine.js';
import fs from 'node:fs';
const M = await Module(); M.setup();
const out = {};
for (const def of MODELS) {
  const { pos, tris } = buildMesh(M, def);
  out[def.id] = { pos: pos.flat(), tris: tris.flat() };
}
fs.writeFileSync(new URL('../web/data/meshes.json', import.meta.url), JSON.stringify(out));
console.log('ok', Object.keys(out).length, 'models', fs.statSync(new URL('../web/data/meshes.json', import.meta.url)).size, 'bytes');
