// 视图通 · 和安卓外壳的配合：长任务期间保持后台运行、完成后发通知。浏览器里这些都是空操作。
const bridge = () => (typeof window !== 'undefined' && window.AndroidNet) || null;
let holds = 0, label = '', lastText = '', lastSent = 0, pendingTimer = null;

function send(text) {
  const b = bridge(); if (!b?.busy) return;
  try { b.busy(holds > 0, text || label || '正在处理…'); } catch {}
}

// 开始一项长任务（识图、建模、改模型）：切后台、锁屏也继续算。返回结束函数。
export function holdAwake(what = '正在处理…') {
  holds++; label = what; send(what);
  let done = false;
  return ({ notify } = {}) => {
    if (done) return; done = true;
    holds = Math.max(0, holds - 1);
    if (!holds) { clearTimeout(pendingTimer); send(''); if (notify) notifyIfHidden(notify.title, notify.text); }
  };
}

// 更新通知栏里的进度文字（限频，避免刷屏）
export function progress(text) {
  if (!holds || !bridge()?.busy) return;
  lastText = String(text || '').split('\n')[0].slice(0, 60);
  const now = Date.now();
  if (now - lastSent > 1500) { lastSent = now; send(lastText); }
  else { clearTimeout(pendingTimer); pendingTimer = setTimeout(() => { lastSent = Date.now(); send(lastText); }, 1500); }
}

// 用户不在 App 里时，完成后发一条通知
export function notifyIfHidden(title, text) {
  const b = bridge(); if (!b?.notify) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  try { b.notify(title, text); } catch {}
}

// 网页刚加载：上一次（被系统回收前）留下的前台服务和通知栏提示收掉
if (bridge()?.busy) { try { bridge().busy(false, ''); } catch {} }

// 长任务的断点：照片和识别、量好的图线暂存在本机，网页万一在后台被系统回收，回来可以接着做
const PENDING = 'stt.pendingRecon';
export function savePending(data) { try { localStorage.setItem(PENDING, JSON.stringify({ ...loadPending(), ...data, t: Date.now() })); } catch {} }
export function loadPending(maxAge = 6 * 3600e3) {
  try { const p = JSON.parse(localStorage.getItem(PENDING) || 'null'); return p && Date.now() - p.t < maxAge ? p : null; } catch { return null; }
}
export function clearPending() { try { localStorage.removeItem(PENDING); } catch {} }

