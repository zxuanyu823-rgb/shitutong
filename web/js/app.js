// 视图通 · 主程序
import { $, esc } from './util.js';
import { MODELS, CUSTOM, getModel } from './models.js';
import { buildMesh, analyze, queryLineAt, pickFace, findFace, findCurve, VIEWS, VIEW_KEYS } from './engine.js';
import { drawingSVG, highlightSVG, hitTest, toPaper } from './views2d.js';
import { Viewer3D } from './viewer3d.js';
import { describeCurve, describeFace, describeLine, whyHidden } from './tutor.js';
import { Agent } from './agent.js';
import { KB, srcText } from './knowledge.js';
import { resetStats } from './exercise.js';
import { ModelEditor, isEditRequest } from './model-editor.js';
import { ProjectStore } from './projects.js';
import { initMobile } from './mobile.js';
import { projectMethods } from './project-ui.js';
import { practiceMethods } from './practice-ui.js';
import { reportMethods } from './report-ui.js';
import { initBackground, initRipples, finishSplash, initFontScale } from './theme.js';
import { PRESETS } from './providers.js';
import { loadPending } from './native.js';



class App {
  get activeModel() { return this.viewer?.model || this.model; }

  async init() {
    this.server = await fetch('api/config', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (this.server?.loginRequired && !this.server.loggedIn) await this.login();
    // 题库网格已预先算好（tools/build-meshes.mjs）；不在其中的模型才现场用 Manifold 计算
    this.meshes = await fetch('data/meshes.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
    this.cache = new Map();
    this.selection = {}; this.cons = true; this.mode = 'learn';
    this.viewer = new Viewer3D($('#stage3d'), { onPick: h => this.on3DPick(h) });
    this.agent = new Agent(this);
    this.editor = new ModelEditor(this);
    this.projects = new ProjectStore(); this.currentProject = null; this.projectDirty = false;
    this.modelProjects = new Map(); this.contextRevision = 0;
    this.bindUI();
    initMobile(this);
    this.renderModelSelect();
    const start = new URLSearchParams(location.search).get('m') || 'slot-block';
    this.loadModel(getModel(start) ? start : 'slot-block');
    this.updateAIStatus();
    await finishSplash();
    this.say('bot', `你好，我是视图通。三维模型与三视图可以对照查看，点选时会同步高亮。\n\n现在打开的是「${this.model.def.name}」：${this.model.def.desc}\n本题重点：${this.model.def.points.join('；')}。\n\n可以先在三视图里点一条虚线，再问我“为什么是虚线”。也可以切到“修改模型”，直接告诉我哪里需要改。`);
    this.renderChips();
    // 安卓上网页在后台被系统回收后重新打开：有没做完的拍照建模就直接带用户回去接着做
    if (new URLSearchParams(location.search).has('recovered')) {
      history.replaceState(null, '', location.pathname);
      if (loadPending()) { await this.setMode('photo'); this.say('bot', '刚才 App 在后台时被系统回收了内存，拍照建模中断了。点“继续”可以从中断的地方接着做。'); }
    }
  }

  renderModelSelect() {
    const all = [...MODELS, ...CUSTOM];
    const levels = [...new Set(all.map(m => m.level))];
    $('#modelSel').innerHTML = levels.map(l => `<optgroup label="${l}">${all.filter(m => m.level === l).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</optgroup>`).join('');
    if (this.model) $('#modelSel').value = this.model.def.id;
  }
  addCustomModel(def, model) {
    const i = CUSTOM.findIndex(d => d.id === def.id);
    if (i >= 0) CUSTOM[i] = def; else CUSTOM.push(def);
    if (model) this.cache.set(def.id, { ...model, def });
    if (def.level === '拍照建模' && this.recon?.drawing) this.modelProjects.set(def.id, this.recon.captureProject());
    this.renderModelSelect();
  }

  async setMode(mode) {
    const previousMode = this.mode;
    try { this.flushPendingSave?.(); } catch (e) { console.warn(e); }
    // 离开拍照建模时停止后台流程；这里出错也不能挡住切换
    if (this.mode === 'photo' && mode !== 'photo' && this.recon) { try { this.recon.stopAutomaticWork(); } catch (e) { console.warn(e); } }
    if (this.mode !== mode) this.editor?.invalidate();
    this.mode = mode;
    document.querySelectorAll('#modeSeg button').forEach(x => x.classList.toggle('on', x.dataset.mode === mode));
    const photo = mode === 'photo';
    document.querySelector('.pane-2d').hidden = photo;
    $('#recon').hidden = !photo;
    if (photo) {
      this.exercise = null; this.stopUnfold();
      if (!this.recon) {
        const { ReconPanel } = await import('./recon/ui.js');
        this.recon = new ReconPanel(this);
        this.say('bot', '拍照建模：拍一道三视图题，我会识别图线，用长对正、高平齐、宽相等纠正读数误差，重建三维形体，再反算三视图和照片逐线比对。只给两个视图的补图题，会把第三个视图补出来。\n\n没有配置视觉模型时，可以先点“示例题”体验后面的流程。');
      }
      if (this.recon.cur?._model) {
        const savedHistory = this.recon.editHistory;
        const committed = savedHistory?.entries?.[savedHistory.index];
        const candidate = committed ? this.recon.cands.find(c => JSON.stringify(c.ops) === JSON.stringify(committed.ops)) || this.recon.cur : this.recon.cur;
        await this.recon.show(candidate);
        if (savedHistory?.entries?.length) this.editor.restore(savedHistory);
      }
      this.refreshMobile?.();
      return;
    }
    // 回到题库模型
    if (this.viewer.model !== this.model) { this.viewer.setModel(this.model); this.selection = {}; this.drawSheet(); }
    if (previousMode === 'photo' || this.editor.source !== 'model') this.editor?.attach(this.model, 'model');
    else { this.editor.before = false; this.editor.sync(); }
    this.currentProject = this.modelProjects.get(this.model.def.id) || null;
    this.contextRevision++; this.agent.history = [];
    if (mode === 'practice') this.startExercise();
    else { this.exercise = null; this.drawSheet(); }
    this.refreshMobile?.();
  }

  login() {
    return new Promise(resolve => {
      $('#login').hidden = false;
      $('#loginForm').onsubmit = async e => {
        e.preventDefault();
        const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ user: $('#loginUser').value.trim(), pass: $('#loginPass').value }) });
        if (r.ok) { $('#login').hidden = true; this.server.loggedIn = true; resolve(); }
        else $('#loginErr').textContent = '账号或密码不对';
      };
    });
  }

  async manifold() {
    if (!this._manifold) this._manifold = import('../vendor/manifold.js').then(({ default: Module }) => Module()).then(m => { m.setup(); this.M = m; return m; }).catch(e => { this._manifold = null; throw e; });
    return this._manifold;
  }
  rawMesh(def) {
    const m = this.meshes[def.id];
    if (m) {
      const pos = [], tris = [];
      for (let i = 0; i < m.pos.length; i += 3) pos.push([m.pos[i], m.pos[i + 1], m.pos[i + 2]]);
      for (let i = 0; i < m.tris.length; i += 3) tris.push([m.tris[i], m.tris[i + 1], m.tris[i + 2]]);
      return { pos, tris };
    }
    return buildMesh(this.M, def);
  }
  loadModel(id) {
    this.flushPendingSave?.();
    if (this.mode === 'photo') this.setMode('learn');
    const def = getModel(id); if (!def) return false;
    if (!this.meshes[id] && !this.M) { this.manifold().then(() => this.loadModel(id)); return true; }
    if (!this.cache.has(id)) this.cache.set(id, analyze(def, this.rawMesh(def)));
    this.model = this.cache.get(id);
    $('#modelSel').value = id;
    this.exercise = null; this.selection = {};
    this.unfoldOn = false; $('#unfoldBtn').classList.remove('on');
    this.viewer.setModel(this.model);
    this.setViewBtn('iso');
    this.drawSheet();
    this.showInfo(null);
    this.editor?.attach(this.model, 'model');
    this.currentProject = this.modelProjects.get(id) || null;
    this.contextRevision++; this.agent.history = [];
    this.projectDirty = false;
    const u = new URL(location.href); u.searchParams.set('m', id); history.replaceState(null, '', u);
    return true;
  }

  onReconStart() {
    this.flushPendingSave?.();
    this.editor?.invalidate(); this.contextRevision++;
    this.selection = {}; this.agent.history = [];
  }
  onPreviewModel(model) {
    this.selection = {}; this.exercise = null; this.contextRevision++; this.agent.history = [];
    this.viewer.setSelection({});
    this.drawSheet(); this.showInfo(null);
    if (!this.editor.applying) {
      const savedHistory = this.recon.editHistory;
      this.editor.attach(model, 'photo');
      if (savedHistory?.entries?.length) {
        const current = savedHistory.entries[savedHistory.index];
        if (JSON.stringify(current?.ops) === JSON.stringify(model.def.ops)) this.editor.restore(savedHistory);
      }
    }
    this.refreshMobile?.();
  }
  displayEditedModel(model, { preview = false } = {}) {
    if (!preview) {
      this.model = model;
      if (!MODELS.some(d => d.id === model.def.id)) this.addCustomModel(model.def, model);
      if (this.currentProject) this.modelProjects.set(model.def.id, this.currentProject);
    }
    this.exercise = null; this.selection = {}; this.contextRevision++; this.agent.history = [];
    this.viewer.setModel(model); this.drawSheet(); this.showInfo(null); this.setViewBtn('iso');
    $('#modelSel').value = this.model.def.id;
    this.refreshMobile?.();
  }

  // ---------- 图纸 ----------
  drawSheet(opts = {}) {
    const svg = $('#drawing');
    const model = this.activeModel;
    const d = drawingSVG(model, opts);
    this.lay = d.lay;
    svg.setAttribute('viewBox', d.viewBox);
    svg.innerHTML = `<g id="base">${d.body}</g><g id="hover"></g><g id="hl"></g><g id="quiz"></g>`;
    const [bmin, bmax] = model.bbox;
    const dims = [0, 1, 2].map(k => +(bmax[k] - bmin[k]).toFixed(1));
    $('#titleblock').innerHTML = `<div>${esc(model.def.name)}</div><div>${dims.join('×')} mm</div><div>第一角画法</div>`;
    this.renderHL();
  }
  renderHL() {
    const sel = this.selection || {};
    const model = this.activeModel;
    let pts;
    if (!(sel.curves || []).some(id => id.startsWith('E')) && (sel.faces || []).length) {
      pts = [];
      for (const fid of sel.faces) { const f = findFace(model, fid); if (!f) continue; for (const cid of f.curves) { const c = findCurve(model, cid); if (c?.straight) pts.push(...c.ends); } }
      const uniq = []; for (const p of pts) if (!uniq.some(q => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-3)) uniq.push(p);
      pts = uniq.slice(0, 8);
    }
    if ($('#hl')) $('#hl').innerHTML = highlightSVG(model, this.lay, sel, { construction: this.cons, points: pts });
  }
  svgPoint(e) {
    const svg = $('#drawing'); const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(svg.getScreenCTM().inverse()); return [q.x, q.y];
  }

  // ---------- 选择 ----------
  select(sel, { keepFrom2d = false } = {}) {
    const from2d = keepFrom2d ? this.selection.from2d : sel.from2d;
    this.selection = { curves: sel.curves || [], faces: sel.faces || [], occluders: sel.occluders || [], from2d };
    this.viewer.setSelection(this.selection);
    this.renderHL();
  }

  on2DClick(e) {
    const P = this.svgPoint(e);
    const hit = hitTest(this.activeModel, this.lay, P);
    if (this.exercise?.type === 'error' && !this.exercise.done) {
      this.answerExercise(hit ? { view: hit.view, uv: hit.uv } : { view: null, uv: [0, 0] });
      return;
    }
    if (!hit) { this.select({}); this.showInfo(null); return; }
    const d = describeLine(this.activeModel, hit.view, hit.uv);
    if (d) {
      this.select({ curves: d.curves, faces: d.faces, from2d: hit });
      this.showInfo({ title: d.title, tag: VIEWS[hit.view].name, lines: d.lines.slice(1), hidden: !d.query.visible, view: hit.view, srcs: d.curves });
      return;
    }
    const order = pickFace(this.activeModel, hit.view, hit.uv);
    if (order && order.length) {
      const f = this.activeModel.faces[order[0]];
      this.select({ faces: [f.id], from2d: hit });
      const df = describeFace(this.activeModel, f.id);
      this.showInfo({ title: `线框 → ${f.id} ${f.label}`, tag: VIEWS[hit.view].name, lines: [`${VIEWS[hit.view].name}中这个线框是 ${f.name}在该方向上看到的投影。`, ...df.lines.slice(1)] });
    } else { this.select({}); this.showInfo(null); }
  }
  on2DHover(e) {
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      const P = this.svgPoint(e);
      const hit = hitTest(this.activeModel, this.lay, P);
      let out = '';
      if (hit) {
        const q = queryLineAt(this.activeModel, hit.view, hit.uv);
        if (q) for (const p of this.activeModel.views[hit.view].pieces) if (q.sources.includes(p.src)) {
          const A = toPaper(this.lay, hit.view, p.a), B = toPaper(this.lay, hit.view, p.b);
          out += `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" class="hover"/>`;
        }
      }
      $('#hover').innerHTML = out;
    });
  }
  on3DPick(h) {
    if (this.exercise?.type === 'match' && !this.exercise.done) { if (h) this.answerExercise(h); return; }
    if (!h) { this.select({}); this.showInfo(null); return; }
    const model = this.activeModel;
    if (h.type === 'curve') {
      this.select({ curves: [h.id] });
      const d = describeCurve(model, h.id);
      if (!d) return;
      const hidView = VIEW_KEYS.find(v => whyHidden(model, v, h.id));
      this.showInfo({ title: d.title, tag: '三维', lines: d.lines, hidden: !!hidView, view: hidView, srcs: [h.id] });
    } else {
      this.select({ faces: [h.id] });
      const d = describeFace(model, h.id);
      if (!d) return;
      this.showInfo({ title: d.title, tag: '三维', lines: d.lines });
    }
  }

  showInfo(info) {
    const el = $('#info');
    if (!info) { el.innerHTML = '<div class="info-empty">在三视图里点一条线或一个线框，或在三维模型上点一条棱、一个面，这里会说明它们的对应关系。</div>'; return; }
    let acts = '';
    if (info.hidden) acts += `<button data-act="why">为什么是虚线？</button>`;
    acts += `<button data-act="ask">让助教讲讲</button>`;
    el.innerHTML = `<h4>${esc(info.title)}<span class="tag">${esc(info.tag)}</span></h4>${info.lines.map(l => `<p>${esc(l)}</p>`).join('')}<div class="acts">${acts}</div>`;
    el.querySelector('[data-act="why"]')?.addEventListener('click', () => this.ask('为什么这里是虚线？'));
    el.querySelector('[data-act="ask"]')?.addEventListener('click', () => this.ask('讲讲我选中的这个元素'));
  }

  setXray(on) { this.xray = on; this.viewer.setXray(on); $('#xrayBtn').classList.toggle('on', on); this.viewer.setSelection(this.selection); }
  setViewBtn(v) { document.querySelectorAll('#viewBtns button').forEach(b => b.classList.toggle('on', b.dataset.view === v)); }
  playUnfold() {
    this.unfoldOn = true; $('#unfoldBtn').classList.add('on');
    // 用三维视图里当前显示的模型（拍照建模时是重建的候选，不一定是题库模型）
    const m = this.viewer.model || this.model;
    this.viewer.showUnfold(true, m);
    setTimeout(() => this.viewer.playUnfold(true), 900);
    this.setViewBtn('');
  }
  stopUnfold() { this.unfoldOn = false; $('#unfoldBtn').classList.remove('on'); this.viewer.showUnfold(false); this.setViewBtn('iso'); }

  say(kind, text, opt = {}) {
    const el = document.createElement('div');
    el.className = 'msg ' + ({ bot: 'bot', user: 'user', ex: 'bot ex', ok: 'bot ok', bad: 'bot bad', typing: 'bot typing' }[kind]);
    let body = esc(text).replace(/【(K\d\d)】/g, (m, k) => { const e = KB.find(x => x.id === k); return e ? `<span class="cite" title="${esc(e.title + '｜' + srcText(e))}">${k}</span>` : m; });
    el.innerHTML = (opt.html || '') + body + (opt.after || '');
    if (opt.cites?.length) {
      const refs = opt.cites.map(k => KB.find(x => x.id === k)).filter(Boolean);
      if (refs.length) el.innerHTML += `<div class="refs">依据：${refs.map(e => `${e.id} ${esc(e.title)}`).join('；')}</div>`;
    }
    $('#msgs').appendChild(el); $('#msgs').scrollTop = 1e9;
    return el;
  }
  async ask(text) {
    if (!text.trim()) return;
    if (this.sending) return;
    const edit = this.chatIntent === 'edit' || isEditRequest(text);
    if (edit) this.setChatIntent('edit');
    this.say('user', text);
    this.openChat?.();
    this.sending = true;
    const send = $('#askForm button[type="submit"]'); send.disabled = true;
    const t = this.say('typing', edit ? '正在处理模型修改…' : '思考中…');
    try {
      let r;
      if (edit && /^(撤销|撤回|撤销修改|上一步|恢复上一版)[。！!\s]*$/.test(text)) { await this.editor.travel(-1); r = { text: '已显示可恢复的上一版本。' }; }
      else if (edit && /^(重做|恢复下一版|恢复修改)[。！!\s]*$/.test(text)) { await this.editor.travel(1); r = { text: '已显示可恢复的下一版本。' }; }
      else r = edit ? await this.editor.edit(text) : await this.agent.ask(text);
      this.say('bot', r.text, { cites: r.cites });
      if (r.edited) this.showMobileView?.('model');
    } catch (e) { this.say('bot', `这次操作未完成：${e.message}`); }
    finally { t.remove(); this.sending = false; send.disabled = false; }
  }
  showLinks(rs) {
    if (!rs || !rs.length) return;
    const el = document.createElement('div');
    el.className = 'msg bot links';
    el.innerHTML = `<div class="ex-type">相关例题与资料</div>` + rs.slice(0, 6).map(r => `<a href="${esc(r.url)}" target="_blank" rel="noopener"><b>${esc(r.title || r.url)}</b><span>${esc(r.site || new URL(r.url).hostname)}</span>${r.snippet ? `<p>${esc(r.snippet.slice(0, 90))}${r.snippet.length > 90 ? '…' : ''}</p>` : ''}</a>`).join('');
    $('#msgs').appendChild(el); $('#msgs').scrollTop = 1e9;
  }
  renderChips() {
    const editing = this.chatIntent === 'edit';
    const chips = editing ? ['这个孔应该贯通', '右边少了一级台阶', '这个槽的方向反了'] : ['为什么这里是虚线？', '这条线对应哪里？', '演示三视图是怎么来的', '给我出一道题', '讲讲长对正、高平齐、宽相等', '搜相似例题'];
    $('#chips').innerHTML = chips.map(c => `<button>${c}</button>`).join('');
    $('#chips').querySelectorAll('button').forEach(b => b.onclick = () => {
      if (editing) { $('#askInput').value = b.textContent; $('#askInput').focus(); }
      else this.ask(b.textContent);
    });
  }
  updateAIStatus() {
    const mode = this.agent.mode;
    const label = mode === 'offline' ? '离线讲解' : mode === 'server' ? '大模型 · 已连接' : '大模型 · 本机配置';
    $('#aiChip').textContent = label; $('#aiChip').classList.toggle('live', mode !== 'offline');
    $('#chatMode').textContent = mode === 'offline' ? '离线讲解（规则 + 几何计算）' : '大模型 + 工具调用';
  }

  bindUI() {
    $('#modelSel').onchange = e => { if (this.mode === 'photo') this.setMode('learn'); this.loadModel(e.target.value); const d = this.model.def; this.say('bot', `换成「${d.name}」（${d.level}）。${d.desc}\n本题重点：${d.points.join('；')}。`); if (this.mode === 'practice') this.startExercise(); };
    document.querySelectorAll('#viewBtns button').forEach(b => b.onclick = () => { if (this.unfoldOn) this.stopUnfold(); this.viewer.setView(b.dataset.view); this.setViewBtn(b.dataset.view); });
    $('#xrayBtn').onclick = () => this.setXray(!this.xray);
    $('#unfoldBtn').onclick = () => this.unfoldOn ? this.stopUnfold() : this.playUnfold();
    $('#consBtn').onclick = () => { this.cons = !this.cons; $('#consBtn').classList.toggle('on', this.cons); this.renderHL(); };
    const svg = $('#drawing');
    svg.addEventListener('click', e => this.on2DClick(e));
    svg.addEventListener('mousemove', e => this.on2DHover(e));
    svg.addEventListener('mouseleave', () => { $('#hover').innerHTML = ''; });
    document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => this.setMode(b.dataset.mode));
    $('#askForm').onsubmit = e => { e.preventDefault(); if (this.sending) return; const v = $('#askInput').value; $('#askInput').value = ''; this.ask(v); };
    $('#askInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#askForm').requestSubmit(); } });
    // 设置
    $('#settingsBtn').onclick = () => {
      const c = this.agent.cfg;
      $('#cfgPreset').value = c.preset || 'deepseek';
      $('#cfgBase').value = c.base || PRESETS[$('#cfgPreset').value].base;
      $('#cfgModel').value = c.model || PRESETS[$('#cfgPreset').value].model;
      $('#cfgKey').value = c.key || '';
      $('#cfgVision').value = c.vision ?? PRESETS[$('#cfgPreset').value].vision;
      $('#cfgTavily').value = c.tavily || '';
      $('#cfgVisionPreset').value = c.visionPreset || 'same';
      $('#cfgVisionBase').value = c.visionBase || '';
      $('#cfgVisionKey').value = c.visionKey || '';
      $('#visionExtra').hidden = $('#cfgVisionPreset').value === 'same';
      $('#cfgPhotoMode').value = c.photoMode || 'fast';
      $('#cfgEffort').value = c.effort || 'high';
      $('#serverNote').style.display = this.server?.llm ? 'block' : 'none';
      $('#settingsDlg').showModal();
    };
    $('#aiChip').onclick = () => $('#settingsBtn').click();
    $('#cfgPreset').onchange = e => { const p = PRESETS[e.target.value]; $('#cfgBase').value = p.base; $('#cfgModel').value = p.model; if ($('#cfgVisionPreset').value === 'same') $('#cfgVision').value = p.vision; };
    $('#cfgVisionPreset').onchange = e => {
      const k = e.target.value, same = k === 'same';
      $('#visionExtra').hidden = same;
      const p = PRESETS[same ? $('#cfgPreset').value : k];
      if (!same) $('#cfgVisionBase').value = p.base;
      $('#cfgVision').value = p.vision;
    };
    $('#settingsDlg').addEventListener('close', () => {
      const v = $('#settingsDlg').returnValue;
      if (v === 'ok') this.agent.saveCfg({ preset: $('#cfgPreset').value, base: $('#cfgBase').value.trim(), model: $('#cfgModel').value.trim(), key: $('#cfgKey').value.trim(), vision: $('#cfgVision').value.trim(), tavily: $('#cfgTavily').value.trim(), visionPreset: $('#cfgVisionPreset').value, visionBase: $('#cfgVisionBase').value.trim(), visionKey: $('#cfgVisionKey').value.trim(), photoMode: $('#cfgPhotoMode').value, effort: $('#cfgEffort').value });
      if (v === 'clear') this.agent.saveCfg({});
      this.updateAIStatus();
    });
    $('#reportBtn').onclick = () => this.showReport();
    $('#reportClose').onclick = () => $('#reportDlg').close();
    $('#reportReset').onclick = () => { resetStats(); this.showReport(); };
    $('#reportExport').onclick = () => this.exportCSV();
    $('#chatIntent').addEventListener('chatintentchange', () => { this.renderChips(); this.editor.sync(); });
    $('#editUndo').onclick = () => this.editor.travel(-1);
    $('#editRedo').onclick = () => this.editor.travel(1);
    $('#editBefore').onclick = () => this.editor.preview(true).catch(e => this.editor.setStatus(e.message, 'error'));
    $('#editAfter').onclick = () => this.editor.preview(false).catch(e => this.editor.setStatus(e.message, 'error'));
    $('#editSave').onclick = () => this.saveProject();
    $('#projectsBtn').onclick = () => this.showProjects();
    $('#projectClose').onclick = () => $('#projectsDlg').close();
    $('#projectSaveCurrent').onclick = async () => { const saved = await this.saveProject({ title: $('#projectName').value }); if (saved) await this.showProjects(); };
  }
}

Object.assign(App.prototype, projectMethods, practiceMethods, reportMethods);

initBackground();
initFontScale();
initRipples();
const app = new App();
window.stt = app;
app.init().catch(e => { console.error(e); $('#loading').innerHTML = `<p>加载失败：${esc(e.message || e)}</p>`; });
