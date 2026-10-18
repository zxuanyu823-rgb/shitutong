// 视图通 · 网络请求
// 在安卓 App 里通过原生桥发请求（不受浏览器跨域限制）；在浏览器里用 fetch。
const cbs = {};
if (typeof window !== 'undefined') {
  window.__netCb = (id, status, text) => { const c = cbs[id]; delete cbs[id]; if (c) c({ status, text }); };
}
export const isApp = () => typeof window !== 'undefined' && !!window.AndroidNet;

// 原生网络异常 → 能看懂的中文提示
function netError(text, midway) {
  const t = String(text || '');
  const why = /SocketTimeout|timed out|timeout/i.test(t) ? '等待服务器响应超时'
    : /UnknownHost/i.test(t) ? '无法解析接口地址（检查网络或接口地址）'
    : /SSL|Certificate|Handshake/i.test(t) ? '安全连接失败（检查网络或代理设置）'
    : /reset|abort|closed|broken pipe|EOF/i.test(t) ? '连接被中断（网络切换、代理或 App 切到后台都可能导致）'
    : /ConnectException|refused|unreachable/i.test(t) ? '连不上服务器'
    : '网络连接失败';
  const e = new Error(`${why}${midway ? '，数据没收完' : ''}（${t.slice(0, 80)}）`);
  e.network = true;
  return e;
}

// 接口错误信息里的说明（如“模型不存在”“余额不足”）
function apiError(status, text) {
  let msg = '';
  try { const j = JSON.parse(text); msg = j.error?.message || j.message || j.msg || ''; } catch {}
  return new Error(`接口返回 ${status}${msg ? '：' + String(msg).slice(0, 120) : ''}`);
}

// 兼容两种返回：普通 JSON，以及流式返回（SSE，每行 data: {...}）
export function parseBody(text) {
  const t = String(text || '').trim();
  if (t.startsWith('data:') || t.startsWith(':')) {
    let content = '', role = 'assistant', last = null;
    for (const line of t.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw new Error('接口返回错误：' + (j.error.message || JSON.stringify(j.error)).slice(0, 120));
      const delta = j.choices?.[0]?.delta || j.choices?.[0]?.message || {};
      if (typeof delta.content === 'string') content += delta.content;
      if (delta.role) role = delta.role;
      last = j;
    }
    if (!last) throw new Error('接口没有返回内容');
    return { ...last, choices: [{ index: 0, message: { role, content } }] };
  }
  if (/^javax?\.|Exception:/.test(t)) throw netError(t, true);
  try { return JSON.parse(t); }
  catch { throw new Error('接口返回的不是 JSON：' + t.slice(0, 80)); }
}

export async function postJSON(url, headers, body, { signal, timeout = 90000, native = true, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await postOnce(url, headers, body, { signal, timeout, native }); }
    catch (e) {
      // 只对网络中断重试一次；接口报错、超时、用户取消都不重试
      if (!e.network || attempt >= retries || signal?.aborted) throw e;
      await new Promise(r => setTimeout(r, 1200));
    }
  }
}

async function postOnce(url, headers, body, { signal, timeout, native }) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
  try {
    if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (native && isApp()) {
      const id = Math.random().toString(36).slice(2);
      const r = await new Promise((resolve, reject) => {
        const cancel = () => { delete cbs[id]; reject(new DOMException('请求已取消', 'AbortError')); };
        cbs[id] = r => { controller.signal.removeEventListener('abort', cancel); resolve(r); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        try { window.AndroidNet.post(id, url, JSON.stringify({ 'Content-Type': 'application/json', ...headers }), payload); }
        catch (e) { delete cbs[id]; controller.signal.removeEventListener('abort', cancel); reject(e); }
      });
      if (!r.status || r.status < 0) throw netError(r.text, r.status < 0);
      if (r.status < 200 || r.status >= 300) throw apiError(r.status, r.text);
      return parseBody(r.text);
    }
    let res;
    try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload, signal: controller.signal, credentials: 'same-origin' }); }
    catch (e) { if (e.name === 'AbortError') throw e; throw netError(e.message); }
    const text = await res.text();
    if (!res.ok) throw apiError(res.status, text);
    return parseBody(text);
  } catch (e) {
    if (timedOut) throw new Error('接口响应超时，请稍后重试');
    throw e;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}

// Tavily 联网搜索，结果统一成 {title, url, snippet, site}
export async function tavilySearch(key, query) {
  const j = await postJSON('https://api.tavily.com/search', { Authorization: 'Bearer ' + key }, { api_key: key, query, max_results: 6, search_depth: 'basic', include_answer: false });
  return (j.results || []).map(r => ({ title: r.title || '', url: r.url || '', snippet: r.content || '', site: (() => { try { return new URL(r.url).hostname; } catch { return ''; } })() })).filter(r => /^https?:/.test(r.url));
}
