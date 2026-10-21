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
let RC = { rows: [], counts: {}, sumDiff: {}, total: 0, scanned: 0, truncated: false };

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
// 改版要点：接口不再只回"差异"，而是回全量 + 每条一个 diff 标记，
// 所以「已通过审核、还在等客户到账」（waiting）这类以前完全不显示的卡现在看得见；
// 上面加了状态胶囊筛选 / 分类卡筛选 / 搜索 / 排序，筛选状态记在本地，下次进来还在。
const RC_KIND = {
  needReview: { t: '🔔 台账已到账 · 卡还停在待审核', s: '要先审核', cls: 'needReview' },
  needPay:    { t: '💰 可以打款了（客户钱已到账，卡已过审）', s: '可打款', cls: 'needPay' },
  unsynced:   { t: '⚠️ 已给写手打款 · 台账还没标已结算', s: '缺台账', cls: 'unsynced' },
  noorder:    { t: '❓ 这张卡没绑上台账单', s: '没绑单', cls: 'noorder' },
  waiting:    { t: '⏳ 已通过审核 · 等客户到账', s: '等客户到账', cls: 'waiting' },
  '':         { t: '✅ 正常在途（无需处理）', s: '正常', cls: 'ok' },
};
const RC_ORDER = ['needReview', 'needPay', 'unsynced', 'noorder', 'waiting', ''];
const CARD_ST = ['待接单', '已接单', '待审核', '待打款', '已完成', '已驳回', '已拒绝'];
// 默认收起的两类：正常在途和没绑单的，它们不需要处理，先把要对付的露出来
const RC_FOLD0 = { '': 1, noorder: 1 };

