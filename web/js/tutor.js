// 视图通 · 讲解引擎
// 所有几何结论都由程序计算得出，再组织成自然语言；大模型只在此基础上组织讲解。
import { VIEWS, VIEW_KEYS, queryLineAt, occluderOf, findCurve, findFace, appearance } from './engine.js';

const VN = v => VIEWS[v].name;
const LOOK = { front: '从前向后', top: '从上向下', left: '从左向右' };

export function describeCurve(model, id) {
  const c = findCurve(model, id);
  if (!c) return null;
  if (c.isSil) {
    const f = model.faces[c.face];
    return { id, title: `${id} 转向轮廓线`, lines: [`${f.id} ${f.label}在${VN(c.view)}中的转向轮廓线：沿${LOOK[c.view]}看，圆柱面在这里由“朝向观察者”转为“背向观察者”，所以形成外形线。它只在${VN(c.view)}中出现，不是实体上的棱。`] };
  }
  const ap = appearance(model, id);
  const lines = [`${c.desc}。`, `它是 ${c.between}。`];
  for (const v of VIEW_KEYS) {
    const a = ap[v];
    let s;
    if (a.asPoint) s = `积聚为一个点（${c.lineKind === '曲线' ? '' : c.lineKind + '在该方向上投影成点'}）`;
    else if (a.hidLen > 0.05 && a.visLen > 0.05) s = '一部分可见画实线，一部分被挡画虚线';
    else if (a.hidLen > 0.05) {
      const occ = occluderOf(model, v, id);
      s = `被挡住，画细虚线${occ ? `（挡住它的是 ${occ.id} ${occ.label}）` : ''}`;
    } else s = '可见，画粗实线';
    lines.push(`${VN(v)}：${s}。`);
  }
  return { id, title: `${id} 棱线`, lines };
}

export function describeFace(model, id) {
  const f = findFace(model, id);
  if (!f) return null;
  const ap = appearance(model, id);
  const lines = [`${f.name}。`];
  for (const v of VIEW_KEYS) {
    const a = ap[v];
    let s;
    if (a.edgeOn) s = f.planar ? '面与观察方向平行，积聚成一条直线' : '圆柱面轴线与观察方向平行，积聚在圆周上';
    else if (f.planar && Math.abs(Math.abs(a.facing) - 1) < 1e-4) s = `反映实形（${a.visible ? '可见' : '不可见'}）`;
    else s = `是${f.planar ? '缩小的类似形' : '矩形线框，即圆柱面的非圆视图'}（${a.visible ? '可见' : '不可见'}）`;
    lines.push(`${VN(v)}：${s}。`);
  }
  return { id, title: `${f.id} ${f.label}`, lines };
}

// 2D 视图中点到某条线：它是谁的投影、为什么实/虚
export function describeLine(model, view, uv) {
  const q = queryLineAt(model, view, uv);
  if (!q) return null;
  const curves = q.sources.filter(s => s.startsWith('E'));
  const sils = q.sources.filter(s => s.startsWith('S'));
  const lines = [];
  lines.push(`这是${VN(view)}中的一条${q.visible ? '粗实线（可见轮廓线）' : '细虚线（不可见轮廓线）'}。`);
  const parts = [];
  if (q.faces.length) parts.push(`${q.faces.map(id => { const f = findFace(model, id); return `${id} ${f.label}`; }).join('、')} 的积聚投影`);
  if (curves.length) parts.push(`棱线 ${curves.join('、')} 的投影`);
  if (sils.length) parts.push(`圆柱面的转向轮廓线`);
  lines.push(`它同时是：${parts.join('；')}。` + (q.sources.length + q.faces.length > 1 ? '多个元素投影重合在同一条线上。' : ''));
  const occ = [];
  if (!q.visible) {
    for (const s of q.sources) { const o = occluderOf(model, view, s); if (o && !occ.includes(o.id)) occ.push(o.id); }
    if (occ.length) lines.push(`${LOOK[view]}看，它被 ${occ.map(id => `${id} ${findFace(model, id).label}`).join('、')} 挡住，所以画成细虚线。`);
  } else {
    const hiddenToo = q.sources.filter(s => q.sourceVis[s] === false);
    if (hiddenToo.length) lines.push(`其中 ${hiddenToo.join('、')} 本身被挡住，但它与可见线重合，按规定只画实线。`);
  }
  return { query: q, title: `${VN(view)}中的${q.visible ? '实线' : '虚线'}`, lines, occluders: occ, curves: q.sources, faces: q.faces };
}

export function whyHidden(model, view, srcId) {
  const occ = occluderOf(model, view, srcId);
  const c = findCurve(model, srcId);
  if (!occ) return null;
  const what = c && !c.isSil ? `${srcId}（${c.between}）` : srcId;
  return {
    text: `看${VN(view)}时，视线是${LOOK[view]}。${what} 位于 ${occ.id} ${occ.label} 的后面，中间隔着实体材料，视线到不了它，所以在${VN(view)}中画细虚线。依据：不可见轮廓线用细虚线表示（GB/T 4457.4）。`,
    occluder: occ.id,
  };
}

// 供大模型使用的“当前选中”事实
export function selectionFacts(model, sel) {
  if (!sel || (!sel.curves?.length && !sel.faces?.length)) return '用户当前没有选中任何元素。';
  const out = [];
  if (sel.from2d) {
    const d = describeLine(model, sel.from2d.view, sel.from2d.uv);
    if (d) out.push(`用户在${VN(sel.from2d.view)}中点了一条线。${d.lines.join('')}`);
    else out.push(`用户在${VN(sel.from2d.view)}中点了一个线框区域，对应面 ${sel.faces.join('、')}。`);
  }
  for (const id of sel.curves || []) if (id.startsWith('E')) { const d = describeCurve(model, id); if (d) out.push(d.lines.join('')); }
  for (const id of sel.faces || []) { const d = describeFace(model, id); if (d) out.push(d.lines.join('')); }
  return out.join('\n');
}
