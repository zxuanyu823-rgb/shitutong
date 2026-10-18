// 视图通 · 学习报告
// 以方法的形式挂到 App 上，this 指向 App 实例。
import { $, esc } from './util.js';
import { VIEWS } from './engine.js';
import { loadStats, TYPES } from './exercise.js';


export const reportMethods = {
  showReport() {
    const s = loadStats();
    const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
    const types = Object.entries(TYPES).map(([k, t]) => { const v = s.byType[k] || { total: 0, right: 0 }; return `<div class="row"><span>${t.name}（${v.right}/${v.total}）</span><div class="track"><div class="fill" style="width:${pct(v.right, v.total)}%"></div></div><span>${pct(v.right, v.total)}%</span></div>`; }).join('');
    const errs = Object.entries(s.errors).sort((a, b) => b[1] - a[1]);
    const maxE = Math.max(1, ...errs.map(e => e[1]));
    const errHtml = errs.length ? errs.map(([k, n]) => `<div class="row"><span>${esc(k)}</span><div class="track"><div class="fill" style="width:${n / maxE * 100}%;background:var(--bad)"></div></div><span>${n}</span></div>`).join('') : '<p class="note">还没有错题记录。</p>';
    const avg = s.log.length ? Math.round(s.log.reduce((a, b) => a + b.ms, 0) / s.log.length / 1000) : 0;
    $('#reportBody').innerHTML = `<div class="report-grid"><div class="stat"><b>${s.total}</b><span>完成题数</span></div><div class="stat"><b>${pct(s.right, s.total)}%</b><span>正确率</span></div><div class="stat"><b>${avg}s</b><span>平均用时</span></div></div>
      <h4 style="margin:10px 0 0">各题型正确率</h4><div class="bars">${types}</div>
      <h4 style="margin:10px 0 0">错因分布</h4><div class="bars">${errHtml}</div>
      <p class="note">记录只保存在本机浏览器中。</p>`;
    $('#reportDlg').showModal();
  },

  exportCSV() {
    const s = loadStats();
    const rows = [['时间', '模型', '题型', '视图', '是否正确', '用时(秒)', '错因']].concat(s.log.map(r => [new Date(r.t).toLocaleString('zh-CN'), r.model, TYPES[r.type]?.name || r.type, VIEWS[r.view]?.name || r.view, r.ok ? '对' : '错', (r.ms / 1000).toFixed(1), r.err || '']));
    const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = '视图通学习记录.csv'; a.click();
  },
};
