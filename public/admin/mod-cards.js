// admin/mod-cards.js — 派单卡工作台（iframe → 原生面板迁移 · 第 3 批，来源 dispatch-overview.html）
// 导出两个面板：mountOverview（派单总览）/ mountRecon（财务对账）
// 合成一个文件是因为两者共用写手收款信息、卡片操作（审核/驳回/打款/补同步）与状态胶囊，拆开会重复一半代码
import { api, esc, toast, cnTime } from './app.js';

const stPill = s => `<span class="pill ${esc(s)}">${esc(s)}</span>`;

// app.js 的 api() 不像原页面的 authFetch 那样对 !ok 抛错，这里补上，保持原有语义
async function jget(path, opt) {
  const j = await api(path, opt);
  if (!j || !j.ok) throw new Error((j && j.error) || '请求失败');
  return j;
}

// ---------- 写手收款信息（/api/team，管理员可见）：全模块共用，只取一次 ----------
let ALIPAY = {};
let writersLoaded = false;
async function ensureWriters() {
  if (writersLoaded) return;
  writersLoaded = true;
  try {
    const j = await jget('/api/team');
    (j.users || []).forEach(u => { if (u.alipay && u.alipay.account) ALIPAY[u.id] = u.alipay; });
  } catch (e) { writersLoaded = false; }
}
const alipayOf = uid => ALIPAY[uid] || null;

// 卡片操作后置脏 → 另一个面板下次切回来自动重取（外壳的 refresh 机制负责调用）
let OV_ROWS = [];
let RECON_ITEMS = [];

async function cardAct(id, path, body, okMsg) {
  try {
    const j = await jget('/api/cards/' + encodeURIComponent(id) + '/' + path,
      { method: 'POST', body: JSON.stringify(body || {}) });
    toast(j.syncedOrder ? okMsg + '（台账单已同步为「' + j.syncedOrder.status + '」）' : okMsg);
    return true;
  } catch (e) { toast((e && e.message) || '操作失败'); return false; }
}

