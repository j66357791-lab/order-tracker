// admin/mod-withdraw.js — 提现审批 + 打款工作台（iframe → 原生面板迁移 · 第 2 批，来源 withdraw.html）
// 写手发起的提现申请：确认打款 / 驳回（需填原因）
// 说明：原页面的行内 onclick="wdPay('id')" 改为 data-* + 事件委托——模块作用域的函数不再是全局，行内写法会直接报 undefined
// 【v24.0】新增打款工作台：转账信息一键复制 / 多选批量核销 / 凭证号（支付宝流水号）留档
import { api, esc, toast, cnTime } from './app.js';

export function mount(root) {
  root.innerHTML = `
  <div class="content-head">
    <div>
      <h1 class="serif">提现审批 · 打款中心</h1>
      <div class="sub">打款工作台：复制转账信息 → 支付宝转账 → 勾选核销（可填凭证号留档）；订单型提现核销时会同时结清派单卡、同步台账、解冻红包</div>
    </div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="wdReload">刷新</button>
  </div>

  <div class="card">
    <h2 class="serif">💰 打款工作台</h2>
    <div class="grid3" id="wdPayStats"><div class="empty">加载中…</div></div>
    <div class="inline" style="margin-top:12px">
      <button class="btn-ghost" id="wdCopyAll">📋 复制全部待打款转账信息</button>
      <span class="sub">格式：姓名 · 支付宝账号 · 金额 · 备注单号，转账时照着逐条转</span>
    </div>
    <div class="inline" style="margin-top:10px">
      <span class="sub" style="flex:1" id="wdSelInfo">未勾选任何一笔</span>
      <input id="wdVoucher" placeholder="支付宝流水号/凭证号（选填，留档用）" style="max-width:260px">
      <button class="btn-main" id="wdBatchPay">批量标记已打款</button>
    </div>
    <div class="sub" style="margin-top:8px">提示：先在支付宝转账完成、核对到账后，再勾选核销。凭证号建议从支付宝账单里复制，方便以后对账。</div>
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
  const SEL = new Set();   // 勾选的待打款 _id

  const transferText = w => `${(w.alipay && w.alipay.name) || ''}\t${(w.alipay && w.alipay.account) || ''}\t¥${(Number(w.amount) || 0).toFixed(2)}\t${w.type === 'bonus' ? '激励奖励' : '单子奖励'}·${String(w._id).slice(-6)}`;

  function paintPayStats() {
    const pending = ALL.filter(w => w.status === '待处理');
    const sum = pending.reduce((s, w) => s + (Number(w.amount) || 0), 0);
    $('wdPayStats').innerHTML = `
      <div class="stat plain warn"><b>${pending.length}</b><span>待打款笔数</span></div>
      <div class="stat plain"><b>¥${sum.toFixed(2)}</b><span>待打款合计</span></div>
      <div class="stat plain"><b>${(ALL[0] && ALL[0].stats && ALL[0].stats.paidMonthCount) || '-'}</b><span>本月已打 ${((ALL[0] && ALL[0].stats && ALL[0].stats.paidMonthAmount) || 0).toFixed ? '¥' + ALL[0].stats.paidMonthAmount.toFixed(2) : ''}</span></div>`;
  }

  function paintSel() {
    const ids = [...SEL];
    const sum = ids.reduce((s, id) => { const w = ALL.find(x => String(x._id) === id); return s + (w ? Number(w.amount) || 0 : 0); }, 0);
    $('wdSelInfo').textContent = ids.length ? `已勾选 ${ids.length} 笔 · 合计 ¥${sum.toFixed(2)}` : '未勾选任何一笔';
    $('wdBatchPay').disabled = !ids.length;
    $('wdBatchPay').style.opacity = ids.length ? 1 : .5;
  }

  function paint() {
    const box = $('wdList');
    if (!ALL.length) { box.innerHTML = '<div class="empty">暂无提现申请</div>'; return; }
    [...SEL].forEach(id => { if (!ALL.some(w => String(w._id) === id && w.status === '待处理')) SEL.delete(id); });
    const q = ($('wdQ').value || '').trim().toLowerCase();
    const rows = q ? ALL.filter(w =>
      (w.displayName || '').toLowerCase().includes(q) ||
      (w.amount != null && String(w.amount).includes(q)) ||
      (w.alipay && (String(w.alipay.account || '').toLowerCase().includes(q) || String(w.alipay.name || '').toLowerCase().includes(q)))
    ) : ALL;
    if (!rows.length) { box.innerHTML = '<div class="empty">没有匹配的提现申请</div>'; return; }

    box.innerHTML = rows.map(w => {
      const pending = w.status === '待处理';
      const id = String(w._id);
      const stCls = pending ? 'st-wait' : (w.status === '已打款' ? 'st-ok' : 'st-bad');
      const stTxt = w.status + (w.status === '已驳回' && w.reason ? '（' + w.reason + '）' : '');
      const voucher = w.voucherNo ? ' · 凭证：' + esc(w.voucherNo) : '';
      const acts = pending
        ? `<div class="acts">
             <label style="display:flex;align-items:center;gap:5px;font-size:12.5px;color:var(--ink2)"><input type="checkbox" data-sel="${id}" ${SEL.has(id) ? 'checked' : ''}>已转</label>
             <button class="btn-ghost" data-copy="${id}">📋 复制转账信息</button>
             <button class="btn-main" data-pay="${id}">✅ 打款并核销</button>
             <button class="btn-danger" data-reject="${id}">✖ 驳回</button>
           </div>`
        : (w.status === '已打款'
          ? `<div class="meta">打款时间 ${cnTime(w.paidAt)}${w.paidCards ? ' · 结清派单卡 ' + w.paidCards + ' 张' : ''}${voucher}${w.note ? ' · 备注：' + esc(w.note) : ''}</div>`
          : '');
      return `<div class="item-card">
        <div class="hd">
          <div class="who">${pending ? `<input type="checkbox" data-sel="${id}" ${SEL.has(id) ? 'checked' : ''} style="margin-right:8px">` : ''}${esc(w.displayName || '')}</div>
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
    paintPayStats(); paintSel();
  }

  function copyText(t) {
    const done = () => toast('已复制，去支付宝转账页面粘贴核对');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
    else fallbackCopy(t, done);
  }
  function fallbackCopy(t, done) {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择文本'); }
    ta.remove();
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
      ALL = (j.withdrawals || []).map(w => Object.assign({}, w, { stats: s }));
      paint();
    } catch (e) {
      $('wdList').innerHTML = '<div class="empty">' + esc((e && e.message) || '网络异常') + '</div>';
    }
  }

  // ---------- 打款核销（单笔 / 批量） ----------
  async function payOne(w) {
    const voucher = $('wdVoucher').value.trim();
    if (!confirm('确认已通过支付宝向「' + (w.displayName || '') + '」打款 ¥' + (Number(w.amount) || 0).toFixed(2) + '？\n\n订单型提现将同时：结清对应派单卡 → 同步台账为已结算 → 解冻现金红包。')) return;
    try {
      const j = await api('/api/admin/withdrawals/' + encodeURIComponent(w._id) + '/pay', { method: 'POST', body: JSON.stringify({ note: '', voucherNo: voucher }) });
      if (j && j.ok) { toast('已核销打款' + (j.paidCards ? '，结清派单卡 ' + j.paidCards + ' 张' : '') + ' ✅'); SEL.delete(String(w._id)); load(); }
      else toast((j && j.error) || '操作失败');
    } catch (e) { toast((e && e.message) || '网络异常'); }
  }
  async function payBatch() {
    const ids = [...SEL];
    if (!ids.length) return;
    const sum = ids.reduce((s, id) => { const w = ALL.find(x => String(x._id) === id); return s + (w ? Number(w.amount) || 0 : 0); }, 0);
    if (!confirm('批量核销 ' + ids.length + ' 笔 · 合计 ¥' + sum.toFixed(2) + '？\n\n请确认支付宝转账已全部完成并核对到账。\n订单型提现会同步结清派单卡与台账。')) return;
    let okN = 0, failN = 0;
    for (const id of ids) {
      try {
        const j = await api('/api/admin/withdrawals/' + encodeURIComponent(id) + '/pay', { method: 'POST', body: JSON.stringify({ note: '', voucherNo: $('wdVoucher').value.trim() }) });
        if (j && j.ok) { okN++; SEL.delete(id); } else failN++;
      } catch (e) { failN++; }
    }
    toast('批量核销完成：成功 ' + okN + ' 笔' + (failN ? '，失败 ' + failN + ' 笔（可能已被处理，刷新后看最新状态）' : ''));
    load();
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
    if (pay) { const w = ALL.find(x => String(x._id) === pay.dataset.pay); if (w) payOne(w); return; }
    const cp = e.target.closest('[data-copy]');
    if (cp) { const w = ALL.find(x => String(x._id) === cp.dataset.copy); if (w) copyText(transferText(w)); return; }
    const rj = e.target.closest('[data-reject]');
    if (rj) openReject(rj.dataset.reject);
  });
  $('wdList').addEventListener('change', e => {
    const sel = e.target.closest('[data-sel]');
    if (sel) { if (sel.checked) SEL.add(sel.dataset.sel); else SEL.delete(sel.dataset.sel); paintSel(); }
  });
  $('wdCopyAll').onclick = () => {
    const pending = ALL.filter(w => w.status === '待处理');
    if (!pending.length) { toast('当前没有待打款的申请'); return; }
    copyText('姓名\t支付宝账号\t金额\t备注\n' + pending.map(transferText).join('\n'));
  };
  $('wdBatchPay').onclick = payBatch;
  $('wdStatus').onchange = load;
  $('wdType').onchange = load;
  $('wdQ').oninput = paint;
  $('wdReload').onclick = load;

  load();
  return { refresh: load };
}
