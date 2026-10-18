// 视图通 · 各家大模型接口的差异（网页端和服务器共用）
// 都是 OpenAI 兼容的 /chat/completions，但思考强度、采样参数各家写法不同，这里统一调整。
export const PRESETS = {
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-flash', vision: 'deepseek-flash' },
  kimi: { name: 'Kimi K3（国际版 platform.kimi.ai）', base: 'https://api.moonshot.ai/v1', model: 'kimi-k3', vision: 'kimi-k3' },
  kimicn: { name: 'Kimi K3（中国版 platform.moonshot.cn）', base: 'https://api.moonshot.cn/v1', model: 'kimi-k3', vision: 'kimi-k3' },
  qwen: { name: '通义千问（阿里云百炼）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', vision: 'qwen-vl-max' },
  custom: { name: '其他 OpenAI 兼容接口', base: '', model: '', vision: '' },
};

export const EFFORTS = ['low', 'high', 'max'];
const family = model => {
  const m = String(model || '').toLowerCase();
  if (/^kimi-k3/.test(m)) return 'kimi3';
  if (/^kimi-/.test(m)) return 'kimi';
  if (/^deepseek-/.test(m) && m !== 'deepseek-chat') return 'deepseek';
  if (/^qwen3/.test(m)) return 'qwen3';
  return '';
};
export const isKimi = model => /^kimi/.test(family(model));

// deep：识图、建模这类要想清楚的任务按设置的强度；助教对话用最快的强度
export function adaptBody(body, model, { deep = false, effort = 'high' } = {}) {
  const e = deep ? (EFFORTS.includes(effort) ? effort : 'high') : 'low';
  switch (family(model)) {
    case 'kimi3': body.reasoning_effort = e; // fall through
    case 'kimi':
      // Kimi K2.5 之后 temperature、top_p 等是固定值，传了会报错
      for (const k of ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty']) delete body[k];
      break;
    case 'deepseek': body.reasoning_effort = e; break;       // low / high / max
    case 'qwen3':                                          // 百炼：开关 + 思考 token 上限
      body.enable_thinking = e !== 'low';
      if (e === 'high') body.thinking_budget = 8192; else delete body.thinking_budget;
      break;
  }
  return body;
}

// 带思考的模型要等更久；最准档再放宽
export function timeoutFor(model, deep, effort = 'high') {
  const base = isKimi(model) ? (deep ? 480000 : 240000) : (deep ? 240000 : 120000);
  return deep && effort === 'max' ? base * 1.5 : base;
}
