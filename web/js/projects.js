// 本机题册：只存图纸、照片和建模参数，几何对象在打开时重新生成。
import { clone } from './util.js';
export const PROJECT_VERSION = 1;
const newId = () => globalThis.crypto?.randomUUID?.() || `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function snapshotCandidate(c) {
  const out = {};
  for (const key of ['name', 'score', 'error', 'perView', 'diffs', 'explain', 'photoOk', 'photoStatus', 'photoError', 'issues', 'alt', 'userEdited', 'request', 'parentName', 'createdAt', 'source']) {
    if (c[key] !== undefined) out[key] = clone(c[key]);
  }
  out.ops = (c.ops || []).map(({ vol, ...op }) => clone(op));
  return out;
}

export function normalizeProject(value) {
  if (!value || typeof value !== 'object') throw new Error('题目数据为空');
  if (value.version != null && value.version !== PROJECT_VERSION) throw new Error('题目版本暂不支持，请更新应用');
  const kind = value.kind === 'model' ? 'model' : 'photo';
  if (kind === 'photo' && (!value.drawing?.views || !value.drawing?.dims)) throw new Error('题目缺少可用的三视图数据');
  if (kind === 'model' && !value.model?.ops?.length) throw new Error('项目缺少可用的建模参数');
  const now = new Date().toISOString();
  const candidates = (value.candidates || []).map(snapshotCandidate);
  const currentIndex = Number.isInteger(value.currentIndex) && value.currentIndex >= 0 && value.currentIndex < candidates.length ? value.currentIndex : candidates.length ? 0 : -1;
  return {
    version: PROJECT_VERSION, kind, id: value.id || newId(),
    title: String(value.title || value.model?.name || value.raw?.question || value.raw?.shape || '拍照题目').slice(0, 120),
    createdAt: value.createdAt || now, updatedAt: value.updatedAt || now,
    originalPhoto: value.originalPhoto || null, photo: value.photo || null,
    inputLabel: String(value.inputLabel || ''), raw: clone(value.raw), json: clone(value.json),
    drawing: clone(value.drawing), candidates, currentIndex,
    missing: clone(value.missing || []), state: clone(value.state || {}), refs: String(value.refs || ''),
    edited: !!value.edited, editHistory: clone(value.editHistory || []),
    model: kind === 'model' ? {
      id: value.model.id, name: value.model.name, level: value.model.level || '对话建模',
      desc: value.model.desc || '', points: clone(value.model.points || []), ops: snapshotCandidate(value.model).ops,
    } : null,
  };
}

export class ProjectStore {
  constructor(name = 'shitutong-projects') { this.name = name; this.dbPromise = null; }
  open() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('当前浏览器不支持本机题册')); return; }
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('projects', { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); this.dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('无法打开本机题册'));
      req.onblocked = () => reject(new Error('题册正在更新，请关闭其他打开本应用的页面后重试'));
    }).catch(error => { this.dbPromise = null; throw error; });
    return this.dbPromise;
  }
  async request(mode, action) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('projects', mode);
      const req = action(tx.objectStore('projects'));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = () => reject(tx.error || req.error || new Error('题册操作未完成'));
      tx.onerror = () => reject(tx.error || req.error || new Error('题册操作失败'));
    });
  }
  async list() {
    const all = await this.request('readonly', store => store.getAll());
    return all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(p => ({
      id: p.id, kind: p.kind || 'photo', title: p.title, createdAt: p.createdAt, updatedAt: p.updatedAt,
      candidateCount: p.candidates?.length || (p.model ? 1 : 0), hasPhoto: !!p.photo,
      currentName: p.candidates?.[p.currentIndex]?.name || p.model?.name || '',
    }));
  }
  async get(id) {
    const p = await this.request('readonly', store => store.get(id));
    return p ? normalizeProject(p) : null;
  }
  async put(project) {
    const p = normalizeProject(project);
    p.updatedAt = new Date().toISOString();
    await this.request('readwrite', store => store.put(p));
    return p;
  }
  async delete(id) { await this.request('readwrite', store => store.delete(id)); }
}
