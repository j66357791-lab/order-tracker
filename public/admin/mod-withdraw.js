// admin/mod-withdraw.js — 提现审批面板（iframe → 原生面板迁移 · 第 2 批，来源 withdraw.html）
// 写手发起的提现申请：确认打款 / 驳回（需填原因）
// 说明：原页面的行内 onclick="wdPay('id')" 改为 data-* + 事件委托——模块作用域的函数不再是全局，行内写法会直接报 undefined
import { api, esc, toast, cnTime } from './app.js';

export function mount(root) {
  root.innerHTML = `
  <div class="content-head">
    <div>
      <h1 class="serif">提现审批</h1>
      <div class="sub">写手发起的提现申请 · 确认打款 = 标记已打款；订单型提现会同时结清对应派单卡、同步台账为已结算、解冻现金红包</div>
    </div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="wdReload">刷新</button>
  </div>

  <div class="card">
    <div class="grid3">
      <div class="stat plain warn"><b id="wdPending">0</b><span>待处理</span></div>
      <div class="stat plain"><b id="wdPaid">0</b><span>已打款</span></div>
      <div class="stat plain danger"><b id="wdRejected">0</b><span>已驳回</span></div>
    </div>
    <div class="inline" style="margin-top:18px">
      <select id="wdStatus">
        <option value="">全部状态</option><option>待处理</option><option>已打款</option><option>已驳回</option>
      </select>
      <select id="wdType">
        <option value="">全部类型</option><option value="bonus">激励奖励</option><option value="order">单子奖励</option>
      </select>
      <input id="wdQ" placeholder="搜索姓名 / 支付宝账号 / 金额">
    </div>
    <div class="err" id="wdErr"></div>
  </div>

  <div id="wdList"><div class="empty">加载中…</div></div>

  <div class="mask" id="wdRejectMask">
    <div class="modal">
      <h3 class="serif">驳回提现申请</h3>
      <div class="sub" id="wdRejectWho"></div>
      <div class="f-row"><label>驳回原因（写手端可见）</label>
        <textarea id="wdRejectReason" rows="3" placeholder="例如：支付宝账号与实名不一致，请修改后重新申请"></textarea>
      </div>
      <div class="err" id="wdRejectErr"></div>
      <div class="inline" style="justify-content:flex-end">
        <button class="btn-ghost" id="wdRejectCancel">取消</button>
        <button class="btn-danger" id="wdRejectGo">确认驳回</button>
      </div>
    </div>
  </div>`;

  const $ = id => root.querySelector('#' + id);
  let ALL = [];
  let rejectId = null;

  function paint() {
    const box = $('wdList');
    if (!ALL.length) { box.innerHTML = '<div class="empty">暂无提现申请</div>'; return; }
    const q = ($('wdQ').value || '').trim().toLowerCase();
    const rows = q ? ALL.filter(w =>
      (w.displayName || '').toLowerCase().includes(q) ||
      (w.amount != null && String(w.amount).includes(q)) ||
      (w.alipay && (String(w.alipay.account || '').toLowerCase().includes(q) || String(w.alipay.name || '').toLowerCase().includes(q)))
    ) : ALL;
    if (!rows.length) { box.innerHTML = '<div class="empty">没有匹配的提现申请</div>'; return; }

    box.innerHTML = rows.map(w => {
      const pending = w.status === '待处理';
      const stCls = pending ? 'st-wait' : (w.status === '已打款' ? 'st-ok' : 'st-bad');
      const stTxt = w.status + (w.status === '已驳回' && w.reason ? '（' + w.reason + '）' : '');
      const acts = pending
        ? `<div class="acts">
             <button class="btn-main" data-pay="${esc(w._id)}">✅ 确认打款</button>
             <button class="btn-danger" data-reject="${esc(w._id)}">✖ 驳回</button>
           </div>`
        : (w.status === '已打款'
          ? `<div class="meta">打款时间 ${cnTime(w.paidAt)}${w.paidCards ? ' · 结清派单卡 ' + w.paidCards + ' 张' : ''}${w.note ? ' · 备注：' + esc(w.note) : ''}</div>`
          : '');
      return `<div class="item-card">
        <div class="hd">
          <div class="who">${esc(w.displayName || '')}</div>
          <div class="amt num">¥${(Number(w.amount) || 0).toFixed(2)}</div>
        </div>
        <div class="meta">
          <span>${w.type === 'bonus' ? '激励奖励' : '单子奖励'}</span>
          <span>支付宝：${w.alipay ? esc(w.alipay.name + ' / ' + w.alipay.account) : '未绑定'}</span>
          <span>${cnTime(w.createdAt)}</span>
        </div>
        <div class="meta"><b class="${stCls}">${esc(stTxt)}</b></div>
        ${acts}
      </div>`;
    }).join('');
  }

  async function load() {
    $('wdErr').textContent = '';
    const status = $('wdStatus').value, type = $('wdType').value;
    try {
      const j = await api('/api/admin/withdrawals?status=' + encodeURIComponent(status) + '&type=' + encodeURIComponent(type) + '&q=');
      if (!j || !j.ok) { $('wdList').innerHTML = '<div class="empty">' + esc((j && j.error) || '载入失败') + '</div>'; return; }
      const s = j.stats || {};
      $('wdPending').textContent = s.pending == null ? 0 : s.pending;
      $('wdPaid').textContent = s.paid == null ? 0 : s.paid;
      $('wdRejected').textContent = s.rejected == null ? 0 : s.rejected;
      ALL = j.withdrawals || [];
      paint();
    } catch (e) {
      $('wdList').innerHTML = '<div class="empty">' + esc((e && e.message) || '网络异常') + '</div>';
    }
  }

  // ---------- 确认打款 ----------
  async function doPay(id) {
    if (!confirm('确认已通过支付宝向该写手打款？\n\n订单型提现将同时：结清对应派单卡 → 同步台账为已结算 → 解冻现金红包。')) return;
    try {
      const j = await api('/api/admin/withdrawals/' + encodeURIComponent(id) + '/pay', { method: 'POST', body: JSON.stringify({ note: '' }) });
      if (j && j.ok) { toast('已确认打款' + (j.paidCards ? '，结清派单卡 ' + j.paidCards + ' 张' : '') + ' ✅'); load(); }
      else toast((j && j.error) || '操作失败');
    } catch (e) { toast((e && e.message) || '网络异常'); }
  }

  // ---------- 驳回（原来的 prompt 改成表单弹窗，原因必填、写手端可见） ----------
  function openReject(id) {
    const w = ALL.find(x => String(x._id) === String(id));
    rejectId = id;
    $('wdRejectWho').textContent = w
      ? (w.displayName || '') + ' · ¥' + (Number(w.amount) || 0).toFixed(2) + ' · ' + (w.type === 'bonus' ? '激励奖励' : '单子奖励')
      : '';
    $('wdRejectReason').value = '';
    $('wdRejectErr').textContent = '';
    $('wdRejectMask').classList.add('on');
    setTimeout(() => { try { $('wdRejectReason').focus(); } catch (e) {} }, 30);
  }
  function closeReject() { $('wdRejectMask').classList.remove('on'); rejectId = null; }

  $('wdRejectCancel').onclick = closeReject;
  $('wdRejectMask').onclick = e => { if (e.target === $('wdRejectMask')) closeReject(); };

  $('wdRejectGo').onclick = async () => {
    const reason = $('wdRejectReason').value.trim();
    if (!reason) { $('wdRejectErr').textContent = '请填写驳回原因（写手端会看到）'; return; }
    const btn = $('wdRejectGo');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const j = await api('/api/admin/withdrawals/' + encodeURIComponent(rejectId) + '/reject', { method: 'POST', body: JSON.stringify({ reason }) });
      if (j && j.ok) { toast('已驳回'); closeReject(); load(); }
      else $('wdRejectErr').textContent = (j && j.error) || '操作失败';
    } catch (e) { $('wdRejectErr').textContent = (e && e.message) || '网络异常'; }
    btn.disabled = false; btn.textContent = '确认驳回';
  };

  // ---------- 事件绑定 ----------
  $('wdList').addEventListener('click', e => {
    const pay = e.target.closest('[data-pay]');
    if (pay) { doPay(pay.dataset.pay); return; }
    const rj = e.target.closest('[data-reject]');
    if (rj) openReject(rj.dataset.reject);
  });
  $('wdStatus').onchange = load;
  $('wdType').onchange = load;
  $('wdQ').oninput = paint;
  $('wdReload').onclick = load;

  load();
  return { refresh: load };
}
