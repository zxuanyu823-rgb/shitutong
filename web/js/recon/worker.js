// 视图通 · 重建计算放在后台线程，界面不卡顿
import Module from '../../vendor/manifold.js';
import { reconstruct, evaluate, slimCand as slim } from './reconstruct.js';
import { buildFromParts, fillGaps } from './parts.js';

let M;
const ready = Module().then(m => { m.setup(); M = m; });

onmessage = async e => {
  const { id, cmd, drawing, ops, name, parts, budgetMs } = e.data;
  try {
    await ready;
    if (cmd === 'reconstruct') {
      const { cands } = await reconstruct(M, drawing, { onStep: s => postMessage({ id, step: s }) });
      postMessage({ id, done: true, cands: cands.map(slim) });
    } else if (cmd === 'parts') {
      const c = await buildFromParts(M, parts, drawing, { name, budgetMs, onStep: s => postMessage({ id, step: s }) });
      postMessage({ id, done: true, cand: slim(c) });
    } else if (cmd === 'polish') {
      postMessage({ id, done: true, cand: slim(fillGaps(M, evaluate(M, ops, drawing, name), drawing, { budgetMs })) });
    } else if (cmd === 'evaluate') {
      postMessage({ id, done: true, cand: slim(evaluate(M, ops, drawing, name)) });
    }
  } catch (err) {
    postMessage({ id, done: true, error: err.message || String(err) });
  }
};
