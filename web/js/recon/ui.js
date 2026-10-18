// 视图通 · 拍照建模面板
import { $, esc, VN, pct, distPtSeg } from '../util.js';
import { stepMethods, dur } from './steps.js';
import { fromVision, reconcile, parseVisionJSON, synthVision, arcPoints, circlePoints, VIEW_KEYS } from './drawing.js';
import { refinePrompt, parseOps, diffText } from './reconstruct.js';
import { alternativePrompt, selfCheckPrompt, verifyPrompt, refineImagePrompt } from './prompts.js';
import { partsPrompt, partsRefinePrompt, parseParts } from './parts.js';
import { loadInk, refineVision, reportText, normalizeBoxes, suspicious } from './cv.js';
import { holdAwake, savePending, loadPending, clearPending } from '../native.js';
import { layoutOf, toPaper, fromPaper, viewAtPaper, STYLE } from '../views2d.js';
import { buildMesh, analyze } from '../engine.js';
import { svgToPNG, shrinkImage } from '../image.js';
import { MODELS } from '../models.js';
import { normalizeProject, snapshotCandidate } from '../projects.js';


export class ReconPanel {
  constructor(app) {
    this.app = app; this.seq = 0; this.count = 0; this.cands = []; this.cur = null; this.state = {};
    this.pending = new Map();
    try { this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); }
    catch { this.noWorker = true; this.worker = { postMessage() {} }; }
    this.worker.onerror = () => { this.workerFailed = true; for (const [, p] of this.pending) p.reject(new Error('worker failed')); this.pending.clear(); };
    this.worker.onmessage = e => {
      const m = e.data, p = this.pending.get(m.id); if (!p) return;
      if (m.step) { p.onStep?.(m.step); return; }
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m);
    };
    this.bind();
    this.renderSteps({});
    this.showResume();
  }
  async call(cmd, data, onStep) {
    if (this.noWorker) return this.callLocal(cmd, data, onStep);
    try { return await this.callWorker(cmd, data, onStep); }
    catch (e) {
      // 个别手机的 WebView 不支持模块化后台线程，改在主线程计算
      if (!/worker|Worker|import|module/i.test(e.message || '') && !this.workerFailed) throw e;
      this.noWorker = true; return this.callLocal(cmd, data, onStep);
    }
  }
  async callLocal(cmd, data, onStep) {
    const { reconstruct, evaluate, slimCand: slim } = await import('./reconstruct.js');
    const M = await this.app.manifold();
    if (cmd === 'reconstruct') { const { cands } = await reconstruct(M, data.drawing, { onStep }); return { cands: cands.map(slim) }; }
    if (cmd === 'parts') { const { buildFromParts } = await import('./parts.js'); return { cand: slim(await buildFromParts(M, data.parts, data.drawing, { name: data.name, budgetMs: data.budgetMs, onStep })) }; }
    if (cmd === 'polish') { const { fillGaps } = await import('./parts.js'); return { cand: slim(fillGaps(M, evaluate(M, data.ops, data.drawing, data.name), data.drawing, { budgetMs: data.budgetMs })) }; }
    return { cand: slim(evaluate(M, data.ops, data.drawing, data.name)) };
  }
  callWorker(cmd, data, onStep) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, onStep }); this.worker.postMessage({ id, cmd, ...data }); });
  }

  bind() {
    $('#reconFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) this.fromFile(f); };
    $('#reconSample').onclick = () => this.sample();
    $('#reconPaste').onclick = () => { $('#pasteText').value = ''; $('#pasteDlg').showModal(); };
    $('#pasteDlg').addEventListener('close', () => { if ($('#pasteDlg').returnValue === 'ok') this.fromJSONText($('#pasteText').value); });
    $('#reconSvg').addEventListener('click', e => this.onSvgClick(e));
    $('#reconRerun').onclick = () => this.rebuild();
  }

  // ---------- 输入 ----------
  fromFile(file) { return this.runTask(() => this.photoPipeline(file)); }

  // 整个拍照建模流程期间保持运行（安卓上切后台、锁屏也继续），完成后在通知栏提醒
  async runTask(fn) {
    const release = holdAwake('视图通正在识图建模…');
    this.app.agent.calls = [];
    let note = { title: '视图通', text: '拍照建模已结束，点开查看结果' };
    this.startClock();
    const myClock = this.clock;
    this._clockOwner = true;
    try { await fn(); }
    catch (e) { note = { title: '视图通', text: '拍照建模出错：' + (e.message || e) }; throw e; }
    finally {
      clearPending();
      const total = this.clock === myClock ? this.stopClock() : 0;
      if (this.clock === myClock) this.renderCallLog(this.app.agent.calls || []);
      const best = this.cur || this.cands?.[0];
      if (best && note.text.startsWith('拍照建模已结束')) note.text = `拍照建模完成：「${best.name}」图线吻合 ${pct(best.score)}${total ? `，用时 ${dur(total)}` : ''}，点开查看`;
      else if (!best && this.state?.vision?.st === 'fail') note.text = '识图没有成功，点开查看原因';
      release({ notify: note });
    }
  }

  // 上次的拍照建模没做完（网页在后台被系统回收）：有量好的图线就直接重建，否则用存下的照片重新识图
  showResume() {
    document.querySelector('.recon-resume')?.remove();
    const p = loadPending(); if (!p?.photo) return;
    const box = document.createElement('div');
    box.className = 'recon-resume';
    box.innerHTML = `<p>上次的拍照建模没有完成（可能是切到后台时被系统回收了内存）。${p.stage === 'json' ? '图线已经识别、量好了，可以直接接着重建，不用再等识图。' : '可以用上次的照片重新识图。'}</p><button class="primary" data-act="go">继续</button><button data-act="drop">放弃</button>`;
    box.onclick = async e => {
      const act = e.target.dataset?.act; if (!act) return;
      box.remove();
      if (act === 'drop') { clearPending(); return; }
      if (p.stage === 'json' && p.json) return this.runTask(() => this.resumeFrom(p));
      const blob = await (await fetch(p.photo)).blob();
      this.fromFile(new File([blob], p.label || '题目照片.jpg', { type: blob.type || 'image/jpeg' }));
    };
    $('#reconSteps').before(box);
  }
  async resumeFrom(p) {
    this.start();
    this.photo = this.originalPhoto = p.photo; this.inputLabel = p.label || '题目照片'; this.refs = p.refs || '';
    savePending({ ...p });
    $('#reconPhoto').innerHTML = `<img src="${esc(p.photo)}" alt="题目照片">`;
    this.setStep('vision', 'ok', '已恢复上次识别、量好的图线（不用重新识图）');
    this.json = p.json;
    await this.process(p.json);
  }

  async photoPipeline(file) {
    this.start();
    const run = this.run;
    let url;
    try {
      // 发给大模型的图 1400 像素就够“认”线（上传快、等得短）；量线用 2400 像素的原图
      const images = await Promise.all([shrinkImage(file, 1400, 0.85), shrinkImage(file, 2400, 0.9)]);
      if (run !== this.run) return;
      [url, this.originalPhoto] = images;
    } catch (e) { if (run === this.run) this.setStep('vision', 'fail', '照片读取失败：' + e.message); return; }
    this.photo = url; this.inputLabel = file.name || '题目照片';
    clearPending(); savePending({ photo: url, label: this.inputLabel, stage: 'vision' });
    $('#reconPhoto').innerHTML = `<img src="${esc(url)}" alt="题目照片">`;
    this.setStep('vision', 'run', '正在识别照片里的三视图…');
    if (!this.app.agent.canSee) {
      this.setStep('vision', 'fail', '还没有配置视觉模型。部署时在服务器上填 VISION_MODEL，或在“设置”里填写；也可以先点“示例题”或“粘贴识图结果”体验后面的流程。');
      return;
    }
    try {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (run !== this.run) { clearInterval(tick); return; }
        const bg = window.AndroidNet?.busy ? '可以切到后台或锁屏，完成后会在通知栏提醒你' : '等待时请不要关闭或刷新页面';
        this.setStep('vision', 'run', `正在识别照片里的三视图…（已等待 ${Math.round((Date.now() - t0) / 1000)} 秒）\n大模型看图一般要半分钟到两分钟，${bg}`);
      }, 1000);
      let json;
      try { json = parseVisionJSON(await this.app.agent.vision(url)); } finally { clearInterval(tick); }
      if (run !== this.run) return;
      const info = `识别完成${json.shape ? `：${json.shape}` : ''}${json.question ? `\n题目：${json.question}` : ''}`;
      this.setStep('vision', 'run', info);
      // 联网搜相似题和后面的量线、自检同时进行
      const refsDone = this.searchRefs(json).catch(() => {});
      const fast = this.app.agent.cfg.photoMode !== 'thorough';
      let report = null;
      if (fast) {
        // 快速模式：先按像素量线核对读数；量线结果与照片吻合就不再让大模型自检（省一次看图，约一半时间）
        const m = await this.measure(json, run);
        if (run !== this.run) return;
        if (!suspicious(m.report)) { json = m.json; report = m.report; this.setStep('vision', 'ok', `${this.state.vision.msg}\n读数与照片吻合，跳过大模型自检`); }
      }
      if (!report) {
        this.setStep('vision', 'run', info + `\n${fast ? '量线发现可能读错或漏读，' : ''}正在把识别结果重新画出来，和照片对照自检…`);
        // 自检：按识别结果重绘，与照片一起交给视觉模型改错
        try {
          const png = await drawingPNG(reconcile(fromVision(JSON.parse(JSON.stringify(json)))));
          const fixed = parseVisionJSON(await this.app.agent.visionChat([url, png], selfCheckPrompt(json), { effort: 'high', label: '自检' }));
          if (run !== this.run) return;
          const n = c => ['front', 'top', 'left'].reduce((s, v) => s + (c.views?.[v]?.lines?.length || 0) + (c.views?.[v]?.circles?.length || 0) + (c.views?.[v]?.arcs?.length || 0), 0);
          if (fixed?.views && n(fixed) > 0) {
            for (const v of ['front', 'top', 'left']) if (fixed.views[v] && !fixed.views[v].box && json.views?.[v]?.box) fixed.views[v].box = json.views[v].box;
            json = { ...json, ...fixed }; this.setStep('vision', 'ok', info + `\n自检完成（图线 ${n(json)} 条）`); }
          else this.setStep('vision', 'ok', info + '\n自检没有返回有效结果，沿用首次识别');
        } catch (e) { if (run !== this.run) return; this.setStep('vision', 'ok', info + '\n自检跳过：' + e.message); }
        // 算法量线：模型负责“认”，坐标按照片像素重新量
        json = (await this.measure(json, run)).json;
        if (run !== this.run) return;
      }
      this.json = json;
      await refsDone;
      if (run !== this.run) return;
      savePending({ stage: 'json', json, refs: this.refs });
      await this.process(json);
    } catch (e) {
      if (run !== this.run) return;
      const net = e.network || /接口|网络|超时|连接|JSON/.test(e.message || '');
      this.setStep('vision', 'fail', net
        ? `识图失败：${e.message}。\n这是网络或接口的问题，照片本身没问题：检查网络（开着代理时可以换个节点或暂时关掉）和“设置”里的接口地址、多模态模型名称，再点“拍照 / 选图”重试。`
        : `识图失败：${e.message}。可以重拍（正对纸面、光线均匀、只拍题目区域），或用“粘贴识图结果”。`);
    }
  }
  async measure(json, run) {
    const none = { json, report: null };
    const step = this.state?.vision?.msg || '';
    this.setStep('vision', 'run', step + '\n正在按照片像素逐条量线…');
    await new Promise(r => setTimeout(r, 30));
    try {
      const I = await loadInk(this.originalPhoto || this.photo);
      if (run !== this.run) return none;
      // 视图框按发给模型的那张图换算成比例
      const sent = await new Promise(r => { const im = new Image(); im.onload = () => r([im.naturalWidth, im.naturalHeight]); im.onerror = () => r([I.w, I.h]); im.src = this.photo; });
      const { json: out, report } = refineVision(normalizeBoxes(JSON.parse(JSON.stringify(json)), ...sent), I);
      this.setStep('vision', report.skipped ? 'warn' : 'ok', step + '\n' + reportText(report));
      if (!report.skipped && report.overlay) this.showOverlay(report.overlay);
      return { json: out, report };
    } catch (e) {
      this.setStep('vision', 'ok', step + '\n算法量线跳过：' + e.message);
      return none;
    }
  }

  // 在题目照片上叠加量线结果：绿色是按像素量到的线，橙色是照片里没找到、沿用模型读数的线
  showOverlay(ov) {
    const img = $('#reconPhoto img'); if (!img) return;
    const col = st => (st === 'ok' ? '#1f9d55' : st === 'weak' ? '#e8590c' : st === 'found' ? '#1c7ed6' : st === 'dropped' ? '#e03131' : '#8a94a0');
    const sw = Math.max(2, Math.round(Math.max(ov.w, ov.h) / 350));
    const dash = t => (t === 'dashed' ? ` stroke-dasharray="${sw * 4} ${sw * 3}"` : t === 'center' ? ` stroke-dasharray="${sw * 8} ${sw * 2} ${sw} ${sw * 2}"` : '');
    let g = ov.lines.map(([x1, y1, x2, y2, t, st]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col(st)}"${st === 'dropped' ? ` stroke-dasharray="${sw * 2} ${sw * 2}" opacity=".9"` : dash(t)}/>`).join('');
    g += ov.rings.map(([cx, cy, r, from, to, t]) => {
      if (from == null) return `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${col('ok')}"${dash(t)}/>`;
      const a0 = from * Math.PI / 180, a1 = to * Math.PI / 180, span = ((to - from) % 360 + 360) % 360 || 360;
      const P = a => [(cx + r * Math.cos(a)).toFixed(1), (cy - r * Math.sin(a)).toFixed(1)];
      return `<path d="M${P(a0).join(' ')}A${r} ${r} 0 ${span > 180 ? 1 : 0} 0 ${P(a1).join(' ')}" stroke="${col('ok')}"${dash(t)}/>`;
    }).join('');
    const weak = ov.lines.filter(l => l[5] === 'weak').length, found = ov.lines.filter(l => l[5] === 'found').length, dropped = ov.lines.filter(l => l[5] === 'dropped').length;
    $('#reconPhoto').innerHTML = `<figure class="ph-wrap"><span class="ph"><img src="${esc(img.src)}" alt="题目照片"><svg class="ph-ov" viewBox="0 0 ${ov.w} ${ov.h}" preserveAspectRatio="none" fill="none" stroke-width="${sw}" stroke-linecap="round" aria-hidden="true">${g}</svg></span>
      <figcaption><button type="button" class="ghost ph-toggle" aria-pressed="true">量线</button><i class="lg-ok"></i>按像素量到${found ? `<i class="lg-found"></i>程序补上（${found}）` : ''}${dropped ? `<i class="lg-drop"></i>照片里没有、已去掉（${dropped}）` : ''}${weak ? `<i class="lg-weak"></i>没量准（${weak}）` : ''}</figcaption></figure>`;
    const btn = $('#reconPhoto .ph-toggle');
    btn.onclick = () => { const on = btn.getAttribute('aria-pressed') !== 'true'; btn.setAttribute('aria-pressed', String(on)); $('#reconPhoto .ph-ov').style.display = on ? '' : 'none'; };
    // 点照片放大查看
    $('#reconPhoto .ph').onclick = () => {
      let dlg = $('#photoDlg');
      if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'photoDlg'; dlg.className = 'photo-dlg'; document.body.appendChild(dlg); dlg.onclick = () => dlg.close(); }
      dlg.innerHTML = `<div class="ph big">${$('#reconPhoto .ph').innerHTML}</div><p class="note">点任意处关闭</p>`;
      dlg.showModal();
    };
  }

  // 用 Tavily 等联网搜索找相似题，摘要作为重建的参考资料
  async searchRefs(json) {
    const run = this.run;
    this.refs = '';
    const agent = this.app.agent;
    if (!agent.canSearch) { this.setStep('search', 'idle'); return; }
    const q = [json.question?.slice(0, 40), json.shape, ...(json.features || []).slice(0, 3), '三视图 例题 解析'].filter(Boolean).join(' ');
    this.setStep('search', 'run', '搜索：' + q);
    try {
      const rs = await agent.search(q);
      if (run !== this.run) return;
      this.refs = rs.slice(0, 4).map((r, i) => `${i + 1}. ${r.title}：${(r.snippet || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
      this.setStep('search', rs.length ? 'ok' : 'warn', rs.length ? `找到 ${rs.length} 条，摘要已作为重建参考（以照片为准）` : '没有找到相关资料');
      if (rs.length) this.app.showLinks(rs);
    } catch (e) { if (run === this.run) this.setStep('search', 'warn', '搜索失败：' + e.message); }
  }
  async fromJSONText(t) {
    this.start();
    this.inputLabel = '使用粘贴的识图结果';
    $('#reconPhoto').innerHTML = '<span>使用粘贴的识图结果</span>';
    try { const json = parseVisionJSON(t); this.setStep('vision', 'ok', '已读入识图结果'); await this.process(json); }
    catch (e) { this.setStep('vision', 'fail', 'JSON 格式不对：' + e.message); }
  }
  // 示例：从题库随机取一个模型，模拟一张“识图结果”（带随机误差），可选去掉左视图做补图题
  async sample() {
    this.start();
    const run = this.run;
    const pool = MODELS.filter(m => m.id !== 'bearing-seat');
    const def = pool[Math.floor(Math.random() * pool.length)];
    const M = await this.app.manifold();
    if (run !== this.run) return;
    const truth = analyze(def, buildMesh(M, def));
    const twoView = Math.random() < 0.35 && !['corner-cut', 'slotted-cylinder'].includes(def.id);
    const json = synthVision(truth, { noise: 0.008, scaleErr: 0.03, drop: twoView ? 'left' : null, seed: Date.now() % 100000 });
    this.inputLabel = `示例题：${def.name}`;
    $('#reconPhoto').innerHTML = `<span>示例题：模拟识图结果（含随机读数误差${twoView ? '，只给主视图和俯视图，求补画左视图' : ''}）</span>`;
    this.setStep('vision', 'ok', `示例数据已生成（${twoView ? '补图题' : '三视图'}）`);
    await this.process(json);
  }

  // ---------- 主流程 ----------
  // 计时：从选图开始，到整个流程（识图、重建、复核、修正）全部结束
  start() {
    this.run = (this.run || 0) + 1;
    this.drawing = null; this.cands = []; this.cur = null; this.edited = false;
    this.photo = null; this.originalPhoto = null; this.refs = ''; this.raw = null; this.json = null;
    this.projectId = null; this.projectTitle = ''; this.projectCreatedAt = null; this.editHistory = []; this.inputLabel = ''; this.missing = [];
    this.findingAlternatives = false; this.photoSkipped = false;
    // 只有拍照流程计时；示例题、粘贴结果或中途重新开始时，清掉上一次的计时
    if (!this._clockOwner && this.clock) { clearInterval(this.clockTick); this.clock = null; const el = $('#reconTimer'); if (el) el.hidden = true; }
    this._clockOwner = false;
    this.renderSteps({}); $('#reconCands').innerHTML = ''; $('#reconSvg').innerHTML = ''; $('#reconRerun').hidden = true;
    $('#reconPhoto').innerHTML = '<span>拍照或选取题目图片</span>';
    this.app.onReconStart?.();
  }
  async process(json) {
    this.setStep('align', 'run');
    let d;
    try { d = reconcile(fromVision(json)); }
    catch (e) { this.setStep('align', 'fail', e.message); return; }
    this.raw = json; this.json = json;
    const present = VIEW_KEYS.filter(v => d.views[v].present);
    this.missing = VIEW_KEYS.filter(v => !d.views[v].present);
    this.setStep('align', 'ok', [`总体尺寸 长 ${d.dims.x.toFixed(1)} × 宽 ${d.dims.y.toFixed(1)} × 高 ${d.dims.z.toFixed(1)}`, ...(d.log.length ? d.log : ['三个视图本来就对齐，无需校正'])].join('\n'));
    if (this.missing.length) this.app.say('bot', `这道题只给了${present.map(v => VN[v]).join('和')}，我来重建形体并生成候选${this.missing.map(v => VN[v]).join('、')}。两个视图对应的形体可能不止一种，候选列表并不代表穷尽了所有解。`);
    this.drawing = d;
    this.renderDrawing();
    await this.rebuild();
  }

  async rebuild() {
    const d = this.drawing; if (!d) return;
    const run = ++this.run;
    $('#reconRerun').hidden = true;
    this.cands = []; this.cur = null; $('#reconCands').innerHTML = '';
    this.app.onReconStart?.();
    this.setStep('build', 'run'); this.setStep('check', 'idle'); this.setStep('refine', 'idle');
    const logs = [];
    const agent = this.app.agent;
    // 复杂的题程序要算好一阵：几秒内没算完，就让大模型同时开始看图建模，不干等
    let early = null;
    const timer = this.photo && agent.canSee ? setTimeout(() => { if (run === this.run) early = this.startLLM(run); }, 6000) : null;
    let res;
    try { res = await this.call('reconstruct', { drawing: d }, s => { if (run === this.run) { logs.push(s); this.setStep('build', 'run', logs.join('\n')); } }); }
    catch (e) { if (run === this.run) this.setStep('build', 'fail', e.message); return; }
    finally { clearTimeout(timer); }
    if (run !== this.run) return;
    this.cands = res.cands.filter(c => !c.error);
    this.setStep('build', 'ok', logs.join('\n') || '完成');
    const best = this.cands[0];
    if (!best) { this.setStep('check', 'fail', '没有生成可用的形体，请检查识图结果的外轮廓是否闭合'); return; }
    this.setStep('check', best.score > 0.985 ? 'ok' : 'warn', this.scoreText(best));
    await this.show(best);
    if (run !== this.run) return;
    // 有原照片时，以照片为准做核对和修正（识图结果本身可能读错）
    if (this.photo && agent.canSee) {
      if (agent.cfg.photoMode !== 'thorough' && best.score > 0.985) {
        // 快速模式：程序候选与量过的图线完全吻合，就不再逐个请大模型对照照片复核
        if (early) early.dead = true;
        this.photoSkipped = true;
        this.setStep('photo', 'ok', '图线与照片量线结果完全吻合，快速模式跳过 AI 照片复核（需要时点下方“让 AI 对照照片复核”）');
        this.setStep('refine', 'ok', '不需要修正');
        this.renderCands();
        return;
      }
      this.photoSkipped = false;
      await this.photoLoop(early);
      if (run !== this.run) return;
      this.renderCands();
      return;
    }
    // 大模型修正 / 找多解
    if (best.score < 0.985) {
      if (agent.mode === 'offline') this.setStep('refine', 'warn', '程序生成的候选还有差异。配置大模型后会自动让它根据差异修改方案；你也可以检查识图结果，点线条修改后重新生成。');
      else await this.refine();
    } else if (this.missing.length && agent.mode !== 'offline') await this.alternatives();
    else this.setStep('refine', 'ok', '不需要修正');
    if (run !== this.run) return;
    this.renderCands();
  }

  async renderModelPNG(c) { return drawingPNG(this.drawing, await this.modelOf(c), this.missing); }

  // 大模型建模：看图直接建模、形体分析两条路同时走
  startLLM(run) {
    const o = { log: [], dead: false };
    o.say = st => { if (run === this.run && !o.dead) this.setStep('photo', st, o.log.join('\n')); };
    o.log.push('让大模型看照片建模（直接建模、形体分析同时进行）…'); o.say('run');
    o.p = Promise.all([this.directCandidate(run, o.log, o.say), this.partsCandidate(run, o.log, o.say, { photo: true })]);
    return o;
  }
  async directCandidate(run, log, say) {
    const d = this.drawing;
    try {
      const prompt = `${refinePrompt(d, null)}${this.refs ? `\n\n【联网检索到的相似题目资料，仅供参考，以照片为准】\n${this.refs}` : ''}\n\n图1 是题目照片。上面的线条数据是程序识别的，可能有错，请以照片为准读懂形体后给出方案。只输出 JSON。`;
      const { ops, explain } = parseOps(await this.app.agent.visionChat([this.photo], prompt, { label: '直接建模' }));
      if (run !== this.run) return null;
      const r = await this.call('polish', { drawing: d, ops, name: '看图直接建模' });
      if (run !== this.run) return null;
      if (r.cand.error) { log.push('  看图候选无法生成实体：' + r.cand.error); say('run'); return null; }
      r.cand.explain = [explain, r.cand.tuned].filter(Boolean).join('；'); log.push(`  看图候选：${explain || ''}，图线吻合度 ${pct(r.cand.score)}${r.cand.tuned ? '（' + r.cand.tuned + '）' : ''}`); say('run');
      return r.cand;
    } catch (e) { if (run === this.run) { log.push('  看图建模出错：' + e.message); say('run'); } return null; }
  }
  // 按 AI 的问题清单改“直接建模”类的方案
  async opsRefine(run, base, round) {
    const d = this.drawing;
    const text = await this.app.agent.visionChat([this.photo, await this.renderModelPNG(base)], refineImagePrompt(refinePrompt(d, base), base.issues || [], this.refs), { label: '修正' });
    if (run !== this.run) return null;
    const { ops, explain } = parseOps(text);
    const r = await this.call('polish', { drawing: d, ops, name: `看图修正 ${round}` });
    if (run !== this.run || r.cand.error) return null;
    r.cand.explain = [explain, r.cand.tuned].filter(Boolean).join('；');
    return r.cand;
  }

  // 照片核对：反算三视图 + 原照片交给视觉模型比较；不一致就带着问题清单让它改方案
  async photoLoop(early = null) {
    const run = this.run, agent = this.app.agent, d = this.drawing;
    const fast = agent.cfg.photoMode !== 'thorough';
    const given = VIEW_KEYS.filter(v => d.views[v].present).map(v => VN[v]).join('、');
    const { log, say, p } = early || this.startLLM(run);
    // 复核只是判断“一致不一致”，用最快的思考强度
    const verify = async c => {
      try {
        const r = parseVisionJSON(await agent.visionChat([this.photo, await this.renderModelPNG(c)], verifyPrompt(given), { effort: 'low', label: '复核' }));
        if (run !== this.run) return null;
        if (![true, false, 'true', 'false'].includes(r?.consistent)) throw new Error('复核结果没有明确的一致性判断');
        c.photoOk = r.consistent === true || r.consistent === 'true';
        c.photoStatus = c.photoOk ? 'consistent' : 'inconsistent';
        c.issues = Array.isArray(r.issues) ? r.issues.filter(Boolean).map(String).slice(0, 8) : [];
        c.photoError = null;
        log.push(`「${c.name}」AI 认为${c.photoOk ? '一致（仍需人工核对）' : `存在差异${c.issues[0] ? '：' + c.issues[0] : ''}`}`);
      } catch (e) {
        if (run !== this.run) return null;
        c.photoOk = null; c.photoStatus = 'error'; c.photoError = e.message; c.issues = [];
        log.push(`「${c.name}」AI 复核未完成：${e.message}`);
      }
      say('run');
      return c.photoOk;
    };
    // 等大模型建模的同时复核程序候选；图线吻合不到 80% 的明显不对，不必复核
    const first = this.cands[0];
    const [[dc, pc]] = await Promise.all([p, first && first.score >= 0.8 ? verify(first) : null]);
    if (run !== this.run) return;
    for (const c of [dc, pc]) if (c) this.cands.push(c);
    this.cands.sort((a, b) => b.score - a.score);
    let ok = this.cands.find(c => c.photoOk) || null;
    // 只复核得分最高的那个；快速模式下与量好的图线完全吻合就不再复核
    const top = this.cands[0];
    if (!ok && top && top.photoOk == null && top.photoStatus !== 'error' && !(fast && top.score > 0.985)) {
      if (await verify(top)) ok = top;
      if (run !== this.run) return;
    }
    // 修正：AI 指出了差异、或者图线明显对不上的候选才改；这一轮没提高、或已经基本吻合，就不再多等一轮
    const needsFix = c => c.photoStatus === 'inconsistent' || (c.photoOk == null && c.photoStatus !== 'error' && c.score < 0.97);
    let prev = this.cands[0]?.score || 0;
    for (let round = 1; !ok && round <= 2; round++) {
      // 以图线吻合度为主（问题条数是 AI 主观判断，波动大），分数接近时再看问题少的
      const base = this.cands.filter(needsFix).sort((a, b) => (Math.abs(b.score - a.score) > 0.02 ? b.score - a.score : 0) || ((a.issues?.length || 0) - (b.issues?.length || 0)) || (b.score - a.score))[0];
      if (!base) break;
      this.setStep('refine', 'run', `第 ${round} 轮：对照照片修改「${base.name}」…`);
      let c = null;
      try { c = base.parts ? await this.partsRefine(run, base, round, { photo: true }) : await this.opsRefine(run, base, round); }
      catch (e) { if (run !== this.run) return; log.push('  修正出错：' + e.message); }
      if (run !== this.run) return;
      if (c) {
        this.cands.push(c); log.push(`  ${c.name}：图线吻合度 ${pct(c.score)}`); say('run');
        if (c.score >= prev - 0.01 && await verify(c)) ok = c;
        if (run !== this.run) return;
      }
      const now = Math.max(...this.cands.map(x => x.score));
      if (now <= prev + 0.005 || now >= 0.975) break;
      prev = now;
    }
    const rank = c => c.photoOk && c.score >= 0.8 ? 1 : 0;
    this.cands.sort((a, b) => (rank(b) - rank(a)) || (b.score - a.score));
    const selected = this.cands[0];
    await this.show(selected);
    if (run !== this.run) return;
    say(selected.photoOk ? 'ok' : 'warn');
    const status = selected.photoStatus === 'consistent' ? 'AI 照片复核认为一致，仍需核对结构和尺寸。'
      : selected.photoStatus === 'inconsistent' ? 'AI 照片复核发现差异，可以直接说明哪里不对，让 AI 修改。'
      : selected.photoOk == null && selected.photoStatus !== 'error' && selected.score > 0.985 ? '与量好的图线完全吻合，快速模式没有再请 AI 复核。'
      : 'AI 照片复核未完成，不能据此判断模型是否正确。';
    this.setStep('refine', selected.photoOk ? 'ok' : 'warn', `当前预览「${selected.name}」：${status}`);
    this.setStep('check', selected.score > 0.985 ? 'ok' : 'warn', this.scoreText(selected));
  }

  // 形体分析建模：大模型列部件 → 程序吸附坐标、建模、微调范围
  async partsCandidate(run, log, say, { photo = false } = {}) {
    const agent = this.app.agent, d = this.drawing;
    try {
      const prompt = partsPrompt(d, { photo, refs: this.refs });
      const text = photo ? await agent.visionChat([this.photo], prompt, { label: '形体分析' }) : await agent.complete(prompt, { label: '形体分析' });
      if (run !== this.run) return null;
      const { parts, explain } = parseParts(text);
      log.push(`  形体分析：分成 ${parts.length} 个部分（${parts.map(p => p.name).join('、')}），程序正在对齐坐标、建模…`); say('run');
      const r = await this.call('parts', { drawing: d, parts, name: '形体分析建模', budgetMs: 25000 });
      if (run !== this.run) return null;
      if (r.cand.error) { log.push('  形体分析候选无法生成实体：' + r.cand.error); return null; }
      r.cand.explain = [explain, r.cand.tuned].filter(Boolean).join('；');
      log.push(`  形体分析候选：图线吻合度 ${pct(r.cand.score)}${r.cand.tuned ? '（' + r.cand.tuned + '）' : ''}`); say('run');
      return r.cand;
    } catch (e) { if (run === this.run) { log.push('  形体分析出错：' + e.message); say('run'); } return null; }
  }
  async partsRefine(run, base, round, { photo = false } = {}) {
    const agent = this.app.agent, d = this.drawing;
    const prompt = partsRefinePrompt(d, base, { photo, issues: base.issues || [] });
    const text = photo ? await agent.visionChat([this.photo, await this.renderModelPNG(base)], prompt, { label: '形体分析修正' }) : await agent.complete(prompt, { label: '形体分析修正' });
    if (run !== this.run) return null;
    const { parts, explain } = parseParts(text);
    const r = await this.call('parts', { drawing: d, parts, name: `形体分析修正 ${round}`, budgetMs: 20000 });
    if (run !== this.run || r.cand.error) return null;
    r.cand.explain = [explain, r.cand.tuned].filter(Boolean).join('；');
    return r.cand;
  }

  scoreText(c) {
    const pv = Object.entries(c.perView || {}).map(([v, p]) => `${VN[v]} ${pct(p.score)}`).join('，');
    return `候选「${c.name}」图线吻合度 ${pct(c.score)}${pv ? `（${pv}）` : ''}\n比较的是识别/修正后的图线，不代表模型正确概率。` + (c.score < 0.985 ? '\n' + diffText(c.diffs || [], 6) : '');
  }

  async refine() {
    const run = this.run, agent = this.app.agent;
    let best = this.cands[0];
    const log = [];
    const say = st => { if (run === this.run) this.setStep('refine', st, log.join('\n')); };
    if (best.score < 0.985) {
      log.push('按形体分析法让大模型列出组成部分…'); say('run');
      const pc = await this.partsCandidate(run, log, say);
      if (run !== this.run) return;
      if (pc) { this.cands.push(pc); if (pc.score > best.score) { best = pc; await this.show(pc); } }
    }
    for (let round = 1; round <= 3 && best.score < 0.985; round++) {
      log.push(`第 ${round} 轮：把差异发给大模型…`); this.setStep('refine', 'run', log.join('\n'));
      if (best.parts) {
        try {
          const c = await this.partsRefine(run, best, round);
          if (run !== this.run) return;
          if (c) { log.push(`  形体分析修正：吻合 ${pct(c.score)}`); this.cands.push(c); if (c.score > best.score) { best = c; await this.show(c); } }
        } catch (e) { if (run !== this.run) return; log.push('  出错：' + e.message); }
        say('run');
        continue;
      }
      try {
        const text = await agent.complete(refinePrompt(this.drawing, best));
        if (run !== this.run) return;
        const { ops, explain } = parseOps(text);
        const r = await this.call('polish', { drawing: this.drawing, ops, name: `大模型修正 ${round}` });
        if (run !== this.run) return;
        const c = r.cand;
        if (c.error) { log.push(`  方案无法生成实体：${c.error}`); continue; }
        c.explain = [explain, c.tuned].filter(Boolean).join('；');
        log.push(`  ${c.explain ? c.explain + '；' : ''}吻合 ${pct(c.score)}`);
        this.cands.push(c);
        if (c.score > best.score) { best = c; await this.show(c); }
      } catch (e) { if (run !== this.run) return; log.push('  出错：' + e.message); }
      this.setStep('refine', 'run', log.join('\n'));
    }
    this.cands.sort((a, b) => b.score - a.score);
    this.setStep('refine', best.score > 0.985 ? 'ok' : 'warn', log.join('\n') + (best.score > 0.985 ? '\n与识图结果的图线高度吻合，仍需核对结构' : '\n仍有图线差异，可以直接描述哪里不对让 AI 改模型，也可修正识图线条'));
    this.setStep('check', best.score > 0.985 ? 'ok' : 'warn', this.scoreText(best));
  }

  async alternatives() {
    if (this.findingAlternatives || !this.drawing || !this.missing?.length) return;
    const run = this.run, agent = this.app.agent;
    if (agent.mode === 'offline') return;
    this.findingAlternatives = true;
    this.renderCands();
    try {
    const found = this.cands.filter(c => c.score > 0.985);
    const log = ['尝试寻找其他候选（最多两次请求，并不保证穷尽所有解）…'];
    this.setStep('refine', 'run', log.join('\n'));
    for (let k = 0; k < 2; k++) {
      try {
        const text = await agent.complete(alternativePrompt(refinePrompt(this.drawing, null), found));
        if (run !== this.run) return;
        const { ops, explain } = parseOps(text);
        const r = await this.call('evaluate', { drawing: this.drawing, ops, name: `另一种解 ${k + 1}` });
        if (run !== this.run) return;
        const c = r.cand; if (c.error || c.score < 0.985) { log.push(`  提出的方案不符合已知视图（吻合 ${pct(c.score || 0)}），舍弃`); continue; }
        // 第三视图不同才算新解
        const M = await this.app.manifold();
        const m = analyze({ id: 't', name: '', ops: c.ops, desc: '', points: [] }, buildMesh(M, { ops: c.ops }));
        const sig = mm => projectionSignature(mm, this.missing);
        const sigs = await Promise.all(found.map(async f => sig(await this.modelOf(f))));
        if (run !== this.run) return;
        if (sigs.includes(sig(m))) { log.push('  与已有方案相同，舍弃'); continue; }
        c.explain = explain; c.alt = true; found.push(c); this.cands.push(c);
        log.push(`  找到另一种解：${explain || ''}`);
      } catch (e) { if (run !== this.run) return; log.push('  出错：' + e.message); }
      this.setStep('refine', 'run', log.join('\n'));
    }
    this.cands.sort((a, b) => b.score - a.score);
    this.setStep('refine', found.length ? 'ok' : 'warn', log.join('\n') + `\n当前有 ${found.length} 个与已知识图图线高度吻合的候选`);
    } finally { if (run === this.run) { this.findingAlternatives = false; this.renderCands(); } }
  }

  async modelOf(c) {
    if (c._model) return c._model;
    const M = await this.app.manifold();
    const def = { id: 'recon-preview', name: c.name, level: '拍照', desc: '', points: [], ops: c.ops };
    c._model = analyze(def, buildMesh(M, def));
    return c._model;
  }
  async show(c, { isCurrent } = {}) {
    const run = this.run, selection = this.showSeq = (this.showSeq || 0) + 1;
    const m = await this.modelOf(c);
    if (run !== this.run || selection !== this.showSeq || (isCurrent && !isCurrent())) return;
    this.cur = c;
    this.app.viewer.setModel(m);
    this.app.viewer.setSelection({});
    await this.app.onPreviewModel?.(m, c);
    if (run !== this.run || selection !== this.showSeq) return;
    this.renderDrawing();
    this.renderCands();
    this.app.onProjectChange?.();
    return m;
  }

  captureProject() {
    if (!this.drawing) throw new Error('请先识别或打开一道题目');
    const p = normalizeProject({
      version: 1, kind: 'photo', id: this.projectId, title: this.projectTitle || this.raw?.question || this.raw?.shape || this.inputLabel || '拍照题目',
      createdAt: this.projectCreatedAt, photo: this.photo, originalPhoto: this.originalPhoto,
      inputLabel: this.inputLabel, raw: this.raw, json: this.json, drawing: this.drawing,
      candidates: this.cands.map(snapshotCandidate), currentIndex: this.cands.indexOf(this.cur),
      missing: this.missing, state: this.state, refs: this.refs, edited: this.edited, editHistory: this.editHistory,
    });
    this.projectId = p.id; this.projectCreatedAt = p.createdAt;
    return p;
  }

  async restoreProject(project) {
    const p = normalizeProject(project);
    if (p.kind === 'model') throw new Error('此项目是模型编辑记录，请在模型编辑器打开');
    this.start();
    this.projectId = p.id; this.projectTitle = p.title; this.projectCreatedAt = p.createdAt;
    this.photo = p.photo; this.originalPhoto = p.originalPhoto; this.inputLabel = p.inputLabel;
    this.raw = p.raw; this.json = p.json; this.drawing = p.drawing; this.cands = p.candidates || [];
    this.missing = VIEW_KEYS.filter(v => !p.drawing.views[v]?.present); this.refs = p.refs;
    this.edited = p.edited; this.editHistory = p.editHistory;
    const state = Object.fromEntries(Object.entries(p.state).map(([key, step]) => [key, step.st === 'run' ? { st: 'warn', msg: '上次任务尚未完成；可重新生成或继续修改当前候选。' } : step]));
    this.renderSteps(state);
    $('#reconPhoto').innerHTML = p.photo ? `<img src="${esc(p.photo)}" alt="保存的题目照片">` : `<span>${esc(p.inputLabel || '从题册打开的题目')}</span>`;
    $('#reconRerun').hidden = !p.edited;
    this.renderDrawing(); this.renderCands();
    if (p.currentIndex >= 0) await this.show(this.cands[p.currentIndex]);
    else this.app.onProjectChange?.();
    // onPreviewModel 可重置编辑器；恢复历史必须放在预览通知之后。
    this.editHistory = p.editHistory;
    return this.cur;
  }

  stopAutomaticWork() {
    this.run = (this.run || 0) + 1;
    this.findingAlternatives = false;
    const state = Object.fromEntries(Object.entries(this.state || {}).map(([key, step]) => [key, step.st === 'run'
      ? { st: 'warn', msg: `${step.msg || ''}\n已转为对话修改，自动流程已停止。`.trim() } : step]));
    this.renderSteps(state);
    this.renderCands();
    return this.run;
  }

  async applyEditedModel(result, model = null) {
    if (!this.drawing) throw new Error('请先打开要修改的题目');
    if (result.isCurrent && !result.isCurrent()) { const error = new Error('编辑请求已取消'); error.name = 'AbortError'; throw error; }
    // 显式用户修改优先，停止后台自动修正的后续回写。
    const run = this.stopAutomaticWork(), parentName = this.cur?.name || '';
    const ensureCurrent = () => {
      if (run !== this.run || (result.isCurrent && !result.isCurrent())) {
        const error = new Error('当前题目已切换，修改未应用'); error.name = 'AbortError'; throw error;
      }
    };
    ensureCurrent();
    const name = result.name || `对话修改 ${this.cands.filter(c => c.userEdited).length + 1}`;
    const response = await this.call('evaluate', { drawing: this.drawing, ops: result.ops, name });
    ensureCurrent();
    if (response.cand.error) throw new Error(response.cand.error);
    const c = Object.assign(response.cand, {
      name, explain: result.explain || '', request: result.request || '', parentName,
      userEdited: true, source: 'user-edit', createdAt: new Date().toISOString(),
      photoOk: null, photoStatus: 'unchecked', issues: [],
    });
    c._model = model || await this.modelOf(c);
    ensureCurrent();
    this.cands.push(c);
    const shown = await this.show(c, { isCurrent: result.isCurrent });
    if (!shown) {
      this.cands = this.cands.filter(candidate => candidate !== c);
      const error = new Error('当前预览已切换，修改未应用'); error.name = 'AbortError'; throw error;
    }
    if (run !== this.run) return c;
    this.setStep('check', c.score > 0.985 ? 'ok' : 'warn', this.scoreText(c));
    this.setStep('refine', 'ok', `已按你的描述生成「${c.name}」。原候选仍可预览；识图数据也可能有误，因此图线分数较低的修改也会保留。`);
    return c;
  }

  renderCands() {
    const el = $('#reconCands');
    if (!Array.isArray(this.cands)) this.cands = [];
    const good = this.cands.filter(c => c.photoOk || (c.photoOk == null && c.score > 0.985));
    const list = this.cands.filter(c => c.userEdited || c === this.cur || (good.length ? good.includes(c) : this.cands.indexOf(c) < 3));
    el.innerHTML = list.map((c, i) => `<div class="cand ${c === this.cur ? 'on' : ''}" data-i="${this.cands.indexOf(c)}">
      <div class="cand-top"><b>${esc(c.name)}</b><span class="score ${c.score > 0.985 ? 'good' : c.score > 0.9 ? 'mid' : 'low'}">图线 ${pct(c.score)}</span></div>
      <div class="cand-views">${Object.entries(c.perView || {}).map(([v, p]) => `<span>${VN[v]} ${pct(p.score)}</span>`).join('')}</div>
      ${c.photoOk != null ? `<p class="${c.photoOk ? 'pv-ok' : 'pv-bad'}">${c.photoOk ? 'AI 照片复核：认为一致，需人工核对' : 'AI 照片复核：' + esc((c.issues || []).slice(0, 2).join('；') || '认为存在差异')}</p>` : this.photo ? `<p>AI 照片复核：${c.photoStatus === 'error' ? '未完成（' + esc(c.photoError || '请求异常') + '）' : '尚未复核此候选'}</p>` : ''}
      ${c.explain ? `<p>${esc(c.explain)}</p>` : ''}
      <div class="cand-btns"><button data-act="show">预览</button><button data-act="use" class="primary">采用并开始讲解</button></div>
    </div>`).join('') + (list.length ? '<p class="note">图线吻合度比较识图数据，不是模型正确概率。候选结构和尺寸仍需核对。</p>' : '')
      + (this.missing?.length && this.cands.length ? `<p class="note">已知视图可能对应多个形体，补画视图是当前候选的投影。可逐个预览比较。</p>${this.app.agent.mode !== 'offline' ? `<button data-act="alternatives" ${this.findingAlternatives ? 'disabled' : ''}>${this.findingAlternatives ? '正在寻找其他候选…' : '寻找其他候选（最多两次 AI 请求）'}</button>` : ''}` : '');
    el.querySelectorAll('.cand').forEach(card => {
      const c = this.cands[+card.dataset.i];
      card.querySelector('[data-act="show"]').onclick = () => this.show(c);
      card.querySelector('[data-act="use"]').onclick = () => this.adopt(c);
    });
    const alternatives = el.querySelector('[data-act="alternatives"]');
    if (alternatives) alternatives.onclick = () => this.alternatives();
    if (this.photoSkipped && this.photo && this.app.agent.canSee && list.length) {
      const b = document.createElement('button'); b.dataset.act = 'photo-check'; b.textContent = '让 AI 对照照片复核（较慢）';
      b.onclick = async () => {
        this.photoSkipped = false; b.disabled = true;
        const release = holdAwake('视图通正在对照照片复核…');
        const t0 = Date.now();
        try { await this.photoLoop(); } finally {
          const el = $('#reconTimer'); if (el && !el.hidden) el.insertAdjacentHTML('beforeend', `<small>AI 照片复核另用时 ${dur(Date.now() - t0)}</small>`);
          release({ notify: { title: '视图通', text: `AI 照片复核完成，用时 ${dur(Date.now() - t0)}，点开查看` } }); this.renderCands();
        }
      };
      el.appendChild(b);
    }
  }

  adopt(c) {
    this.count++;
    const id = `photo-${Date.now().toString(36)}`;
    const def = {
      id, name: `拍照模型 ${this.count}`, level: '拍照建模',
      desc: c.explain || (this.missing.length ? `根据${VIEW_KEYS.filter(v => !this.missing.includes(v)).map(v => VN[v]).join('、')}重建，并补画了${this.missing.map(v => VN[v]).join('、')}。` : '根据照片中的三视图重建。'),
      points: this.missing.length ? [`补画的${this.missing.map(v => VN[v]).join('、')}由程序根据重建形体自动生成`, '对照投影规律检查补画的每一条线'] : ['核对重建形体的三视图与照片是否一致', '在视图中点线，看它对应形体上的哪条棱、哪个面'],
      ops: c.ops,
    };
    this.app.addCustomModel(def, c._model);
    this.app.setMode('learn');
    this.app.loadModel(id);
    this.app.say('bot', `已采用候选「${c.name}」，命名为「${def.name}」，与识别图线的吻合度为 ${pct(c.score)}。${this.missing.length ? `中间图纸里的${this.missing.map(v => VN[v]).join('、')}是此候选的补画结果，可能还存在其他解。` : ''}\n现在可以点线讲解、出练习题，也可以直接描述哪里不对让 AI 改模型。`);
  }

  // ---------- 图纸 ----------
  renderDrawing() {
    const d = this.drawing; if (!d) return;
    const lay = layoutOf({ bbox: [[0, 0, 0], [d.dims.x, d.dims.y, d.dims.z]] });
    this.lay = lay;
    const svg = $('#reconSvg');
    svg.setAttribute('viewBox', `0 0 ${lay.width.toFixed(2)} ${lay.height.toFixed(2)}`);
    let body = '';
    const P = (v, p) => toPaper(lay, v, p).map(x => x.toFixed(3)).join(' ');
    const sty = t => t === 'dashed' ? STYLE.hid : t === 'center' ? STYLE.cen : STYLE.vis;
    // 45° 线
    const a = [lay.left.ox - d.dims.y, lay.top.oy - d.dims.y], b = [lay.left.ox, lay.top.oy];
    body += `<line x1="${a[0] - 4}" y1="${a[1] - 4}" x2="${b[0] + 4}" y2="${b[1] + 4}" class="miter"/>`;
    for (const v of VIEW_KEYS) {
      const dv = d.views[v];
      if (!dv.present) {
        if (this.cur?._model) {
          // 补画的视图
          for (const l of this.cur._model.views[v].lines) body += `<path d="M${P(v, l.a)}L${P(v, l.b)}" class="${l.vis ? 'gen-vis' : 'gen-hid'}"/>`;
          for (const c of this.cur._model.views[v].center) body += `<path d="M${P(v, c.a)}L${P(v, c.b)}" class="gen-cen"/>`;
          const [X, Y] = toPaper(lay, v, v === 'left' ? [-d.dims.y / 2, 0] : [d.dims.x / 2, 0]);
          body += `<text x="${X}" y="${Y + 6}" class="vlabel gen-label" text-anchor="middle">补画的${VN[v]}</text>`;
        } else {
          const [X, Y] = toPaper(lay, v, v === 'left' ? [-d.dims.y / 2, d.dims.z / 2] : [d.dims.x / 2, d.dims.y / 2]);
          body += `<text x="${X}" y="${Y}" class="vlabel" text-anchor="middle">待补画</text>`;
        }
        continue;
      }
      dv.segs.forEach((s, i) => { body += `<path d="M${P(v, s.a)}L${P(v, s.b)}" ${sty(s.t)} data-v="${v}" data-i="${i}" class="rseg"/>`; });
      for (const c of dv.circles) body += `<path d="${circlePoints(c, 64).map((p, i) => (i ? 'L' : 'M') + P(v, p)).join('')}" ${sty(c.t)}/>`;
      for (const ar of dv.arcs) body += `<path d="${arcPoints(ar, 48).map((p, i) => (i ? 'L' : 'M') + P(v, p)).join('')}" ${sty(ar.t)}/>`;
      const [bx, by] = toPaper(lay, v, v === 'left' ? [-d.dims.y / 2, 0] : [d.dims.x / 2, 0]);
      body += `<text x="${bx}" y="${by + 6}" class="vlabel" text-anchor="middle">${VN[v]}</text>`;
    }
    // 差异叠加
    if (this.cur?.diffs) for (const df of this.cur.diffs) {
      if (Math.hypot(df.b[0] - df.a[0], df.b[1] - df.a[1]) < 0.4) continue;
      body += `<path d="M${P(df.view, df.a)}L${P(df.view, df.b)}" class="diff diff-${df.kind}"/>`;
    }
    svg.innerHTML = body;
  }

  onSvgClick(e) {
    if (!this.drawing || !this.lay) return;
    const svg = $('#reconSvg'); const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const q = pt.matrixTransform(svg.getScreenCTM().inverse());
    const v = viewAtPaper(this.lay, [q.x, q.y]); if (!v || !this.drawing.views[v].present) return;
    const uv = fromPaper(this.lay, v, [q.x, q.y]);
    const segs = this.drawing.views[v].segs;
    let best = -1, bd = 1.5;
    segs.forEach((s, i) => { const dd = distPtSeg(uv, s.a, s.b); if (dd < bd) { bd = dd; best = i; } });
    if (best < 0) return;
    // 实线 → 虚线 → 点画线 → 删除
    const s = segs[best];
    if (s.t === 'solid') s.t = 'dashed'; else if (s.t === 'dashed') s.t = 'center'; else segs.splice(best, 1);
    this.edited = true; $('#reconRerun').hidden = false;
    this.renderDrawing();
    this.app.onProjectChange?.();
  }
}

Object.assign(ReconPanel.prototype, stepMethods);

// 把三视图画成 PNG（白底黑线），给视觉模型对照用
export async function drawingPNG(d, model = null, missing = []) {
  const lay = layoutOf({ bbox: [[0, 0, 0], [d.dims.x, d.dims.y, d.dims.z]] });
  const k = 1100 / lay.width, W = Math.round(lay.width * k), H = Math.round(lay.height * k);
  const P = (v, p) => toPaper(lay, v, p).map(x => (x * k).toFixed(1)).join(' ');
  const st = (t, col = '#000') => t === 'dashed' ? `stroke="${col}" stroke-width="1.8" stroke-dasharray="11 6" fill="none"` : t === 'center' ? `stroke="${col}" stroke-width="1.2" stroke-dasharray="20 4 3 4" fill="none"` : `stroke="${col}" stroke-width="3.2" fill="none" stroke-linecap="round"`;
  let body = '';
  for (const v of VIEW_KEYS) {
    const col = model && missing.includes(v) ? '#6a3fd8' : '#000';
    if (model) {
      for (const l of model.views[v].lines) body += `<path d="M${P(v, l.a)}L${P(v, l.b)}" ${st(l.vis ? 'solid' : 'dashed', col)}/>`;
      for (const c of model.views[v].center) body += `<path d="M${P(v, c.a)}L${P(v, c.b)}" ${st('center', col)}/>`;
    } else {
      const dv = d.views[v]; if (!dv.present) continue;
      for (const s of dv.segs) body += `<path d="M${P(v, s.a)}L${P(v, s.b)}" ${st(s.t)}/>`;
      for (const c of dv.circles) body += `<path d="${circlePoints(c, 64).map((p, i) => (i ? 'L' : 'M') + P(v, p)).join('')}" ${st(c.t)}/>`;
      for (const a of dv.arcs) body += `<path d="${arcPoints(a, 48).map((p, i) => (i ? 'L' : 'M') + P(v, p)).join('')}" ${st(a.t)}/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;
  return svgToPNG(svg, W, H);
}

// 比较实际投影线位置与虚实，而不是只比较线条数量。
export function projectionSignature(model, views) {
  const point = p => p.map(x => Math.round(x * 20) / 20).join(',');
  return views.map(v => `${v}:` + model.views[v].lines.map(l => {
    const ends = [point(l.a), point(l.b)].sort();
    return `${ends[0]}>${ends[1]}:${l.vis ? 1 : 0}`;
  }).sort().join('|')).join(';');
}