export function mountRecon(root) {
  root.innerHTML = `
  <div class="content-head">
    <div>
      <h1 class="serif">财务对账</h1>
      <div class="sub">💡 派单卡状态 × 台账到账状态 交叉核对。<b>已通过审核但客户钱还没到账的（"等客户到账"）现在也在列</b>——以前这一页只列差异，那种卡一条都不显示。</div>
    </div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="reconReload">🔄 刷新核对</button>
  </div>
  <div class="rc-kpi" id="rcKpi"></div>
  <div class="rc-bar">
    <span class="rc-lb">卡状态</span><span class="rc-chips" id="rcChips"></span>
    <span class="spacer"></span>
    <button class="rc-tgl" id="rcGroup" title="按分类分组显示，或打平成一张长列表">🗂 分组中</button>
    <button class="rc-tgl" id="rcFold" title="一次收起/展开全部分组">▾ 全部收起</button>
    <select id="rcSort" title="排序">
      <option value="wait">等得最久在前</option><option value="new">最新在前</option><option value="reward">报酬从高到低</option>
    </select>
    <input type="search" id="rcQ" placeholder="搜卡标题 / 写手 / 台账单号…">
  </div>
  <div class="rc-sum" id="rcSum"></div>
  <div id="reconList"><div class="skeleton"><i></i><i></i><i></i><i></i></div></div>`;

  const $ = id => root.querySelector('#' + id);
  let V = { status: '', kind: '', sort: 'wait', q: '', group: true, fold: { ...RC_FOLD0 } };
  try {
    const old = JSON.parse(localStorage.getItem('recon_view') || 'null');
    if (old) V = Object.assign(V, old, { q: '' });
    if (!old || typeof old.fold !== 'object' || !old.fold) V.fold = { ...RC_FOLD0 };
  } catch (e) {}
  const saveV = () => {
    try { localStorage.setItem('recon_view', JSON.stringify({ status: V.status, kind: V.kind, sort: V.sort, group: V.group, fold: V.fold })); } catch (e) {}
  };
  const money = n => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

  function visible() {
    let rs = RC.rows;
    if (V.status) rs = rs.filter(r => r.status === V.status);
    if (V.kind === 'todo') rs = rs.filter(r => r.diff === 'needReview' || r.diff === 'needPay' || r.diff === 'unsynced');
    else if (V.kind) rs = rs.filter(r => r.diff === V.kind);
    const q = V.q.trim().toLowerCase();
    if (q) rs = rs.filter(r => [r.title, r.toName, r.orderNo, r.status].some(x => String(x || '').toLowerCase().includes(q)));
    const s = V.sort;
    return [...rs].sort((a, b) => s === 'new' ? String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      : s === 'reward' ? b.reward - a.reward : b.waitDays - a.waitDays);
  }

  function paintKpi() {
    const sd = RC.sumDiff || {}, todo = ['needReview', 'needPay', 'unsynced'].reduce((s, k) => s + (sd[k] ? sd[k].n : 0), 0);
    const todoMoney = ['needReview', 'needPay', 'unsynced'].reduce((s, k) => s + (sd[k] ? sd[k].reward : 0), 0);
    const cell = (n, l, sub, k, cls) => `<button class="rc-k${V.kind === k ? ' on' : ''} ${cls || ''}" data-kind="${k}">
        <b>${n}</b><span>${l}</span>${sub ? `<em>${sub}</em>` : ''}</button>`;
    $('rcKpi').innerHTML =
      cell(todo, '单要对账', '报酬 ¥' + money(Math.round(todoMoney * 100) / 100), 'todo', 'bad')
      + cell((sd.needReview || {}).n || 0, '卡在待审核', '¥' + money((sd.needReview || {}).reward || 0), 'needReview', 'bad')
      + cell((sd.needPay || {}).n || 0, '可以打款', '¥' + money((sd.needPay || {}).reward || 0), 'needPay', 'warn')
      + cell((sd.waiting || {}).n || 0, '已过审 · 等客户到账', '¥' + money((sd.waiting || {}).reward || 0), 'waiting')
      + cell((sd.unsynced || {}).n || 0, '已打款台账没同步', '¥' + money((sd.unsynced || {}).reward || 0), 'unsynced', 'bad')
      + cell(RC.scanned, '派单卡总数', '报酬合计 ¥' + money(RC.total), '');
  }

  function paintChips() {
    const n = st => RC.counts[st] || 0;
    $('rcChips').innerHTML = `<button class="rc-c${V.status === '' ? ' on' : ''}" data-st="">全部 ${RC.scanned}</button>`
      + CARD_ST.filter(st => n(st)).map(st => `<button class="rc-c${V.status === st ? ' on' : ''}" data-st="${esc(st)}">${esc(st)} ${n(st)}</button>`).join('');
  }

  function paint() {
    paintKpi(); paintChips();
    const rs = visible();
    const sum = rs.reduce((s, r) => s + r.reward, 0);
    const groups = RC_ORDER.map(kind => ({ kind, g: rs.filter(r => (r.diff || '') === kind) })).filter(x => x.g.length);
    const folded = V.group ? groups.filter(x => V.fold[x.kind]) : [];
    const foldMoney = folded.reduce((s, x) => s + x.g.reduce((t, r) => t + r.reward, 0), 0);
    $('rcGroup').innerHTML = V.group ? '🗂 分组中' : '☰ 平铺中';
    $('rcFold').hidden = !V.group;
    $('rcFold').innerHTML = folded.length === groups.length && groups.length ? '▸ 全部展开' : '▾ 全部收起';
    $('rcSum').innerHTML = `当前视图 <b>${rs.length}</b> 单 · 报酬合计 <b>¥${money(Math.round(sum * 100) / 100)}</b>`
      + (folded.length ? `<span class="rc-tip">已收起 ${folded.reduce((s, x) => s + x.g.length, 0)} 单 / ¥${money(Math.round(foldMoney * 100) / 100)}，点分组标题展开</span>` : '')
      + (rs.length !== RC.scanned ? `<span class="rc-tip">（全量 ${RC.scanned} 单 / ¥${money(RC.total)}，筛选后的数只代表当前视图）</span>` : '')
      + (V.kind || V.status ? `<button class="rc-clear" id="rcClear">清除筛选</button>` : '')
      + (RC.truncated ? `<span class="rc-tip bad">⚠ 卡超过 ${RC.scanned} 条被截断，请缩小范围</span>` : '');
    if (!rs.length) {
      $('reconList').innerHTML = `<div class="empty">${RC.rows.length ? '这个筛选条件下没有卡。换个状态或点「清除筛选」。' : (RC.scanned ? '这批卡都没关联台账单。' : '还没有派单卡。')}</div>`;
      return;
    }
    if (!V.group) { $('reconList').innerHTML = rs.map(r => row(r, true)).join(''); return; }
    $('reconList').innerHTML = groups.map(({ kind, g }) => {
      const m = RC_KIND[kind], fold = !!V.fold[kind];
      const sub = Math.round(g.reduce((s, r) => s + r.reward, 0) * 100) / 100;
      return `<div class="rc-group ${m.cls}${fold ? ' folded' : ''}"><button data-fold="${esc(kind)}" title="点击${fold ? '展开' : '收起'}这组">`
        + `<span class="ar">${fold ? '▸' : '▾'}</span>${m.t}<span class="gc"> ${g.length} 单 · 报酬 ¥${money(sub)}</span></button></div>`
        + (fold ? '' : g.map(r => row(r)).join(''));
    }).join('');
  }

  function row(r, showKind) {
    const ali = alipayOf(r.to);
    const k = RC_KIND[r.diff || ''];
    const ops = [];
    if (r.status === '待审核') ops.push(`<button class="btn-main btn-sm" data-approve="${esc(r._id)}">✔ 审核通过</button><button class="btn-danger btn-sm" data-reject="${esc(r._id)}">✖ 驳回</button>`);
    if (r.status === '待打款') ops.push(`<button class="btn-info btn-sm" data-pay="${esc(r._id)}" title="${r.diff === 'waiting' ? '台账还没到账，确认要提前打款再点' : ''}">💸 确认打款</button>`);
    if (r.diff === 'unsynced') ops.push(`<button class="btn-ghost btn-sm" data-sync="${esc(r._id)}">🔄 补台账同步</button>`);
    return `<div class="item-card ${k.cls}${r.diff ? '' : ' quiet'}">
      <div class="hd"><div class="who">${esc(r.title)}</div><div class="amt">¥${money(r.reward)}</div></div>
      <div class="meta">
        ${showKind ? `<span class="rc-tag ${k.cls}">${k.s}</span>` : ''}
        <span>写手 ${esc(r.toName)}</span>
        <span>卡 ${stPill(r.status)}</span>
        <span>台账 ${r.orderId ? `<b>${esc(r.orderNo)}</b> ¥${money(r.orderAmount)} · ${stPill(r.orderStatus)}` : '<b class="st-bad">没绑单</b>'}</span>
        <span class="${r.waitDays >= 7 ? 'st-warn' : ''}">已等 ${r.waitDays} 天</span>
        ${r.submittedAt ? `<span>提交于 ${esc(cnTime(r.submittedAt))}</span>` : ''}
        ${ali ? `<span>收款 ${esc(ali.name)}（${esc(ali.account)}）</span>` : '<span class="st-bad">写手未绑定收款方式</span>'}
      </div>
      ${ops.length ? `<div class="ops">${ops.join('')}</div>` : ''}
    </div>`;
  }

  async function load() {
    await ensureWriters();
    try {
      const j = await jget('/api/dispatch/reconcile');
      RC = { rows: j.rows || [], counts: j.counts || {}, sumDiff: j.sumDiff || {}, total: j.total || 0, scanned: j.scanned || 0, truncated: !!j.truncated };
      paint();
    } catch (e) {
      $('reconList').innerHTML = '<div class="empty">' + esc((e && e.message) || '载入失败') + '</div>';
    }
  }

  $('rcKpi').addEventListener('click', e => {
    const b = e.target.closest('[data-kind]'); if (!b) return;
    V.kind = V.kind === b.dataset.kind ? '' : b.dataset.kind;
    saveV(); paint();
  });
  $('rcChips').addEventListener('click', e => {
    const b = e.target.closest('[data-st]'); if (!b) return;
    V.status = V.status === b.dataset.st ? '' : b.dataset.st;
    saveV(); paint();
  });
  $('rcSum').addEventListener('click', e => {
    if (!e.target.closest('#rcClear')) return;
    V.kind = ''; V.status = ''; saveV(); paint();
  });
  $('rcGroup').onclick = () => { V.group = !V.group; saveV(); paint(); };
  $('rcFold').onclick = () => {
    const rs = visible();
    const ks = RC_ORDER.filter(k => rs.some(r => (r.diff || '') === k));
    const allFolded = ks.length > 0 && ks.every(k => V.fold[k]);
    ks.forEach(k => { V.fold[k] = allFolded ? 0 : 1; });
    saveV(); paint();
  };
  $('rcSort').onchange = () => { V.sort = $('rcSort').value; saveV(); paint(); };
  $('rcQ').oninput = () => { V.q = $('rcQ').value; paint(); };

  $('reconList').addEventListener('click', async e => {
    const fd = e.target.closest('[data-fold]');
    if (fd) { const k = fd.dataset.fold; V.fold[k] = V.fold[k] ? 0 : 1; saveV(); paint(); return; }
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
      const it = RC.rows.find(x => String(x._id) === String(py.dataset.pay)) || {};
      const ali = alipayOf(it.to);
      const warn = it.diff === 'waiting' ? '\n⚠️ 注意：这单的台账还没标已结算（客户的钱还没到账），确定要提前打款？' : '';
      const msg = ali
        ? '💸 打款前请核对收款方式：\n\n收款人：' + ali.name + '\n支付宝账号：' + ali.account + '\n\n确认已打款 ¥' + it.reward + ' 给 ' + it.toName + '？\n台账订单将自动变为「已结算」' + warn
        : '⚠️ 该写手未绑定收款方式，请线下与其确认。\n\n确认已打款 ¥' + it.reward + ' 给 ' + it.toName + '？' + warn;
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
  $('rcSort').value = V.sort;
  load();
  return { refresh: load };
}
