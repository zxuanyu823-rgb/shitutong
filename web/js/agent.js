// 视图通 · 智能体
// 两种工作方式：
//   1) 大模型模式：OpenAI 兼容接口（DeepSeek、通义千问等），通过“工具调用”操作三维演示、查询几何事实和知识库；
//   2) 离线模式：没有配置大模型时，用规则识别意图，由讲解引擎直接生成讲解，保证演示不中断。
import { VIEWS, VIEW_KEYS, summarize, findFace } from './engine.js';
import { describeCurve, describeFace, describeLine, whyHidden, selectionFacts } from './tutor.js';
import { searchKB, srcText, KB } from './knowledge.js';
import { MODELS } from './models.js';
import { TYPES } from './exercise.js';
import { VISION_PROMPT } from './recon/prompts.js';
import { postJSON, tavilySearch } from './net.js';
import { adaptBody, timeoutFor } from './providers.js';

// App 在后台（网页不可见）累计了多久：用来判断“慢”是接口本身慢，还是切后台时被系统拖慢
let hiddenSince = 0, hiddenTotal = 0;
if (typeof document !== 'undefined') {
  if (document.visibilityState === 'hidden') hiddenSince = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenSince = Date.now();
    else if (hiddenSince) { hiddenTotal += Date.now() - hiddenSince; hiddenSince = 0; }
  });
}
const hiddenMs = () => hiddenTotal + (hiddenSince ? Date.now() - hiddenSince : 0);

const VIEW_WORDS = { front: ['主视', '正面', '前面看'], top: ['俯视', '上面看', '顶视'], left: ['左视', '侧面', '左边看'] };

