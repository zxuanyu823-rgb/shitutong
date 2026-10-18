// 视图通 · 各模块共用的小工具（网页、后台线程都能用；$ 只在网页里调用）
export const VIEW_KEYS = ['front', 'top', 'left'];
export const VN = { front: '主视图', top: '俯视图', left: '左视图' };

export const $ = s => document.querySelector(s);
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const pct = x => (x * 100).toFixed(1) + '%';
export const r1 = x => Math.round(x * 10) / 10;
export const clone = v => (v == null ? null : JSON.parse(JSON.stringify(v)));

// 点到线段的距离（二维）
export function distPtSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// 从大模型的回答里取出 JSON：去掉思考过程、代码块标记，取第一个 { 到最后一个 }
export function extractJSON(text, what = '回答') {
  if (typeof text !== 'string') return text;
  const s = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error(`${what}里没有 JSON`);
  return JSON.parse(s.slice(i, j + 1));
}