// ================= 派单总览 =================
export function mountOverview(root) {
  root.innerHTML = `
  <div class="content-head">
    <div>
      <h1 class="serif">派单总览</h1>
      <div class="sub">🔄 派单 → 写手接单 → 做单 → 写手提交审核 → 你审核（通过→待打款，联动台账单变「待结算」；不通过→驳回）→ 确认打款（台账单变「已结算」）</div>
    </div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="ovReload">刷新</button>
  </div>

  <div class="card">
    <div class="grid3">
      <div class="stat plain"><b id="ovProfit">0</b><span>已联动预估利润 ¥</span></div>
      <div class="stat plain warn"><b id="ovReward">0</b><span>派单报酬合计 ¥</span></div>
      <div class="stat plain info"><b id="ovShare">0</b><span>关联单分成合计 ¥</span></div>
    </div>
    <div class="inline" style="margin-top:18px">
      <input id="ovQ" placeholder="🔍 搜标题 / 写手 / 台账单号…">
      <select id="ovSt">
        <option value="">全部状态</option>
        <option value="待接单">待接单</option><option value="已接单">已接单</option><option value="待审核">待审核</option>
        <option value="待打款">待打款</option><option value="已完成">已完成</option><option value="已驳回">已驳回</option><option value="已拒绝">已拒绝</option>
      </select>
    </div>
  </div>

  <div id="ovList"><div class="skeleton"><i></i><i></i><i></i><i></i></div></div>

  <div class="mask" id="ovReasonMask">
    <div class="modal">
      <h3 class="serif">驳回派单卡</h3>
      <div class="sub" id="ovReasonWho"></div>
      <div class="f-row"><label>驳回原因（将展示给写手）</label>
        <textarea id="ovReason" rows="3" placeholder="例如：交付内容与要求不符，请按 brief 第 3 条重做"></textarea>
      </div>
      <div class="err" id="ovReasonErr"></div>
      <div class="inline" style="justify-content:flex-end">
        <button class="btn-ghost" id="ovReasonCancel">取消</button>
        <button class="btn-danger" id="ovReasonGo">确认驳回</button>
      </div>
    </div>
  </div>`;

  const $ = id => root.querySelector('#' + id);
  let rejectId = null;

  function paint() {
    const q = $('ovQ').value.trim().toLowerCase();
    const st = $('ovSt').value;
    const rows = OV_ROWS.filter(r => {
      if (st && r.status !== st) return false;
      if (q && ![r.title, r.toName, r.orderNo].some(x => String(x || '').toLowerCase().includes(q))) return false;
      return true;
    });
    $('ovList').innerHTML = rows.length ? rows.map(r => {
      let note = '';
      if (r.status === '已驳回' && r.rejectReason) note = '<div class="note warn">❌ 已驳回：' + esc(r.rejectReason) + '</div>';
      if (r.status === '待审核' && r.submitNote) note = '<div class="note info">📝 写手提交说明：' + esc(r.submitNote) + '</div>';
      let ops = '';
      if (r.status === '待审核') {
        ops = `<button class="btn-main btn-sm" data-approve="${esc(r._id)}">✔ 审核通过</button>
               <button class="btn-danger btn-sm" data-reject="${esc(r._id)}">✖ 驳回</button>`;
      } else if (r.status === '待打款' || r.status === '已交付') {
        ops = `<button class="btn-info btn-sm" data-pay="${esc(r._id)}">💸 确认打款 ¥${esc(r.reward)}</button>`;
      }
      return `<div class="item-card">
        <div class="hd"><span class="who">${esc(r.title)}</span>${stPill(r.status)}</div>
        <div class="meta">
          <span>✍️ ${esc(r.toName)}</span><span>报酬 <b>¥${esc(r.reward)}</b></span>
          ${r.orderNo
            ? `<span>🔗 ${esc(r.orderNo)}</span><span>原单 ¥${esc(r.orderAmount)} → 分成 ¥${esc(r.orderShare)} → <b>利润 ¥${esc(r.profit)}</b></span>`
            : '<span class="st-bad">未关联台账单</span>'}
          <span>${cnTime(r.createdAt)}</span>
        </div>
        ${note}
        ${ops ? `<div class="ops">${ops}</div>` : ''}
      </div>`;
    }).join('') : '<div class="empty">没有符合条件的派单卡</div>';
  }

  async function load() {
    await ensureWriters();
    try {
      const j = await jget('/api/dispatch/overview');
      OV_ROWS = j.rows || [];
      const t = j.totals || {};
      $('ovProfit').textContent = t.totProfit == null ? 0 : t.totProfit;
      $('ovReward').textContent = t.totReward == null ? 0 : t.totReward;
      $('ovShare').textContent = t.totShare == null ? 0 : t.totShare;
      const cnt = {};
      OV_ROWS.forEach(r => { cnt[r.status] = (cnt[r.status] || 0) + 1; });
      // 注意：只改文本、保留 option 的 value 属性（没写 value 的 option 会把 textContent 当作 value，
      // 一旦把「待审核（1）」写进文本，value 就跟着被污染，筛选永远匹配不上 —— 原页面就踩了这个坑）
      [...$('ovSt').options].forEach(op => {
        if (op.value) op.textContent = op.value + (cnt[op.value] ? '（' + cnt[op.value] + '）' : '');
      });
      paint();
    } catch (e) {
      $('ovList').innerHTML = '<div class="empty">' + esc((e && e.message) || '载入失败') + '</div>';
    }
  }

  function openReject(id) {
    const r = OV_ROWS.find(x => String(x._id) === String(id));
    rejectId = id;
    $('ovReasonWho').textContent = r ? r.title + ' · ' + r.toName + ' · 报酬 ¥' + r.reward : '';
    $('ovReason').value = '';
    $('ovReasonErr').textContent = '';
    $('ovReasonMask').classList.add('on');
    setTimeout(() => { try { $('ovReason').focus(); } catch (e) {} }, 30);
  }
  function closeReject() { $('ovReasonMask').classList.remove('on'); rejectId = null; }

  $('ovReasonCancel').onclick = closeReject;
  $('ovReasonMask').onclick = e => { if (e.target === $('ovReasonMask')) closeReject(); };
  $('ovReasonGo').onclick = async () => {
    const reason = $('ovReason').value.trim();
    if (!reason) { $('ovReasonErr').textContent = '请填写驳回原因（写手端会看到）'; return; }
    const b = $('ovReasonGo');
    b.disabled = true; b.textContent = '提交中…';
    if (await cardAct(rejectId, 'reject', { reason }, '已驳回，写手可重新做单')) { closeReject(); load(); }
    b.disabled = false; b.textContent = '确认驳回';
  };

  $('ovList').addEventListener('click', async e => {
    const ap = e.target.closest('[data-approve]');
    if (ap) {
      if (confirm('审核通过？通过后该单进入「待打款」，台账订单自动变为「待结算」')) {
        if (await cardAct(ap.dataset.approve, 'approve', null, '审核通过 ✅')) load();
      }
      return;
    }
    const rj = e.target.closest('[data-reject]');
    if (rj) { openReject(rj.dataset.reject); return; }
    const py = e.target.closest('[data-pay]');
    if (py) {
      const row = OV_ROWS.find(r => String(r._id) === String(py.dataset.pay)) || {};
      const ali = alipayOf(row.to);
      let msg = '确认已打款 ¥' + row.reward + ' 给 ' + row.toName + '？\n台账订单将自动变为「已结算」';
      msg = ali
        ? '💸 打款前请核对收款方式：\n\n收款人：' + ali.name + '\n支付宝账号：' + ali.account + '\n\n' + msg
        : '⚠️ 该写手未绑定收款方式，请线下与其确认。\n\n' + msg;
      if (confirm(msg)) { if (await cardAct(py.dataset.pay, 'pay', null, '打款完成 💸')) load(); }
    }
  });

  $('ovQ').oninput = paint;
  $('ovSt').onchange = paint;
  $('ovReload').onclick = load;

  load();
  return { refresh: load };
}

