// 视图通 · 服务端（零依赖，Node.js 18+）
// 作用：①托管网页；②代理大模型接口（API Key 只放在服务器上）；③评审账号登录，防止接口被滥用。
//
// 配置：同目录下的 config.json，或同名环境变量（环境变量优先）
//   PORT            监听端口，默认 8080
//   LLM_BASE_URL    OpenAI 兼容接口地址，如 https://api.deepseek.com
//   LLM_MODEL       模型名称，如 deepseek-chat
//   LLM_API_KEY     接口密钥
//   REVIEW_USER     评审账号（留空则不需要登录）
//   REVIEW_PASS     评审密码
//   SESSION_SECRET  会话签名密钥（随便写一串长字符）
//   VISION_MODEL    视觉模型（拍照识图），如 kimi-k3、qwen-vl-max；VISION_BASE_URL / VISION_API_KEY 不填则沿用上面的
//                   Kimi K3：VISION_BASE_URL=https://api.moonshot.ai/v1（中国版 https://api.moonshot.cn/v1），VISION_MODEL=kimi-k3
//   SEARCH_API_KEY  联网搜索密钥（博查 Web Search API）；SEARCH_URL 可改接口地址
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adaptBody, timeoutFor } from '../web/js/providers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let file = {};
try { file = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8')); } catch {}
const cfg = k => process.env[k] ?? file[k] ?? '';
const PORT = +(cfg('PORT') || 8080);
const ROOT = path.resolve(here, cfg('WEB_ROOT') || '../web');
const LLM = { base: cfg('LLM_BASE_URL').replace(/\/$/, ''), model: cfg('LLM_MODEL'), key: cfg('LLM_API_KEY') };
const LOGIN = { user: cfg('REVIEW_USER'), pass: cfg('REVIEW_PASS') };
const VISION = { base: (cfg('VISION_BASE_URL') || LLM.base).replace(/\/$/, ''), model: cfg('VISION_MODEL'), key: cfg('VISION_API_KEY') || LLM.key };
const SEARCH = { url: cfg('SEARCH_URL') || 'https://api.bochaai.com/v1/web-search', key: cfg('SEARCH_API_KEY') };
const visionOn = !!(VISION.base && VISION.model && VISION.key);
const searchOn = !!SEARCH.key;
const SECRET = cfg('SESSION_SECRET') || crypto.randomBytes(24).toString('hex');
const llmOn = !!(LLM.base && LLM.model && LLM.key);
const loginOn = !!LOGIN.pass;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const COMPRESS = new Set(['.html', '.js', '.css', '.json', '.svg', '.wasm', '.txt']);
const gzCache = new Map();

function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function makeToken(user) { const exp = Date.now() + 7 * 864e5; const v = `${Buffer.from(user).toString('base64url')}.${exp}`; return `${v}.${sign(v)}`; }
function checkToken(t) {
  if (!t) return false;
  const [u, exp, sig] = t.split('.');
  if (!u || !exp || !sig) return false;
  const v = `${u}.${exp}`, good = sign(v);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return +exp > Date.now();
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])); }
const authed = req => !loginOn || checkToken(cookies(req).stt_s);
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 简单限流：每个会话/IP 每分钟 30 次
const hits = new Map();
function limited(key) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < 60e3);
  arr.push(now); hits.set(key, arr);
  return arr.length > 30;
}
// 失败登录限流
const fails = new Map();