export const TOOLS = [
  { type: 'function', function: { name: 'describe_element', description: '查询模型中某个面(F开头)或棱(E开头)的几何事实：类型、位置、在三个视图中是实线/虚线/积聚。', parameters: { type: 'object', properties: { id: { type: 'string', description: '如 E3 或 F2' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'explain_hidden', description: '查询某条棱在某个视图中为什么是虚线：返回挡住它的面。', parameters: { type: 'object', properties: { view: { type: 'string', enum: ['front', 'top', 'left'] }, id: { type: 'string' } }, required: ['view', 'id'] } } },
  { type: 'function', function: { name: 'highlight', description: '在三维模型和三视图中同时高亮元素，并画出长对正/高平齐/宽相等的投影连线。occluders 用蓝色表示遮挡面。', parameters: { type: 'object', properties: { curves: { type: 'array', items: { type: 'string' } }, faces: { type: 'array', items: { type: 'string' } }, occluders: { type: 'array', items: { type: 'string' } } } } } },
  { type: 'function', function: { name: 'set_view', description: '把三维模型转到某个观察方向，便于说明“从这个方向看过去”。', parameters: { type: 'object', properties: { view: { type: 'string', enum: ['front', 'top', 'left', 'iso'] } }, required: ['view'] } } },
  { type: 'function', function: { name: 'set_xray', description: '打开/关闭透视模式：实体半透明，被挡住的棱以虚线显示。', parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } } },
  { type: 'function', function: { name: 'unfold_projection', description: '播放三投影面体系及其展开动画，说明三视图是怎么来的。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'search_knowledge', description: '检索工程制图知识库（国家标准与教材整理），返回知识点编号和内容。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'load_model', description: '切换题库中的模型。', parameters: { type: 'object', properties: { model_id: { type: 'string', enum: MODELS.map(m => m.id) } }, required: ['model_id'] } } },
  { type: 'function', function: { name: 'search_examples', description: '联网搜索与当前题目相关的工程制图例题、讲解或教学资源，返回标题、链接和摘要。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索词，如“组合体 开槽 三视图 补画左视图 例题”' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'start_exercise', description: '基于当前模型出一道练习题。match=找对应，vis=判虚实，error=找错线。', parameters: { type: 'object', properties: { type: { type: 'string', enum: Object.keys(TYPES) } }, required: ['type'] } } },
];

const SYSTEM = `你是“视图通”，一个帮助大学生学习工程制图（三视图）的智能体。界面左边是可旋转的三维模型，中间是程序自动生成的三视图（第一角画法），学生可以在两边点选元素。

工作原则：
1. 几何事实（哪条线对应哪条棱、是否被挡住、被谁挡住）只能来自上下文和工具的计算结果，绝不自己猜测形状。
2. 先演示再讲解：讲某条线或某个面时，调用 highlight 高亮它；讲“为什么是虚线”时，调用 set_view 转到对应方向、set_xray 打开透视，并把遮挡面放进 occluders。
3. 讲解要短：不超过 150 字，用 2～4 个短句或要点，口吻像耐心的学长学姐。涉及概念时先 search_knowledge，并在句末标注知识点编号，如【K07】。
4. 学生说“出题”“练习”时调用 start_exercise；问三视图怎么来的，调用 unfold_projection；要找例题或参考资料时调用 search_examples，回答里列出 2～4 个链接并说明各自适合看什么。
5. 与制图学习无关的问题，简短回应后引导回学习。不要使用 Markdown 表格。
6. 元素编号：面 F1、F2…，棱 E1、E2…，转向轮廓线 SF1 等（S 后字母表示视图）。`;

export class Agent {
  constructor(app) {
    this.app = app; this.history = [];
    this.cfg = this.loadCfg();
  }
  loadCfg() {
    try { return JSON.parse(localStorage.getItem('stt.llm')) || {}; } catch { return {}; }
  }
  saveCfg(c) { this.cfg = c; try { localStorage.setItem('stt.llm', JSON.stringify(c)); } catch {} }
  // 识图可以单独用另一家（比如对话用 DeepSeek、识图用 Kimi）；没单独填就沿用对话的接口和密钥
  get visionCfg() {
    const c = this.cfg, own = c.visionPreset && c.visionPreset !== 'same' && c.visionBase;
    return { base: own ? c.visionBase : c.base, key: (own && c.visionKey) || c.key, model: c.vision };
  }
  get canSee() {
    if (this.app.server?.vision) return true;
    const v = this.visionCfg;
    return !!(v.key && v.base && v.model);
  }
  get canSearch() { return !!(this.app.server?.search || this.cfg.tavily); }
  get mode() {
    if (this.app.server?.llm) return 'server';
    if (this.cfg.key && this.cfg.base && this.cfg.model) return 'direct';
    return 'offline';
  }

  context() {
    const m = this.app.activeModel;
    const ex = this.app.exercise ? `\n当前练习：${TYPES[this.app.exercise.type].name}，${this.app.exercise.prompt}（不要直接告诉学生答案，可以给提示）` : '';
    return `【当前模型】\n${summarize(m)}\n\n【学生当前选中】\n${selectionFacts(m, this.app.selection)}${ex}`;
  }

  async ask(text) {
    const revision = this.app.contextRevision;
    if (this.mode === 'offline') return this.offline(text);
    try { return await this.llm(text); }
    catch (e) {
      if (revision !== this.app.contextRevision) return { text: '模型已切换，请针对当前模型重新提问。', actions: [], cites: [] };
      console.warn(e);
      const r = await this.offline(text);
      r.text = `（大模型暂时连不上，先用离线讲解：${e.message || e}）\n` + r.text;
      return r;
    }
  }

  // ---------- 大模型模式 ----------
  // deep：识图、建模这类任务按设置的思考强度；助教对话用最快的强度
  // 每次调用记下用途、强度、耗时、其中 App 在后台的时间，拍照建模结束时列出来，方便找出慢在哪里
  async callLLM(messages, opts = {}) {
    const t0 = Date.now(), h0 = hiddenMs();
    const rec = { label: opts.label || (opts.vision ? '看图' : opts.tools === false ? '建模' : '对话'), effort: '', ms: 0, hidden: 0, ok: false, err: '' };
    try { const m = await this.callLLMOnce(messages, opts, rec); rec.ok = true; return m; }
    catch (e) { rec.err = /超时/.test(e.message) ? '超时' : /取消/.test(e.message) ? '取消' : '失败'; throw e; }
    finally { rec.ms = Date.now() - t0; rec.hidden = hiddenMs() - h0; (this.calls ||= []).push(rec); }
  }
  // effort：这次调用最多用多大的思考强度（不超过设置里选的；复核、自检这类判断用不着最长的思考）
  async callLLMOnce(messages, { tools = true, vision = false, deep = vision, effort: want, signal } = {}, rec = {}) {
    const body = { messages, temperature: vision ? 0.1 : 0.3 };
    if (tools) { body.tools = TOOLS; body.tool_choice = 'auto'; }
    const order = ['low', 'high', 'max'], mine = order.includes(this.cfg.effort) ? this.cfg.effort : 'high';
    const effort = want && order.includes(want) ? order[Math.min(order.indexOf(mine), order.indexOf(want))] : mine;
    rec.effort = deep ? effort : 'low';
    if (vision ? this.app.server?.vision : this.app.server?.llm) {
      return await postJSON(vision ? 'api/vision' : 'api/chat', {}, { ...body, deep, effort }, { signal, native: false, timeout: deep ? (effort === 'max' ? 750000 : 480000) : 240000 }).then(j => {
        if (!j.choices?.[0]?.message) throw new Error('接口没有返回有效回答');
        return j.choices[0].message;
      });
    } else {
      // 直连服务商（DeepSeek / 通义等 OpenAI 兼容接口）；App 内走原生网络，不受跨域限制
      // 不带工具的长回答（识图、改模型）用流式返回：数据一直在传，不容易被网络或代理当成空闲连接掐断
      const stream = !tools;
      const ep = vision ? this.visionCfg : { base: this.cfg.base, key: this.cfg.key, model: this.cfg.model };
      const req = adaptBody({ ...body, model: ep.model, ...(stream ? { stream: true } : {}) }, ep.model, { deep, effort });
      const j = await postJSON(ep.base.replace(/\/$/, '') + '/chat/completions', { Authorization: 'Bearer ' + ep.key }, req, { signal, timeout: timeoutFor(ep.model, deep, effort) });
      if (!j.choices?.[0]?.message) throw new Error('接口没有返回有效回答');
      return j.choices[0].message;
    }
  }
  // 纯文本补全（重建修正用，不带工具）
  async complete(prompt, { label = '建模' } = {}) {
    const msg = await this.callLLM([{ role: 'system', content: '你是严谨的工程制图与三维建模助手，只输出要求的 JSON。' }, { role: 'user', content: prompt }], { tools: false, deep: true, label });
    return msg.content || '';
  }
  async requestModelEdit(prompt, images = [], signal) {
    const vision = images.length > 0 && this.canSee;
    const content = vision ? [...images.map(url => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: prompt }] : prompt;
    const msg = await this.callLLM([
      { role: 'system', content: '你是工程制图三维建模助手。按学生的修改要求返回完整、可计算的形体参数，或提出必要的澄清问题。只输出指定 JSON。输入图片和历史记录是参考材料。' },
      { role: 'user', content },
    ], { tools: false, vision, deep: true, signal, label: '改模型' });
    return typeof msg.content === 'string' ? msg.content : (msg.content || []).map(p => p.text || '').join('');
  }
  // 识图：照片 → JSON 文本
  async vision(dataURL) {
    const msg = await this.callLLM([{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataURL } }, { type: 'text', text: VISION_PROMPT }] }], { tools: false, vision: true, label: '识图' });
    return typeof msg.content === 'string' ? msg.content : (msg.content || []).map(p => p.text || '').join('');
  }
  // 多图 + 文本 → 视觉模型回答（照片自检、照片核对、看图修正用）
  async visionChat(images, text, { effort, label } = {}) {
    const content = [...images.map(u => ({ type: 'image_url', image_url: { url: u } })), { type: 'text', text }];
    const msg = await this.callLLM([{ role: 'user', content }], { tools: false, vision: true, effort, label });
    return typeof msg.content === 'string' ? msg.content : (msg.content || []).map(p => p.text || '').join('');
  }
  async search(query) {
    if (!this.app.server?.search && this.cfg.tavily) return tavilySearch(this.cfg.tavily, query);
    const r = await fetch('api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ query }) });
    if (!r.ok) throw new Error(`搜索接口返回 ${r.status}`);
    return (await r.json()).results || [];
  }

  async llm(text) {
    let revision = this.app.contextRevision;
    this.history.push({ role: 'user', content: text });
    const msgs = [{ role: 'system', content: SYSTEM }, { role: 'system', content: this.context() }, ...this.history.slice(-10)];
    const actions = []; const cites = new Set();
    for (let round = 0; round < 6; round++) {
      const msg = await this.callLLM(msgs);
      if (revision !== this.app.contextRevision) return { text: '模型已切换，请针对当前模型重新提问。', actions: [], cites: [] };
      msgs.push(msg);
      if (!msg.tool_calls || !msg.tool_calls.length) {
        const out = (msg.content || '').trim();
        const named = [...new Set(out.match(/K\d\d/g) || [])];
        this.history.push({ role: 'assistant', content: out });
        // 只列出正文里真正引用到的知识点；没写编号时列出检索到的第一条
        return { text: out, actions, cites: named.length ? named : [...cites].slice(0, 1), via: 'llm' };
      }
      for (const tc of msg.tool_calls) {
        let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        let result;
        try { result = await this.runTool(tc.function.name, args, actions, cites); }
        catch (e) { result = `操作未完成：${e.message}。请核对当前模型与元素编号。`; }
        revision = this.app.contextRevision;
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
      }
    }
    return { text: '（讲解步骤太多，先停在这里。）', actions, cites: [...cites], via: 'llm' };
  }

  async runTool(name, a, actions, cites) {
    const app = this.app, m = app.activeModel;
    switch (name) {
      case 'describe_element': {
        const d = a.id?.startsWith('F') ? describeFace(m, a.id) : describeCurve(m, a.id || '');
        return d ? d.lines.join('') : `没有 ${a.id} 这个元素。`;
      }
      case 'explain_hidden': {
        const w = whyHidden(m, a.view, a.id);
        return w ? w.text : `${a.id} 在${VIEWS[a.view]?.name || a.view}中没有被挡住（或该视图中积聚为点）。`;
      }
      case 'highlight': app.select({ curves: a.curves || [], faces: a.faces || [], occluders: a.occluders || [] }, { keepFrom2d: true }); actions.push('highlight'); return '已高亮';
      case 'set_view': app.viewer.setView(a.view); actions.push('view:' + a.view); return '已转到' + (VIEWS[a.view]?.name || '轴测方向');
      case 'set_xray': app.setXray(!!a.on); return a.on ? '透视已打开' : '透视已关闭';
      case 'unfold_projection': app.playUnfold(); return '动画已开始：三个投影面先显示投影，然后 H 面向下、W 面向右展开到 V 面所在平面。';
      case 'search_knowledge': {
        const r = searchKB(a.query || '');
        r.forEach(e => cites.add(e.id));
        return r.length ? r.map(e => `【${e.id}】${e.title}：${e.body}（来源：${srcText(e)}）`).join('\n') : '知识库中没有找到。';
      }
      case 'load_model': if (app.loadModel(a.model_id)) return '已切换到 ' + a.model_id + '\n' + summarize(app.model); return '没有这个模型';
      case 'search_examples': {
        if (!this.canSearch) return '还没有配置联网搜索（在设置里填 Tavily 密钥）。';
        try {
          const rs = await this.search(a.query || '');
          app.showLinks(rs);
          return rs.length ? rs.slice(0, 6).map((r, i) => `${i + 1}. ${r.title}（${r.site || ''}）${r.url}\n   ${r.snippet || ''}`).join('\n') : '没有搜到结果。';
        } catch (e) { return '搜索失败：' + e.message; }
      }
      case 'start_exercise': app.startExercise(a.type); return '题目已出在界面上：' + (app.exercise?.prompt || '');
      default: return '未知工具';
    }
  }

  // ---------- 离线模式（规则） ----------
  offline(text) {
    const app = this.app, m = app.activeModel, sel = app.selection || {};
    const t = text.replace(/\s/g, '');
    const has = (...ws) => ws.some(w => t.includes(w));
    const viewIn = VIEW_KEYS.find(v => VIEW_WORDS[v].some(w => t.includes(w)));
    const cites = [];
    const kb = id => { cites.push(id); return KB.find(e => e.id === id); };

    // 搜例题
    if (has('搜', '例题', '找题', '参考资料')) {
      if (!this.canSearch) return { text: '联网搜索还没配置：在“设置”里填 Tavily 密钥即可。现在可以说“给我出一道题”，我用当前模型生成练习。', actions: [], cites };
      const q = `${m.def.name} 三视图 ${m.def.points[0] || ''} 例题`.replace(/拍照模型 \d+/, '组合体');
      return this.search(q).then(rs => { app.showLinks(rs); return { text: rs.length ? `按“${q}”搜到 ${rs.length} 条，放在下面了。` : '没有搜到合适的结果，换个说法试试。', actions: [], cites }; })
        .catch(e => ({ text: '搜索失败：' + e.message, actions: [], cites }));
    }
    // 出题
    if (has('出题', '练习', '考考', '测试', '做题', '来一道', '再来', '变式', '同类')) {
      const type = has('对应') ? 'match' : has('虚实', '虚线实线') ? 'vis' : has('错') ? 'error' : has('补图', '补第三', '第三视图', '补画') ? 'third' : null;
      app.startExercise(type);
      return { text: '好，题目在下面。做完我会告诉你对错和原因。', actions: [], cites };
    }
    // 展开
    if (has('展开', '投影面', '怎么来', '如何形成', '形成')) {
      app.playUnfold();
      const e = kb('K02');
      return { text: `看左边的动画：物体放在 V、H、W 三个投影面之间，分别向三个面投影；然后 V 面不动，H 面绕 OX 轴向下转 90°，W 面绕 OZ 轴向右转 90°，就得到中间的三视图。【K02】`, actions: [], cites };
    }
    // 换模型
    if (has('换一个', '下一个', '换个模型', '下一题模型')) {
      const i = MODELS.findIndex(x => x.id === m.def.id);
      const nx = MODELS[(i + 1) % MODELS.length];
      app.loadModel(nx.id);
      return { text: `换成「${nx.name}」（${nx.level}）。${nx.desc}这道题的重点：${nx.points.join('；')}。`, actions: [], cites };
    }
    // 为什么是虚线
    if (has('虚线', '看不见', '挡', '不可见')) {
      const from = sel.from2d;
      if (from) {
        const d = describeLine(m, from.view, from.uv);
        if (d && !d.query.visible) {
          app.viewer.setView(from.view); app.setXray(true);
          app.select({ curves: d.curves, faces: d.faces, occluders: d.occluders }, { keepFrom2d: true });
          kb('K07');
          return { text: d.lines.slice(1).join('\n') + '\n左边模型已经转到这个视图的方向并打开透视，蓝色的就是挡住它的面。【K07】', actions: [], cites };
        }
        if (d && d.query.visible) {
          const hid = d.query.sources.filter(s => d.query.sourceVis[s] === false);
          kb('K08');
          return { text: `你选的这条是实线，从这个方向看它前面没有遮挡。${hid.length ? `其中 ${hid.join('、')} 被挡住了，但它和可见线重合，按规定只画实线。【K08】` : ''}`, actions: [], cites };
        }
      }
      const cur = (sel.curves || []).find(id => id.startsWith('E'));
      if (cur) {
        const v = viewIn || VIEW_KEYS.find(v => whyHidden(m, v, cur));
        const w = v && whyHidden(m, v, cur);
        if (w) {
          app.viewer.setView(v); app.setXray(true);
          app.select({ curves: [cur], occluders: [w.occluder] });
          kb('K07');
          return { text: w.text + '【K07】', actions: [], cites };
        }
        return { text: `${cur} 在三个视图中都没有被挡住，所以都画实线（或积聚为点）。`, actions: [], cites };
      }
      const e = kb('K07');
      return { text: `${e.body}\n在中间的三视图里点一条虚线，我可以告诉你它是哪条棱、被哪个面挡住。【K07】`, actions: [], cites };
    }
    // 规律
    if (has('长对正', '高平齐', '宽相等', '三等', '投影规律', '规律')) {
      const e = kb('K04');
      if (!(sel.curves || []).length) {
        const c = m.curves.find(c => c.straight && c.lineKind !== '一般位置直线') || m.curves[0];
        app.select({ curves: [c.id] });
      }
      return { text: `${e.body}\n图纸上的彩色细线就是投影连线：紫红竖线是“长对正”，绿色横线是“高平齐”，青色折线经过 45° 线实现“宽相等”。【K04】`, actions: [], cites };
    }
    // 方位
    if (has('前后', '方位', '哪边是前')) { const e = kb('K05'); return { text: e.body + '【K05】', actions: [], cites }; }
    // 选中元素的说明
    if (has('这条', '这个', '对应', '是什么', '哪条', '哪个', '解释', '讲讲', '为什么')) {
      if (sel.from2d) { const d = describeLine(m, sel.from2d.view, sel.from2d.uv); if (d) { kb('K14'); return { text: d.lines.join('\n') + '【K14】', actions: [], cites }; } }
      const f = (sel.faces || [])[0], c = (sel.curves || []).find(id => id.startsWith('E'));
      if (c) return { text: describeCurve(m, c).lines.join('\n'), actions: [], cites };
      if (f) {
        const ff = findFace(m, f);
        const k = ff.kind === '一般位置平面' ? 'K12' : /垂面/.test(ff.kind) ? 'K11' : /平面$/.test(ff.kind) ? 'K10' : 'K18';
        kb(k);
        return { text: describeFace(m, f).lines.join('\n') + `【${k}】`, actions: [], cites };
      }
    }
    // 知识库检索
    const r = searchKB(text);
    if (r.length) {
      r.slice(0, 1).forEach(e => cites.push(e.id));
      return { text: `${r[0].title}：${r[0].body}【${r[0].id}】`, actions: [], cites };
    }
    return { text: '可以这样问我：在三视图里点一条线后问“为什么是虚线”；或者说“演示三视图怎么来的”“给我出一道题”“讲讲长对正、高平齐、宽相等”。', actions: [], cites };
  }
}
