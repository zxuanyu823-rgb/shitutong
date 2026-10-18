// Model replies are data, never executable code. Validate the entire replacement
// operation list before allowing any of it to reach the geometry engine.
const COORD_LIMIT = 10000;
const MAX_OPS = 48;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function fail(path, message) {
  throw new Error(`${path}：${message}`);
}

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是对象');
}

function keys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, `不支持字段 ${key}`);
  }
}

function number(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '必须是有限数值');
  if (Math.abs(value) > COORD_LIMIT) fail(path, `绝对值不能超过 ${COORD_LIMIT}`);
  return Object.is(value, -0) ? 0 : value;
}

function vector(value, size, path) {
  if (!Array.isArray(value) || value.length !== size) fail(path, `必须是 ${size} 元坐标数组`);
  // Array.from also visits holes, so sparse arrays cannot bypass validation.
  return Array.from(value, (v, i) => number(v, `${path}[${i}]`));
}

function axial(value, path) {
  if (!['x', 'y', 'z'].includes(value.axis)) fail(path + '.axis', '必须是 x、y 或 z');
  const from = number(value.from, path + '.from');
  const to = number(value.to, path + '.to');
  if (!(from < to)) fail(path, 'from 必须小于 to');
  return { axis: value.axis, from, to };
}

const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function polygon(value, path) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 64) fail(path, '需要 3～64 个顶点');
  const pts = Array.from(value, (p, i) => vector(p, 2, `${path}[${i}]`));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const epsilon = scale * scale * 1e-10;
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (a[0] === b[0] && a[1] === b[1]) fail(path, '相邻顶点不能重合，末尾不需要重复首点');
    area2 += cross2(pts[0], a, b);
  }
  if (Math.abs(area2) <= epsilon) fail(path, '轮廓面积为零或退化');
  const onSegment = (p, a, b) => Math.abs(cross2(a, b, p)) <= epsilon &&
    p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    for (let j = i + 1; j < pts.length; j++) {
      if (j === i + 1 || (i === 0 && j === pts.length - 1)) continue;
      const c = pts[j], d = pts[(j + 1) % pts.length];
      const abC = cross2(a, b, c), abD = cross2(a, b, d);
      const cdA = cross2(c, d, a), cdB = cross2(c, d, b);
      if ((abC * abD < 0 && cdA * cdB < 0) ||
          onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d)) {
        fail(path, '轮廓不能自交或重复接触');
      }
    }
  }
  return pts;
}

function points2(value, path) {
  if (!Array.isArray(value) || value.length > 64) fail(path, '最多 64 个顶点');
  return Array.from(value, (p, i) => vector(p, 2, `${path}[${i}]`));
}

function circleList(value, path) {
  if (!Array.isArray(value) || !value.length || value.length > 16) fail(path, '需要 1～16 个圆');
  return Array.from(value, (q, i) => {
    const at = `${path}[${i}]`;
    const v = Array.isArray(q) ? vector(q, 3, at) : (record(q, at), keys(q, ['c', 'r'], at), [...vector(q.c, 2, at + '.c'), number(q.r, at + '.r')]);
    if (!(v[2] > 0)) fail(at, '半径必须大于 0');
    return v;
  });
}

function hullPoints(value, path) {
  if (!Array.isArray(value) || value.length < 4 || value.length > 64) fail(path, '需要 4～64 个顶点');
  const pts = Array.from(value, (p, i) => vector(p, 3, `${path}[${i}]`));
  const span = [0, 1, 2].map(k => Math.max(...pts.map(p => p[k])) - Math.min(...pts.map(p => p[k])));
  const epsilon = Math.max(...span) ** 3 * 1e-10;
  const difference = p => p.map((v, k) => v - pts[0][k]);
  let hasVolume = false;
  for (let i = 1; i < pts.length && !hasVolume; i++) {
    const a = difference(pts[i]);
    for (let j = i + 1; j < pts.length && !hasVolume; j++) {
      const b = difference(pts[j]);
      const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      for (let k = j + 1; k < pts.length; k++) {
        const c = difference(pts[k]);
        if (Math.abs(n[0] * c[0] + n[1] * c[1] + n[2] * c[2]) > epsilon) { hasVolume = true; break; }
      }
    }
  }
  if (!hasVolume) fail(path, '顶点必须构成有体积的凸包，不能全部共面');
  return pts;
}