async function api(req, res, url) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (url.pathname === '/api/config') return send(res, 200, { llm: llmOn, vision: visionOn, search: searchOn, loginRequired: loginOn, loggedIn: authed(req) });
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const f = fails.get(ip) || { n: 0, t: 0 };
    if (f.n >= 8 && Date.now() - f.t < 10 * 60e3) return send(res, 429, { error: '尝试次数过多，请稍后再试' });
    let b = {}; try { b = JSON.parse(await readBody(req, 1e4)); } catch {}
    if (loginOn && safeEq(b.user || '', LOGIN.user) && safeEq(b.pass || '', LOGIN.pass)) {
      fails.delete(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `stt_s=${makeToken(b.user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}` });
    }
    fails.set(ip, { n: f.n + 1, t: Date.now() });
    return send(res, 401, { error: '账号或密码错误' });
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    if (!authed(req)) return send(res, 401, { error: '请先登录' });
    if (!llmOn) return send(res, 503, { error: '服务器未配置大模型' });
    if (limited(cookies(req).stt_s || ip)) return send(res, 429, { error: '请求太频繁，请稍后再试' });
    let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: '请求格式错误' }); }
    const payload = { model: LLM.model, messages: b.messages, temperature: b.temperature ?? 0.3, stream: false };
    if (b.tools) { payload.tools = b.tools; payload.tool_choice = b.tool_choice || 'auto'; }
    return forward(res, LLM, payload, { deep: b.deep === true, effort: b.effort });
  }
  if (url.pathname === '/api/vision' && req.method === 'POST') {
    if (!authed(req)) return send(res, 401, { error: '请先登录' });
    if (!visionOn) return send(res, 503, { error: '服务器未配置视觉模型' });
    if (limited((cookies(req).stt_s || ip) + ':v')) return send(res, 429, { error: '请求太频繁，请稍后再试' });
    let b; try { b = JSON.parse(await readBody(req, 12e6)); } catch { return send(res, 400, { error: '请求格式错误' }); }
    return forward(res, VISION, { model: VISION.model, messages: b.messages, temperature: b.temperature ?? 0.1, stream: false }, { deep: true, effort: b.effort });
  }
  if (url.pathname === '/api/search' && req.method === 'POST') {
    if (!authed(req)) return send(res, 401, { error: '请先登录' });
    if (!searchOn) return send(res, 503, { error: '服务器未配置搜索' });
    if (limited((cookies(req).stt_s || ip) + ':s')) return send(res, 429, { error: '请求太频繁，请稍后再试' });
    let b; try { b = JSON.parse(await readBody(req, 1e4)); } catch { return send(res, 400, { error: '请求格式错误' }); }
    const query = String(b.query || '').slice(0, 120);
    if (!query) return send(res, 400, { error: '缺少搜索词' });
    try {
      const r = await fetch(SEARCH.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SEARCH.key }, body: JSON.stringify({ query, summary: true, count: 8 }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('[search]', r.status, JSON.stringify(j).slice(0, 200)); return send(res, 502, { error: `搜索接口返回 ${r.status}` }); }
      // 博查返回 data.webPages.value；也兼容其他常见格式
      const list = j?.data?.webPages?.value || j?.webPages?.value || j?.results || j?.data?.results || [];
      const results = list.map(x => ({ title: x.name || x.title || '', url: x.url || x.link || '', snippet: x.summary || x.snippet || x.content || '', site: x.siteName || x.site || '' })).filter(x => /^https?:/.test(x.url));
      return send(res, 200, { results });
    } catch (e) { console.error('[search]', e.message); return send(res, 502, { error: '搜索接口连接失败' }); }
  }
  send(res, 404, { error: 'not found' });
}

// 思考强度、采样参数按各家接口调整（与网页端共用 providers.js）
async function forward(res, ep, payload, { deep = false, effort = 'high' } = {}) {
  adaptBody(payload, payload.model, { deep, effort });
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutFor(payload.model, deep, effort) - 10e3);
  try {
    const r = await fetch(ep.base + '/chat/completions', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ep.key }, body: JSON.stringify(payload) });
    const text = await r.text();
    if (!r.ok) console.error('[llm]', r.status, text.slice(0, 300));
    return send(res, r.ok ? 200 : 502, r.ok ? text : { error: `模型接口返回 ${r.status}` });
  } catch (e) {
    console.error('[llm]', e.message);
    return send(res, 502, { error: '模型接口连接失败' });
  } finally { clearTimeout(timer); }
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const fp = path.resolve(ROOT, '.' + p);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    const ext = path.extname(fp).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
    const gz = COMPRESS.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (!gz) { res.writeHead(200, headers); return fs.createReadStream(fp).pipe(res); }
    const key = fp + ':' + st.mtimeMs;
    let buf = gzCache.get(key);
    if (!buf) { buf = zlib.gzipSync(fs.readFileSync(fp), { level: 9 }); gzCache.set(key, buf); }
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': buf.length, Vary: 'Accept-Encoding' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    serveStatic(req, res, url);
  } catch (e) { console.error(e); send(res, 500, { error: 'server error' }); }
}).listen(PORT, () => {
  console.log(`视图通已启动：http://localhost:${PORT}`);
  console.log(`  大模型：${llmOn ? LLM.model + ' @ ' + LLM.base : '未配置（使用离线讲解）'}`);
  console.log(`  视觉模型：${visionOn ? VISION.model : '未配置（拍照识图不可用）'}`);
  console.log(`  联网搜索：${searchOn ? '已配置' : '未配置'}`);
  console.log(`  评审登录：${loginOn ? '已开启，账号 ' + LOGIN.user : '未开启'}`);
});
