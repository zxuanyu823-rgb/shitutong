// 对话改模型：只接受经过验证的形体参数，先生成完整实体，再发布新版本。
import { $, clone } from './util.js';
import { buildMesh, analyze, summarize } from './engine.js';
import { selectionFacts } from './tutor.js';
import { DSL_DOC, drawingText, compare } from './recon/reconstruct.js';
import { drawingSVG } from './views2d.js';
import { parseEditResponse, validateOps } from './edit-schema.js';
import { svgToPNG } from './image.js';
import { holdAwake } from './native.js';

const cleanOps = ops => ops.map(({ vol, ...op }) => clone(op));

export function isEditRequest(text) {
  return /(?:修改|改一下|改成|改为|改掉|改大|改小|加大|缩小|扩大|缩窄|加宽|加高|降低|打穿|贯穿|货不对版|生成得不对|模型不对|重新建模)/.test(text)
    || /(?:孔|槽|台阶|底板|肋板|斜面|凸台|模型).{0,16}(?:少了|多了|开反|位置不对|应该|应当|太大|太小|太高|太低|太厚|太薄)/.test(text)
    || /(?:增加|添加|去掉|移除|补上|挖一个|开一个|移动).{0,12}(?:孔|槽|台阶|底板|肋板|斜面|凸台)/.test(text);
}

export function editPrompt({ model, selection, drawing, messages, request, imageLabels, camera }) {
  return [
    '请按学生的反馈修改当前三维实体。用户描述的修正优先于自动识图结果；保持未提及的结构、坐标和尺寸。',
    '返回完整的 ops 操作序列，不是增量补丁。不要通过改线型来假装修好了实体。不要输出代码、Markdown 或工具调用。',
    '方向以模型坐标为准：X向右、Y向后、Z向上。屏幕左右会随旋转变化，结合选中部位、当前相机与视图判断；无法定位或关键尺寸不确定时，提出一个具体问题，不要随意猜测。',
    '可以利用已有尺寸确定通孔深度、台阶边界；用户未要求改变的尺寸沿用当前参数。不能表达的曲面等结构请说明需要补充的条件。',
    '若可修改，只输出 {"kind":"edit","ops":[完整操作],"explain":"简短说明实际修改的位置和尺寸"}。',
    '若需澄清，只输出 {"kind":"clarify","question":"一个具体且易回答的问题"}，不要包含 ops。',
    '最多48个操作，拉伸轮廓与凸包最多64点，坐标绝对值不超过10000。首个操作必须add，切平面只能sub。',
    '【形体参数格式】', DSL_DOC,
    '【当前实体】', summarize(model),
    '【当前完整操作】', JSON.stringify({ ops: cleanOps(model.def.ops) }),
    '【选中的部位】', selectionFacts(model, selection || {}),
    '【观察方向】', JSON.stringify(camera),
    ...(imageLabels.length ? ['【附图顺序】', imageLabels.join('；')] : []),
    ...(drawing ? ['【原题识别线条，仅供参考，可能有误】', drawingText(drawing)] : []),
    '【本模型的最近修改对话】', messages.slice(-8).map(m => `${m.role === 'user' ? '学生' : '助手'}：${m.content}`).join('\n') || '无',
    '【这一次要求】', request,
  ].join('\n\n');
}

async function svgPNG(model) {
  const { body, viewBox } = drawingSVG(model);
  const svg = `<svg style="--ink:#18232d;--center:#697785" xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="1000" height="760"><rect x="-10000" y="-10000" width="20000" height="20000" fill="white"/><style>.vis{stroke:#18232d;stroke-width:.6;fill:none}.hid{stroke:#4c5966;stroke-width:.3;stroke-dasharray:2.6 1.3;fill:none}.cen{stroke:#697785;stroke-width:.2;stroke-dasharray:5 1 1 1;fill:none}.vlabel{fill:#26313c;font-size:4px}.miter{stroke:#aab2b9;stroke-width:.2;fill:none}</style>${body}</svg>`;
  return svgToPNG(svg, 1000, 760);
}