export function validateOps(ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > MAX_OPS) fail('ops', `需要 1～${MAX_OPS} 个完整操作`);
  return Array.from(ops, (value, i) => {
    const path = `ops[${i}]`;
    record(value, path);
    if (!['add', 'sub', 'int'].includes(value.op)) fail(path + '.op', '必须是 add、sub 或 int');
    if (i === 0 && value.op !== 'add') fail(path, '首个操作必须为 add');
    const base = { op: value.op, type: value.type };
    switch (value.type) {
      case 'box': {
        keys(value, ['op', 'type', 'min', 'max'], path);
        const min = vector(value.min, 3, path + '.min'), max = vector(value.max, 3, path + '.max');
        if (min.some((v, k) => v >= max[k])) fail(path, '长方体每个方向的 max 必须大于 min');
        return { ...base, min, max };
      }
      case 'prism': {
        keys(value, ['op', 'type', 'axis', 'from', 'to', 'poly', 'circles'], path);
        if (value.circles == null) return { ...base, ...axial(value, path), poly: polygon(value.poly, path + '.poly') };
        // 带 circles：截面取顶点和圆的凸包（圆角板、与圆柱相切的板），顶点不必构成多边形
        const circles = circleList(value.circles, path + '.circles');
        const pts = value.poly == null ? [] : points2(value.poly, path + '.poly');
        if (pts.length + circles.length * 2 < 3) fail(path, '顶点和圆合起来不足以围成截面');
        return { ...base, ...axial(value, path), poly: pts, circles };
      }
      case 'cyl': {
        keys(value, ['op', 'type', 'axis', 'from', 'to', 'c', 'r'], path);
        const r = number(value.r, path + '.r');
        if (!(r > 0)) fail(path + '.r', '半径必须大于零');
        return { ...base, ...axial(value, path), c: vector(value.c, 2, path + '.c'), r };
      }
      case 'cut': {
        keys(value, ['op', 'type', 'p', 'n'], path);
        if (value.op !== 'sub') fail(path, '平面切割 cut 只能使用 sub');
        const p = vector(value.p, 3, path + '.p'), n = vector(value.n, 3, path + '.n');
        if (!n.some(v => v !== 0)) fail(path + '.n', '切割法向量不能为零');
        return { ...base, p, n };
      }
      case 'hull':
        keys(value, ['op', 'type', 'pts'], path);
        return { ...base, pts: hullPoints(value.pts, path + '.pts') };
      default:
        fail(path + '.type', '仅支持 box、prism、cyl、cut、hull；无法表达的修改应先询问用户');
    }
  });
}

export function parseEditResponse(text) {
  if (typeof text !== 'string' || !text.trim()) fail('回复', '内容为空');
  let source = text.trim();
  if (source.startsWith('```')) {
    const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(source);
    if (!fence) fail('回复', '需要一个完整的 JSON 代码块');
    source = fence[1].trim();
  }
  let value;
  try { value = JSON.parse(source); } catch { fail('回复', '不是有效的 JSON，请重新生成完整修改方案'); }
  record(value, '回复');
  const kind = own(value, 'kind') ? value.kind : own(value, 'question') ? 'clarify' : 'edit';
  if (kind === 'clarify') {
    keys(value, ['kind', 'question'], '回复');
    if (typeof value.question !== 'string' || !value.question.trim()) fail('question', '澄清问题不能为空');
    return { kind, question: value.question.trim() };
  }
  if (kind !== 'edit') fail('回复.kind', '必须是 edit 或 clarify');
  keys(value, ['kind', 'ops', 'explain'], '回复');
  if (own(value, 'explain') && typeof value.explain !== 'string') fail('explain', '必须是文字说明');
  return { kind, ops: validateOps(value.ops), explain: (value.explain || '').trim() };
}
