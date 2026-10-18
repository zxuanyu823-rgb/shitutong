// 视图通 · “我的题册”：保存、自动保存、打开题目
import { $, esc } from './util.js';
// 以方法的形式挂到 App 上，this 指向 App 实例。



export const projectMethods = {
  captureProject() {
    const editHistory = this.editor.exportState();
    if (this.mode === 'photo' && this.recon?.drawing) {
      const project = this.recon.captureProject();
      project.editHistory = editHistory;
      // 对比“修改前”只是预览，题册始终记录当前版本。
      if (this.editor.sourcePhoto && this.editor.current) {
        const index = project.candidates.findIndex(c => JSON.stringify(c.ops) === JSON.stringify(this.editor.current.ops));
        if (index >= 0) project.currentIndex = index;
      }
      return project;
    }
    const model = this.model;
    if (!model) throw new Error('请先选择或生成模型');
    if (!this.currentProject) this.currentProject = { id: crypto.randomUUID?.() || `project-${Date.now().toString(36)}`, title: model.def.name };
    const snapshot = { ...this.currentProject, kind: 'model', title: this.currentProject.title || model.def.name, model: { ...model.def }, editHistory };
    this.modelProjects.set(model.def.id, snapshot);
    return snapshot;
  },

  onProjectChange() {
    if (this.restoringProject || this.editor?.applying || this.editor?.busy) return;
    this.projectDirty = true;
    $('#projectsBtn').textContent = '我的题册 · 待保存';
    clearTimeout(this.saveTimer);
    try { this.pendingSave = { snapshot: this.captureProject(), revision: this.contextRevision }; }
    catch { return; }
    this.saveTimer = setTimeout(() => this.flushPendingSave(), 450);
  },

  flushPendingSave() {
    clearTimeout(this.saveTimer);
    const pending = this.pendingSave; this.pendingSave = null;
    if (pending) return this.saveProject({ ...pending, silent: true });
  },

  async saveProject({ title, silent = false, snapshot, revision = this.contextRevision } = {}) {
    if (this.editor.busy && !snapshot) return null;
    clearTimeout(this.saveTimer);
    try {
      snapshot ||= this.captureProject();
      this.pendingSave = null;
      if (title?.trim()) snapshot.title = title.trim();
      const saved = await this.projects.put(snapshot);
      if (revision === this.contextRevision) {
        this.currentProject = saved; this.projectDirty = false;
        if (saved.kind === 'photo') this.recon.projectTitle = saved.title;
        else this.modelProjects.set(this.model.def.id, saved);
        $('#projectsBtn').textContent = '我的题册';
        if (this.chatIntent === 'edit') this.editor.setStatus(`已保存到题册：${saved.title}。可以继续修改。`, 'success');
      }
      if (!silent) this.say('bot', `已保存「${saved.title}」。下次从“我的题册”打开，可继续查看和修改。`);
      return saved;
    } catch (e) {
      this.projectDirty = true; $('#projectsBtn').textContent = '题册 · 保存失败';
      this.editor.setStatus(`保存失败：${e.message}，当前模型仍保留在页面中。`, 'error');
      if (!silent) this.say('bot', `题目没有保存成功：${e.message}`);
      return null;
    }
  },

  async showProjects() {
    const dialog = $('#projectsDlg');
    $('#projectName').value = this.mode === 'photo' ? this.recon?.projectTitle || this.recon?.raw?.shape || '拍照题目' : this.currentProject?.title || this.model.def.name;
    if (!dialog.open) dialog.showModal();
    const list = $('#projectList'); list.textContent = '正在读取题册…';
    try {
      const projects = await this.projects.list();
      list.innerHTML = projects.length ? projects.map(p => `<article class="project-item"><div><b>${esc(p.title)}</b><p>${p.kind === 'photo' ? '拍照题目' : '我的模型'} · ${esc(new Date(p.updatedAt).toLocaleString('zh-CN'))}</p></div><button data-open="${esc(p.id)}">打开</button><button class="ghost" data-delete="${esc(p.id)}">删除</button></article>`).join('') : '<p class="note">还没有保存的题目。可保存当前模型；对话修改和拍照重建会自动保存。</p>';
      list.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try { await this.openProject(b.dataset.open); dialog.close(); this.openChat?.(); }
        catch (e) { this.say('bot', `打开题目失败：${e.message}`); b.textContent = '打开失败，可重试'; b.disabled = false; }
      });
      list.querySelectorAll('[data-delete]').forEach(b => b.onclick = async () => {
        if (b.dataset.armed !== 'true') { b.dataset.armed = 'true'; b.textContent = '确认删除'; return; }
        try { await this.projects.delete(b.dataset.delete); if (this.currentProject?.id === b.dataset.delete) this.currentProject = null; await this.showProjects(); }
        catch (e) { b.textContent = '删除失败，可重试'; b.disabled = false; }
      });
    } catch (e) { list.textContent = `题册暂时无法打开：${e.message}`; }
  },

  async openProject(id) {
    const p = await this.projects.get(id);
    if (!p) throw new Error('这道题目已不存在');
    clearTimeout(this.saveTimer); this.restoringProject = true; this.editor.invalidate();
    try {
      if (p.kind === 'photo') {
        await this.setMode('photo'); await this.recon.restoreProject(p);
      } else {
        await this.manifold();
        const def = { ...p.model, id: `saved-${p.id}`, level: '我的模型' };
        this.addCustomModel(def); await this.setMode('learn'); this.loadModel(def.id);
      }
      this.currentProject = p;
      if (p.kind === 'model') this.modelProjects.set(this.model.def.id, p);
      this.editor.restore(p.editHistory); this.projectDirty = false;
      this.setChatIntent('edit');
      this.editor.setStatus(`已打开「${p.title}」，可以继续修改。`);
      this.say('bot', `已打开题册中的「${p.title}」。可以直接描述模型哪里不对，也可以切到“学习讲解”。`);
    } finally { this.restoringProject = false; }
  },
};