// ================= 财务对账 =================
export function mountRecon(root) {
  root.innerHTML = `
  <div class="content-head">
    <div>
      <h1 class="serif">财务对账</h1>
      <div class="sub">💡 交叉核对台账到账状态 × 派单卡打款状态：客户的钱到账了（台账=已结算）就该给写手打款；给写手打完款（卡=已完成），台账也得标已结算</div>
    </div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="reconReload">🔄 刷新核对</button>
  </div>
  <div id="reconList"><div class="skeleton"><i></i><i></i><i></i><i></i></div></div>`;

  const $ = id => root.querySelector('#' + id);

  const MAP = {
    needReview: {
      t: '🔔 台账已到账，但这单还在「待审核」', c: 'needReview',
      ops: id => `<button class="btn-main btn-sm" data-approve="${esc(id)}">✔ 审核通过</button>
                  <button class="btn-danger btn-sm" data-reject="${esc(id)}">✖ 驳回</button>`,
    },
    needPay: {
      t: '💰 客户已到账，可以给写手打款了', c: 'needPay',
      ops: id => `<button class="btn-info btn-sm" data-pay="${esc(id)}">💸 确认打款</button>`,
    },
    unsynced: {
      t: '⚠️ 已给写手打款，但台账还没标已结算', c: 'unsynced',
      ops: id => `<button class="btn-ghost btn-sm" data-sync="${esc(id)}">🔄 补台账同步</button>`,
    },
  };

  function paint() {
    $('reconList').innerHTML = RECON_ITEMS.length ? RECON_ITEMS.map(it => {
      const m = MAP[it.type] || { t: it.type, c: '', ops: () => '' };
      const c = it.card || {}, o = it.order || {};
      const ali = alipayOf(c.to);
      return `<div class="item-card ${m.c}">
        <div class="who">${m.t}</div>
        <div class="meta">
          <span>🃏 <b>${esc(c.title)}</b></span>
          <span>写手 ${esc(c.toName)}</span>
          <span>报酬 <b>¥${esc(c.reward)}</b></span>
          <span>台账单 ${esc(o.orderNo)}（¥${esc(o.amount)} · ${stPill(o.status)}）</span>
          ${ali
            ? '<span>收款：' + esc(ali.name) + '（' + esc(ali.account) + '）</span>'
            : '<span class="st-bad">写手未绑定收款方式</span>'}
        </div>
        <div class="ops" style="justify-content:flex-end">${m.ops(c._id)}</div>
      </div>`;
    }).join('') : '<div class="empty">✅ 台账与派单卡状态全部一致，没有待处理的差异</div>';
  }

  async function load() {
    await ensureWriters();
    try {
      const j = await jget('/api/dispatch/reconcile');
      RECON_ITEMS = j.items || [];
      paint();
    } catch (e) {
      $('reconList').innerHTML = '<div class="empty">' + esc((e && e.message) || '载入失败') + '</div>';
    }
  }

  $('reconList').addEventListener('click', async e => {
    const ap = e.target.closest('[data-approve]');
    if (ap) {
      if (confirm('审核通过？通过后该单进入「待打款」，台账订单自动变为「待结算」')) {
        if (await cardAct(ap.dataset.approve, 'approve', null, '审核通过 ✅')) load();
      }
      return;
    }
    const rj = e.target.closest('[data-reject]');
    if (rj) {
      // 对账页不单独做驳回弹窗：回总览页处理，避免两处逻辑分叉
      const reason = prompt('驳回原因（将展示给写手）：');
      if (reason === null || !reason.trim()) return;
      if (await cardAct(rj.dataset.reject, 'reject', { reason: reason.trim() }, '已驳回，写手可重新做单')) load();
      return;
    }
    const py = e.target.closest('[data-pay]');
    if (py) {
      const it = RECON_ITEMS.find(x => String((x.card || {})._id) === String(py.dataset.pay)) || {};
      const c = it.card || {};
      const ali = alipayOf(c.to);
      let msg = '确认已打款 ¥' + c.reward + ' 给 ' + c.toName + '？\n台账订单将自动变为「已结算」';
      msg = ali
        ? '💸 打款前请核对收款方式：\n\n收款人：' + ali.name + '\n支付宝账号：' + ali.account + '\n\n' + msg
        : '⚠️ 该写手未绑定收款方式，请线下与其确认。\n\n' + msg;
      if (confirm(msg)) { if (await cardAct(py.dataset.pay, 'pay', null, '打款完成 💸')) load(); }
      return;
    }
    const sy = e.target.closest('[data-sync]');
    if (sy) {
      if (confirm('将该卡关联的台账订单标记为「已结算」？')) {
        if (await cardAct(sy.dataset.sync, 'syncorder', null, '台账已同步 ✅')) load();
      }
    }
  });

  $('reconReload').onclick = load;

  load();
  return { refresh: load };
}