export class ModelEditor {
  constructor(app) {
    this.app = app; this.entries = []; this.index = -1; this.messages = [];
    this.epoch = 0; this.busy = false; this.applying = false; this.before = false;
  }
  get current() { return this.entries[this.index]; }
  get sourcePhoto() { return this.source === 'photo' && this.app.mode === 'photo' && !!this.app.recon?.drawing; }
  get referenceDrawing() { return this.sourcePhoto ? this.app.recon.drawing : this.app.currentProject?.drawing || null; }
  get referencePhoto() { return this.sourcePhoto ? this.app.recon.photo : this.app.currentProject?.photo || null; }

  invalidate() {
    this.epoch++; this.controller?.abort(); this.controller = null;
  }
  attach(model, source = 'model') {
    this.invalidate(); this.source = source; this.before = false; this.messages = [];
    this.entries = model?.def?.ops ? [{ name: model.def.name, ops: cleanOps(model.def.ops), explain: '原始版本', request: '', createdAt: Date.now(), _model: model }] : [];
    this.index = this.entries.length - 1;
    this.setStatus('直接描述哪里不对，也可以先点选模型上的面或棱。');
    this.sync();
  }
  exportState() {
    return { entries: this.entries.map(({ _model, ...e }) => clone(e)), index: this.index, messages: clone(this.messages.slice(-20)), source: this.source };
  }
  restore(state) {
    if (!state?.entries?.length) return;
    const entries = state.entries.slice(-20).map(e => ({ ...e, ops: validateOps(e.ops) }));
    this.invalidate(); this.entries = entries; this.index = Math.min(Math.max(0, state.index || 0), entries.length - 1);
    this.messages = (state.messages || []).filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').slice(-20);
    this.source = state.source === 'photo' ? 'photo' : 'model'; this.before = false;
    this.current._model = this.app.activeModel;
    this.sync();
  }
  setStatus(text, state = '') {
    const el = $('#editStatus'); if (!el) return;
    el.textContent = text; el.dataset.state = state;
  }
  sync() {
    const has = this.index >= 0;
    if ($('#editUndo')) $('#editUndo').disabled = this.busy || this.index <= 0;
    if ($('#editRedo')) $('#editRedo').disabled = this.busy || this.index >= this.entries.length - 1;
    if ($('#editBefore')) $('#editBefore').disabled = this.busy || this.index <= 0;
    if ($('#editAfter')) $('#editAfter').disabled = this.busy || !has;
    if ($('#editSave')) $('#editSave').disabled = this.busy || !has;
    $('#editBefore')?.classList.toggle('on', this.before);
    $('#editAfter')?.classList.toggle('on', !this.before);
    $('#editBefore')?.setAttribute('aria-pressed', String(this.before));
    $('#editAfter')?.setAttribute('aria-pressed', String(!this.before));
    if ($('#editVersion')) $('#editVersion').textContent = has ? `${this.before ? '预览修改前 · ' : ''}版本 ${this.index + 1} / ${this.entries.length}` : '尚无模型';
    if (this.sourcePhoto) this.app.recon.editHistory = this.exportState();
  }
  async modelFor(entry) {
    if (!entry._model) {
      const M = await this.app.manifold();
      const def = { id: 'edit-version', name: entry.name, desc: entry.explain || '', points: ['检查修改后的结构和三视图'], level: '我的模型', ops: validateOps(entry.ops) };
      entry._model = analyze(def, buildMesh(M, def));
    }
    return entry._model;
  }
  async display(entry, { preview = false, isCurrent = () => true } = {}) {
    const view = this.app.viewer.rememberView?.();
    const model = await this.modelFor(entry);
    if (!isCurrent()) throw new DOMException('当前模型已切换', 'AbortError');
    this.applying = true;
    try {
      if (this.sourcePhoto) {
        const cands = this.app.recon.cands;
        let candidate = cands.find(c => JSON.stringify(cleanOps(c.ops)) === JSON.stringify(entry.ops));
        if (!candidate) candidate = await this.app.recon.applyEditedModel({ ops: entry.ops, explain: entry.explain, request: entry.request, name: entry.name, source: 'user-edit', isCurrent }, model);
        else await this.app.recon.show(candidate, { isCurrent });
      } else this.app.displayEditedModel(model, { preview });
      if (view && isCurrent()) this.app.viewer.restoreView(view);
    } finally { this.applying = false; }
  }
  async travel(delta) {
    if (this.busy) return;
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length) return;
    const previous = this.index;
    const epoch = ++this.epoch;
    this.busy = true; this.sync();
    let changed = false;
    try {
      await this.display(this.entries[next], { isCurrent: () => epoch === this.epoch });
      if (epoch !== this.epoch) return;
      this.index = next; this.before = false;
      this.messages = this.entries.slice(1, next + 1).flatMap(e => [{ role: 'user', content: e.request || '' }, { role: 'assistant', content: e.explain || '' }]);
      this.setStatus(delta < 0 ? '已撤销一次修改，可以继续修改或恢复。' : '已恢复下一版本。');
      changed = true;
    } catch (e) { if (epoch === this.epoch) { this.index = previous; this.setStatus(`版本恢复失败：${e.message}`, 'error'); } }
    finally { this.busy = false; this.sync(); if (changed) this.app.onProjectChange?.(); }
  }
  async preview(before) {
    if (this.busy || this.index < 0 || (before && this.index < 1)) return;
    const epoch = ++this.epoch;
    this.busy = true; this.sync();
    try {
      await this.display(this.entries[this.index - (before ? 1 : 0)], { preview: true, isCurrent: () => epoch === this.epoch });
      if (epoch !== this.epoch) return;
      this.before = before;
      this.setStatus(before ? '正在对比上一个版本。继续修改会以当前版本为基础。' : '正在显示当前版本。');
    } finally { this.busy = false; this.sync(); }
  }

  async edit(request) {
    if (this.busy) return { text: '上一处修改还在处理，请稍等。' };
    if (this.app.agent.mode === 'offline' && !this.app.agent.canSee) return { text: '对话改模型需要大模型接口。在“设置”里配置接口、模型名称和 API Key 后，就可以直接描述要改哪里。' };
    if (this.app.mode === 'photo' && !this.app.recon?.cur) return { text: '请先完成拍照重建，或点“示例题”生成一个模型，再告诉我哪里需要改。' };
    if (!this.current) this.attach(this.app.activeModel, this.app.mode === 'photo' ? 'photo' : 'model');
    if (!this.current) return { text: '请先选择一个模型，或完成拍照重建。' };
    if (this.before) await this.preview(false);
    if (this.sourcePhoto) this.app.recon.stopAutomaticWork();
    const epoch = ++this.epoch;
    const base = this.current, baseIndex = this.index;
    this.busy = true; this.controller = new AbortController(); this.sync();
    let committed = false;
    this.setStatus('正在理解修改要求…', 'busy');
    try {
      const model = await this.modelFor(base);
      const selection = clone(this.app.selection || {});
      const images = [], imageLabels = [];
      if (this.app.agent.canSee) {
        if (this.referencePhoto) { images.push(this.referencePhoto); imageLabels.push(`图${images.length}：原题照片，识图可能有误，以你的反馈为准`); }
        images.push(this.app.viewer.snapshot()); imageLabels.push(`图${images.length}：当前三维模型，橙色为选中的部位`);
        images.push(await svgPNG(model)); imageLabels.push(`图${images.length}：当前模型自动投影的三视图`);
      }
      const drawing = this.referenceDrawing;
      const prompt = editPrompt({ model, selection, drawing, messages: this.messages, request, imageLabels, camera: { position: this.app.viewer.camera.position.toArray(), target: this.app.viewer.controls.target.toArray(), up: this.app.viewer.camera.up.toArray() } });
      const release = holdAwake('视图通正在按你的描述修改模型…');
      let raw;
      try { raw = await this.app.agent.requestModelEdit(prompt, images, this.controller.signal); }
      finally { release({ notify: { title: '视图通', text: '模型修改的回复到了，点开查看' } }); }
      if (epoch !== this.epoch) return { text: '你已经切换了模型，本次修改已取消。' };
      const result = parseEditResponse(raw);
      if (result.kind === 'clarify') {
        this.messages.push({ role: 'user', content: request }, { role: 'assistant', content: result.question });
        this.setStatus('需要确认一个细节，直接在下方回复即可。'); this.sync();
        return { text: result.question };
      }
      if (JSON.stringify(result.ops) === JSON.stringify(base.ops)) {
        this.setStatus('AI 返回的结构与当前版本相同，请说明需要改变的部位。');
        return { text: '这次返回的结构没有变化。可以点选要改的面或棱，再补充位置或尺寸。' };
      }
      this.setStatus('正在生成实体并更新三视图…', 'busy');
      await new Promise(resolve => setTimeout(resolve, 0));
      const M = await this.app.manifold();
      const def = { id: `edited-${Date.now().toString(36)}`, name: `${this.entries[0].name.replace(/ · 修改.*$/, '')} · 修改 ${baseIndex + 1}`, desc: result.explain || '根据你的反馈修改', points: ['对照题目检查修改后的结构', '点选棱或面查看投影关系'], level: '我的模型', ops: result.ops };
      const rawMesh = buildMesh(M, def);
      if (rawMesh.tris.length > 40000) throw new Error('这次修改生成的结构过于复杂，请分成更小的修改');
      const edited = analyze(def, rawMesh);
      if (!edited.bbox.flat().every(Number.isFinite) || !edited.faces.length) throw new Error('没有生成有效实体');
      if (epoch !== this.epoch) return { text: '你已经切换了模型，本次修改已取消。' };
      const entry = { ops: clone(result.ops), name: def.name, explain: def.desc, request, createdAt: Date.now(), _model: edited };
      await this.display(entry, { isCurrent: () => epoch === this.epoch });
      if (epoch !== this.epoch) return { text: '你已经切换了模型，本次修改已取消。' };
      this.entries = [...this.entries.slice(0, baseIndex + 1), entry].slice(-20);
      this.index = this.entries.length - 1; this.before = false;
      this.messages.push({ role: 'user', content: request }, { role: 'assistant', content: def.desc });
      this.messages = this.messages.slice(-20);
      let details = '';
      if (drawing) {
        const oldScore = compare(model, drawing, Math.max(0.8, drawing.tol * 0.7)).score;
        const newScore = compare(edited, drawing, Math.max(0.8, drawing.tol * 0.7)).score;
        details = `\n与原识图线条的吻合度：${(oldScore * 100).toFixed(1)}% → ${(newScore * 100).toFixed(1)}%。这衡量的是图线匹配，仍需对照题目检查。`;
      }
      this.setStatus(`已更新到版本 ${this.index + 1}。可对比修改前后，或继续描述下一处问题。`, 'success');
      this.sync(); committed = true;
      return { text: `模型已更新：${def.desc}${details}\n可以继续说哪里要改，也可以用“撤销”恢复上一版。`, edited: true };
    } catch (e) {
      if (epoch !== this.epoch || e.name === 'AbortError') return { text: '本次修改已取消，当前模型保留。' };
      this.setStatus(`修改未应用：${e.message}`, 'error');
      return { text: `这次修改没有应用，原模型已保留。${e.message}。可以补充具体位置或尺寸后再试。` };
    } finally { this.busy = false; this.controller = null; this.sync(); if (committed) this.app.onProjectChange?.(); }
  }
}
