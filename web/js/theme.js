// 视图通 · 界面外观：可更换的背景、点击波纹、启动动画
import { shrinkImage } from './image.js';

const KEY = 'stt.bg', IMG = 'stt.bgImage', FONT = 'stt.fontScale';
export const BACKGROUNDS = [
  ['mist', '冷灰'], ['grid', '方格纸'], ['blueprint', '蓝图'], ['warm', '暖纸'], ['dusk', '晨雾'], ['custom', '我的图片'],
];
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

export function applyBackground(kind, image) {
  const root = document.documentElement;
  if (kind === 'custom') {
    image = image || store.get(IMG);
    if (!image) kind = 'mist';
    else root.style.setProperty('--bg-image', `url("${image}")`);
  }
  root.dataset.bg = kind;
  document.querySelectorAll('#bgSwatches [data-bg]').forEach(b => b.classList.toggle('on', b.dataset.bg === kind));
}

export function initBackground() {
  applyBackground(store.get(KEY) || 'mist');
  const box = document.querySelector('#bgSwatches');
  if (!box) return;
  box.innerHTML = BACKGROUNDS.map(([k, name]) => `<button type="button" class="sw sw-${k}" data-bg="${k}"><i></i><span>${name}</span></button>`).join('');
  box.onclick = e => {
    const b = e.target.closest('[data-bg]'); if (!b) return;
    if (b.dataset.bg === 'custom' && !store.get(IMG)) { document.querySelector('#bgFile').click(); return; }
    store.set(KEY, b.dataset.bg); applyBackground(b.dataset.bg);
  };
  document.querySelector('#bgFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const url = await shrinkImage(f, 1600, 0.8);
    // 图片太大存不下时，这次仍然生效，只是下次打开要重新选
    store.set(IMG, url); store.set(KEY, 'custom');
    applyBackground('custom', url);
  };
}

// 字体大小：界面文字统一乘一个倍率（图纸里的字不变），立即生效并记住
const FONT_STEPS = [['小', 90], ['标准', 100], ['大', 115], ['特大', 130]];
export function applyFontScale(pct) {
  pct = Math.max(80, Math.min(140, Math.round(+pct || 100)));
  document.documentElement.style.setProperty('--fs', String(pct / 100));
  const r = document.querySelector('#fontScale'), o = document.querySelector('#fontScaleVal');
  if (r) r.value = pct;
  if (o) o.textContent = pct + '%';
  document.querySelectorAll('#fontSteps [data-fs]').forEach(b => b.classList.toggle('on', +b.dataset.fs === pct));
  return pct;
}
export function initFontScale() {
  const box = document.querySelector('#fontSteps');
  if (box) {
    box.innerHTML = FONT_STEPS.map(([n, v]) => `<button type="button" class="ghost" data-fs="${v}">${n}</button>`).join('');
    box.onclick = e => { const b = e.target.closest('[data-fs]'); if (b) store.set(FONT, String(applyFontScale(b.dataset.fs))); };
  }
  const r = document.querySelector('#fontScale');
  if (r) r.oninput = () => store.set(FONT, String(applyFontScale(r.value)));
  applyFontScale(store.get(FONT) || 100);
}

// 点击波纹：按钮类元素按下时从手指位置扩散一圈
export function initRipples() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest('button, .filebtn, .chip, .seg button, .group button');
    if (!el || el.disabled) return;
    const r = el.getBoundingClientRect(), d = Math.max(r.width, r.height);
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.style.overflow = 'hidden';
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    el.appendChild(s);
    s.addEventListener('animationend', () => s.remove());
  }, { passive: true });
}

// 启动画面至少停留一小会儿，让印章动画播完
const t0 = performance.now();
export async function finishSplash() {
  const wait = Math.max(0, 900 - (performance.now() - t0));
  if (wait) await new Promise(r => setTimeout(r, wait));
  document.querySelector('#loading')?.classList.add('done');
  document.body.classList.add('ready');
}
