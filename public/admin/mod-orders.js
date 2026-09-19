// admin/mod-orders.js — 台账面板（iframe → 原生面板迁移 · 第 4 批，来源 index.html）
//
// 迁移要点：
//  1. 用 Shadow DOM 承载整页：这一页自带 200 行 CSS，table / .empty / .mask / .modal / --ink
//     这些选择器与变量跟 admin/app.css 直接冲突（会把别的面板的表格宽度和文字颜色一起改掉）。
//     Shadow DOM 一次性隔离，样式表放同目录的 ledger.css。
//  2. 作用域从 document 换到 shadowRoot：内部所有 getElementById/querySelector 都走 shDoc。
//  3. 原始业务逻辑（数据层含 localStorage 降级、汇总口径、图表、日历、三个月度/日/季筛选、
//     ⚡快捷录入、🔍快捷查询、📅月份切换、三个弹窗）**一行没改**，只做了作用域替换与
//     iframe 时代开关的清理。
//  4. 保留右下角 ⚡ 悬浮抽屉：📅月份切换 / 🔍快捷查询 / ⚡快捷录入 三张卡一个不少。
const CSS_HREF = '/admin/ledger.css';
const MARKUP = "\n<div class=\"layout\">\n\n  <!-- ===== 左侧快捷导航栏 ===== -->\n  <aside class=\"sidebar\">\n    <div class=\"side-card\">\n      <h4>📅 月份切换</h4>\n      <div class=\"mon-nav\">\n        <button class=\"btn-ghost\" id=\"monPrev\">‹</button>\n        <b id=\"monCur\">—</b>\n        <button class=\"btn-ghost\" id=\"monNext\">›</button>\n      </div>\n      <div class=\"mon-list\" id=\"monList\"></div>\n      <div class=\"side-tip\">带 · 的月份有订单数据，点月份名可切换明细与日历</div>\n    </div>\n\n    <div class=\"side-card\">\n      <h4>🔍 快捷查询</h4>\n      <input type=\"search\" id=\"qKw\" placeholder=\"订单号 / 备注关键词\">\n      <div class=\"q-results\" id=\"qResults\"><div class=\"q-empty\">输入关键词即时匹配，点结果跳到明细行</div></div>\n    </div>\n\n    <div class=\"side-card quick-form\">\n      <h4>⚡ 快捷录入（比例默认40%）</h4>\n      <input type=\"text\" id=\"qkNo\" placeholder=\"订单编号 *\">\n      <div class=\"row2\">\n        <input type=\"number\" id=\"qkAmt\" placeholder=\"金额（元）*\" min=\"0\" step=\"0.01\">\n        <input type=\"number\" id=\"qkRate\" value=\"40\" min=\"1\" max=\"100\" step=\"0.1\" title=\"分成比例%\" style=\"max-width:74px\">\n      </div>\n      <button class=\"btn-primary\" id=\"qkSave\">⚡ 一键录入</button>\n      <div class=\"side-tip\">接单日=今天 · 分类=待开始 · 完单后到明细里改进度</div>\n    </div>\n  </aside>\n\n  <!-- ===== 主内容 ===== -->\n  <div class=\"main\">\n    <div class=\"wrap\">\n      <header>\n        <h1>📋 订单统计系统</h1>\n        <div class=\"meta\">数据源：<b id=\"dbState\">连接中…</b> · <span id=\"todayStr\"></span> · 兼职写手接单台账 · <a href=\"/admin.html\" style=\"color:#b0642c\">🏠 管理工作台</a> · <a href=\"/admin.html#mall\" style=\"color:#07c160\">用户端配置</a> · <a href=\"/admin.html#game\" style=\"color:#7c4dff\">游戏管控</a> · <a href=\"#\" onclick=\"this.getRootNode().host.__ledger.logout();return false\" style=\"color:var(--sub)\">退出登录</a></div>\n      </header>\n\n      <!-- ===== 今日待跟进 ===== -->\n      <section class=\"todo-banner\" id=\"todoBanner\" style=\"display:none\">\n        <div class=\"todo-head\">🔔 今日待跟进订单（待开始 / 进行中）—— <span id=\"todoCount\"></span>，右侧下拉可直接更新进度</div>\n        <div class=\"todo-list\" id=\"todoList\"></div>\n      </section>\n\n      <!-- ===== 核心看板 ===== -->\n      <section class=\"kpis\">\n        <div class=\"kpi blue\"><div class=\"label\" id=\"lblTake\">接单金额</div><div class=\"value\" id=\"kTake\">0<small> 元</small></div><div class=\"sub\" id=\"subTake\">— 单</div></div>\n        <div class=\"kpi green\"><div class=\"label\" id=\"lblDone\">完单金额</div><div class=\"value\" id=\"kDone\">0<small> 元</small></div><div class=\"sub\" id=\"subDone\">— 单</div></div>\n        <div class=\"kpi amber\"><div class=\"label\">待结算（已交付未结算）</div><div class=\"value\" id=\"kPending\">0<small> 元</small></div><div class=\"sub\">按订单金额计</div></div>\n        <div class=\"kpi purple\"><div class=\"label\">已结算（我的分成）</div><div class=\"value\" id=\"kSettled\">0<small> 元</small></div><div class=\"sub\">已到账口径</div></div>\n        <div class=\"kpi blue\"><div class=\"label\">预计总收入</div><div class=\"value\" id=\"kShare\">0<small> 元</small></div><div class=\"sub\" id=\"subCount\">— 单</div></div>\n      </section>\n\n      <section class=\"panels\">\n        <div class=\"panel\">\n          <h3 id=\"chartTitle\">每日接单 / 完单金额</h3>\n          <div class=\"legend\">\n            <span><i style=\"background:var(--blue)\"></i>接单金额（按接单日）</span>\n            <span><i style=\"background:var(--green)\"></i>完单金额（按完单日，待结算+已结算）</span>\n            <span style=\"color:#94a3b8\">鼠标悬停柱子看当日数值</span>\n          </div>\n          <div class=\"bars\" id=\"dailyChart\"></div>\n          <div class=\"chart-foot\" id=\"chartFoot\"></div>\n        </div>\n        <div class=\"panel\">\n          <h3>订单分类看板（按进度）</h3>\n          <div class=\"status-rows\" id=\"statusChart\"></div>\n          <div class=\"st-note\">口径说明：<b>待结算 = 已交付未结算</b>，客户已收货、钱还没到；「已结算」才算到账。完单金额 = 待结算 + 已结算。</div>\n        </div>\n      </section>\n\n      <!-- ===== 收入走势（方块卡，点击弹窗看图） ===== -->\n      <section class=\"panels\" style=\"margin-bottom:16px;grid-template-columns:1fr 1fr\">\n        <div class=\"panel chart-tile\" onclick=\"this.getRootNode().host.__ledger.openChart('daily')\">\n          <h3 id=\"tileDTitle\">每日分成收入走势（预计）</h3>\n          <div class=\"tile-big\" id=\"tileDVal\">—</div>\n          <div class=\"tile-sub\" id=\"tileDSub\">点击查看走势图 →</div>\n        </div>\n        <div class=\"panel chart-tile\" onclick=\"this.getRootNode().host.__ledger.openChart('cum')\">\n          <h3 id=\"tileCTitle\">累计分成收入走势</h3>\n          <div class=\"tile-big\" id=\"tileCVal\">—</div>\n          <div class=\"tile-sub\" id=\"tileCSub\">点击查看走势图 →</div>\n        </div>\n      </section>\n\n      <!-- ===== 日历看板 ===== -->\n      <section class=\"panel\" style=\"margin-bottom:16px\" id=\"calendarCard\">\n        <h3 id=\"calTitle\">日历看板</h3>\n        <div class=\"today-brief\" id=\"todayBrief\"></div>\n        <div class=\"cal-head\"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>\n        <div class=\"cal-grid\" id=\"calGrid\"></div>\n        <div class=\"cal-legend\">\n          口径：<b>接单金额</b> = 当日登记的接单金额汇总 · <b>完单金额</b> = 当日做完（提交待结算/已结算）订单金额汇总 · <b>预计今天完单金额收入</b> = 当日完单订单的分成合计。\n          绿色深浅 = 预计当日收入。<b>点任意日期 → 弹出当天接单明细，可直接编辑/删除。</b>\n        </div>\n      </section>\n\n      <!-- ===== 明细表 ===== -->\n      <section class=\"toolbar\" id=\"tableTop\">\n        <select id=\"fPeriodType\" title=\"时间范围类型\">\n          <option value=\"month\">按月</option>\n          <option value=\"quarter\">按季度</option>\n          <option value=\"year\">按年</option>\n          <option value=\"day\">按日</option>\n        </select>\n        <span id=\"periodInputs\" style=\"display:inline-flex;gap:8px;align-items:center\"></span>\n        <select id=\"fStatus\"><option value=\"\">全部分类</option></select>\n        <input type=\"search\" id=\"fKeyword\" placeholder=\"搜订单编号 / 备注…\">\n        <span class=\"grow\"></span>\n        <a class=\"btn-ghost\" href=\"/dispatch.html\" style=\"text-decoration:none;display:inline-flex;align-items:center\">派单工作台 →</a>\n        <button class=\"btn-ghost\" id=\"btnExport\">导出 CSV</button>\n        <button class=\"btn-primary\" id=\"btnAdd\">＋ 新增订单</button>\n      </section>\n\n      <div class=\"table-card\" id=\"tableCard\">\n        <table>\n          <thead>\n            <tr>\n              <th>接单日</th><th>订单编号</th>\n              <th class=\"num\">订单金额（元）</th><th class=\"num\">分成比例</th><th class=\"num\">分成金额（元）</th>\n              <th>分类</th><th>完单日</th><th>分单</th><th>备注</th><th style=\"width:90px\">操作</th>\n            </tr>\n          </thead>\n          <tbody id=\"tbody\"></tbody>\n          <tfoot id=\"tfoot\"></tfoot>\n        </table>\n        <div class=\"empty\" id=\"emptyTip\" style=\"display:none\">暂无订单，点右上角「＋ 新增订单」或左侧「⚡ 快捷录入」</div>\n        <div class=\"pager\" id=\"pager\"></div>\n      </div>\n      <div class=\"hint\">分成金额 = 订单金额 × 分成比例；「待结算」即已交付等钱的状态，「已结算」为实际到账口径。已分单订单在收入统计中按实际结算金额（分成 − 写手报酬）计入。</div>\n    </div>\n  </div>\n</div>\n\n<!-- 悬浮工具开关（仅嵌入后台时显示）：月份切换 · 快捷查询 · 快捷录入 -->\n<button class=\"side-fab\" id=\"sideFab\" type=\"button\" aria-expanded=\"false\"\n        title=\"快捷工具：月份切换 / 快捷查询 / 快捷录入\" aria-label=\"快捷工具\">⚡</button>\n\n<!-- 走势图弹窗（加宽） -->\n<div class=\"mask\" id=\"chartMask\" onclick=\"if(event.target===this)this.getRootNode().host.__ledger.closeChart()\">\n  <div class=\"modal chart-modal\">\n    <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:10px\">\n      <h2 id=\"chartMTitle\" style=\"font-size:16px;font-weight:700\"></h2>\n      <button class=\"btn-ghost\" onclick=\"this.getRootNode().host.__ledger.closeChart()\">关闭</button>\n    </div>\n    <div class=\"line-wrap\" id=\"chartMBody\"></div>\n  </div>\n</div>\n\n<!-- 日历单日明细大弹窗 -->\n<div class=\"mask\" id=\"dayMask\" onclick=\"if(event.target===this)this.getRootNode().host.__ledger.closeDayModal()\">\n  <div class=\"modal day-modal\">\n    <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:12px\">\n      <h2 id=\"dayMTitle\" style=\"font-size:16px;font-weight:700\"></h2>\n      <button class=\"btn-ghost\" onclick=\"this.getRootNode().host.__ledger.closeDayModal()\">关闭</button>\n    </div>\n    <div class=\"day-stats\" id=\"dayStats\"></div>\n    <div class=\"table-card\" id=\"dayTableBox\"></div>\n    <div class=\"hint\" id=\"dayHint\"></div>\n  </div>\n</div>\n\n<!-- 新增/编辑弹窗 -->\n<div class=\"mask\" id=\"mask\">\n  <div class=\"modal\">\n    <h2 id=\"modalTitle\">新增订单</h2>\n    <div class=\"form-grid\">\n      <div class=\"field\"><label>接单日期 *</label><input type=\"date\" id=\"mDate\"></div>\n      <div class=\"field\"><label>订单编号 *</label><input type=\"text\" id=\"mOrderNo\" placeholder=\"如 DD20260907-01\"></div>\n      <div class=\"field\"><label>订单金额（元）*</label><input type=\"number\" id=\"mAmount\" min=\"0\" step=\"0.01\" placeholder=\"如 850\"></div>\n      <div class=\"field\"><label>分成比例（%）*</label><input type=\"number\" id=\"mShare\" min=\"0\" max=\"100\" step=\"0.1\" placeholder=\"如 70\"></div>\n      <div class=\"field full\"><label>分类（订单进度）*</label><select id=\"mStatus\"></select></div>\n      <div class=\"field full\" id=\"doneDateField\">\n        <label>完单日期</label>\n        <input type=\"date\" id=\"mDoneDate\">\n        <span class=\"tip\">进度为「待结算 / 已结算」时必填，默认今天；改回进行中会自动清空</span>\n      </div>\n      <div class=\"field full\"><label>备注</label><textarea id=\"mNote\" placeholder=\"客户、内容类型、交接情况…（可留空）\"></textarea></div>\n    </div>\n    <div class=\"form-err\" id=\"formErr\"></div>\n    <div class=\"modal-actions\">\n      <button class=\"btn-ghost\" id=\"btnCancel\">取消</button>\n      <button class=\"btn-primary\" id=\"btnSave\">保存</button>\n    </div>\n  </div>\n</div>\n\n";

export function mount(host) {
  const shDoc = host.attachShadow({ mode: 'open' });
  shDoc.innerHTML =
    '<link rel="stylesheet" href="' + CSS_HREF + '">' +
    MARKUP;

  /* ================= 数据层：优先后端API，连不上自动降级为浏览器本地存储 ================= */
  /* V7 登录门卫：本页仅管理员可用，未登录/写手一律跳登录页 */
  const TOKEN = localStorage.getItem('jdy_token');
  const ME = JSON.parse(localStorage.getItem('jdy_user') || 'null');
  // 【v20.3】embed=1 嵌入管理工作台 iframe；preview=1 演示模式（401 不跳转、走本地空数据）
  const AH = () => ({ Authorization: 'Bearer ' + TOKEN });

  const API = '/api/orders';
  const LS_KEY = 'order_tracker_local';
  let USE_REMOTE = null;   // true=MongoDB, false=localStorage
  let orders = [];
  const STATUSES = ['待开始', '进行中', '待结算', '已结算'];
  const DONE_SET = new Set(['待结算', '已结算']);
  const ST_COLORS = { '待开始': '#94a3b8', '进行中': '#3b82f6', '待结算': '#d97706', '已交付': '#d97706', '已结算': '#16a34a' };
  const ST_LABEL = { '已交付': '待结算' };
  const stLabel = s => ST_LABEL[s] || s;

  const localDate = (d = new Date()) =>
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  async function loadOrders() {
    try {
      const r = await fetch(API + '?' + Math.random(), { signal: AbortSignal.timeout(6000), headers: AH() });
      if (r.status === 401) {
        // 401：交给外壳统一处理（setToken 失效时 app.js 会跳登录）
        localStorage.removeItem('jdy_token');
        location.href = '/login.html'; return;
      }
      if (!r.ok) throw 0;
      const j = await r.json();
      orders = j.orders || [];
      USE_REMOTE = true;
    } catch (e) {
      USE_REMOTE = false;
      orders = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    }
    render();
  }

  async function saveOrder(doc, id) {
    if (USE_REMOTE) {
      const url = id ? `${API}/${id}` : API;
      const r = await fetch(url, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', ...AH() },
        body: JSON.stringify(doc),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '保存失败');
      return j.order;
    } else {
      return doc;
    }
  }

  async function deleteOrder(id) {
    if (USE_REMOTE) {
      const r = await fetch(`${API}/${id}`, { method: 'DELETE', headers: AH() });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '删除失败');
    } else {
      orders = orders.filter(o => o._id !== id);
    }
  }

  /* ================= 时间范围（月/季/年/日） ================= */
  let periodType = 'month';
  let page = 1, pageSize = 20;   // 明细表分页

  const monthDays = fMonth => {
    const [y, m] = fMonth.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const arr = [];
    for (let i = 1; i <= last; i++) arr.push(`${fMonth}-${String(i).padStart(2, '0')}`);
    return arr;
  };

  function buildPeriodInputs() {
    const box = shDoc.getElementById('periodInputs');
    const now = new Date(), y = now.getFullYear();
    if (periodType === 'month') {
      box.innerHTML = `<input type="month" id="fMonth">`;
      shDoc.getElementById('fMonth').value = sideMonth || `${y}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      shDoc.getElementById('fMonth').onchange = () => { sideMonth = shDoc.getElementById('fMonth').value; page = 1; render(); };
    } else if (periodType === 'day') {
      box.innerHTML = `<input type="date" id="fDay">`;
      shDoc.getElementById('fDay').value = localDate();
      shDoc.getElementById('fDay').onchange = () => { page = 1; render(); };
    } else if (periodType === 'quarter') {
      const years = dataYears();
      box.innerHTML = `<select id="qYear">${years.map(v => `<option ${v === y ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <select id="qQ">${[1, 2, 3, 4].map(q => `<option value="${q}" ${q === Math.floor(now.getMonth() / 3) + 1 ? 'selected' : ''}>Q${q}</option>`).join('')}</select>`;
      shDoc.getElementById('qYear').onchange = () => { page = 1; render(); };
      shDoc.getElementById('qQ').onchange = () => { page = 1; render(); };
    } else {
      const years = dataYears();
      box.innerHTML = `<select id="yYear">${years.map(v => `<option ${v === y ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
      shDoc.getElementById('yYear').onchange = () => { page = 1; render(); };
    }
  }

  function dataYears() {
    const set = new Set([new Date().getFullYear()]);
    orders.forEach(o => { if (o.date) set.add(Number(o.date.slice(0, 4))); });
    return [...set].sort((a, b) => b - a);
  }

  function getPeriod() {
    const now = new Date(), y = now.getFullYear();
    if (periodType === 'month') {
      const v = shDoc.getElementById('fMonth').value || sideMonth || `${y}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      return { gran: 'day', start: v, end: v, scopeLabel: '本月', keys: monthDays(v), keyOf: d => d, calMonth: v };
    }
    if (periodType === 'day') {
      const v = shDoc.getElementById('fDay').value || localDate();
      return { gran: 'day', start: v, end: v, scopeLabel: '当日', keys: [v], keyOf: d => d, calMonth: null };
    }
    if (periodType === 'quarter') {
      const qy = Number(shDoc.getElementById('qYear').value), q = Number(shDoc.getElementById('qQ').value);
      const months = [1, 2, 3].map(i => `${qy}-${String((q - 1) * 3 + i).padStart(2, '0')}`);
      return { gran: 'month', start: months[0], end: months[2], scopeLabel: `${qy}年Q${q}`, keys: months, keyOf: d => d.slice(0, 7), calMonth: null };
    }
    const yy = Number(shDoc.getElementById('yYear').value);
    const months = Array.from({ length: 12 }, (_, i) => `${yy}-${String(i + 1).padStart(2, '0')}`);
    return { gran: 'month', start: `${yy}-01`, end: `${yy}-12`, scopeLabel: `${yy}年`, keys: months, keyOf: d => d.slice(0, 7), calMonth: null };
  }

  /* ================= 左侧栏：月份切换 ================= */
  let sideMonth = null;   // 侧栏当前月份 YYYY-MM
  function sideMonths() {
    const set = new Set([localDate().slice(0, 7)]);
    orders.forEach(o => {
      if (o.date) set.add(o.date.slice(0, 7));
      if (o.doneDate) set.add(o.doneDate.slice(0, 7));
    });
    return [...set].sort().reverse();
  }
  function renderSidebar() {
    if (!sideMonth) sideMonth = localDate().slice(0, 7);
    shDoc.getElementById('monCur').textContent = sideMonth;
    const has = new Set();
    orders.forEach(o => { if (o.date) has.add(o.date.slice(0, 7)); if (o.doneDate) has.add(o.doneDate.slice(0, 7)); });
    shDoc.getElementById('monList').innerHTML = sideMonths().slice(0, 8).map(m =>
      `<span class="mon-chip ${m === sideMonth ? 'cur' : ''} ${has.has(m) ? 'has' : ''}" onclick="this.getRootNode().host.__ledger.gotoMonth('${m}')">${m}</span>`).join('');
  }
  function gotoMonth(m) {
    sideMonth = m;
    periodType = 'month';
    shDoc.getElementById('fPeriodType').value = 'month';
    buildPeriodInputs();
    page = 1;
    render();
  }

  /* ================= 左侧栏：快捷查询（订单号/备注） ================= */
  function renderQuickSearch() {
    const kw = shDoc.getElementById('qKw').value.trim().toLowerCase();
    const box = shDoc.getElementById('qResults');
    if (!kw) { box.innerHTML = '<div class="q-empty">输入关键词即时匹配，点结果跳到明细行</div>'; return; }
    const hits = orders.filter(o =>
      (o.orderNo || '').toLowerCase().includes(kw) || (o.note || '').toLowerCase().includes(kw)
    ).slice(0, 12);
    box.innerHTML = hits.length ? hits.map(o => `
      <div class="q-item" onclick="this.getRootNode().host.__ledger.jumpToOrder('${o._id}')">
        <b class="cpy" data-copy="${esc(o.orderNo)}" title="点击复制单号">${esc(o.orderNo)}</b>
        <span>${fmt(r2(o.amount))} 元 · ${stLabel(o.status)}${o.note ? ' · ' + esc(o.note.slice(0, 16)) : ''}</span>
      </div>`).join('')
      : '<div class="q-empty">没有匹配的订单（订单号和备注都搜了）</div>';
  }
  function jumpToOrder(id) {
    const o = orders.find(x => x._id === id);
    if (!o) return;
    // 切到该订单所在年份视图，保证明细里能看到，再用关键词过滤定位
    periodType = 'year';
    shDoc.getElementById('fPeriodType').value = 'year';
    buildPeriodInputs();
    shDoc.getElementById('yYear').value = (o.date || localDate()).slice(0, 4);
    shDoc.getElementById('fKeyword').value = (o.orderNo || '').slice(0, 6);
    page = 1;
    render();
    setTimeout(() => {
      const card = shDoc.getElementById('tableCard');
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const row = [...shDoc.querySelectorAll('#tbody tr')].find(tr => tr.textContent.includes(o.orderNo));
      if (row) { row.classList.add('hl'); setTimeout(() => row.classList.remove('hl'), 2600); }
    }, 60);
  }

  /* ================= 左侧栏：快捷录入（默认比例40%） ================= */
  async function quickSave() {
    const orderNo = shDoc.getElementById('qkNo').value.trim();
    const amount = parseFloat(shDoc.getElementById('qkAmt').value);
    const rate = parseFloat(shDoc.getElementById('qkRate').value) || 40;
    if (!orderNo) { alert('请填订单编号'); return; }
    if (!(amount > 0)) { alert('请填正确的金额'); return; }
    const doc = { date: localDate(), orderNo, amount, shareRate: rate, status: '待开始', doneDate: null, note: '' };
    try {
      const r = await saveOrder(doc, null);
      const _id = r && r._id ? String(r._id) : 'loc-' + Date.now();
      orders.unshift(Object.assign({ _id, createdAt: new Date().toISOString() }, doc));
      persistLocal();
      shDoc.getElementById('qkNo').value = '';
      shDoc.getElementById('qkAmt').value = '';
      page = 1;
      render();
      const card = shDoc.getElementById('tableCard');
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => {
        const row = [...shDoc.querySelectorAll('#tbody tr')].find(tr => tr.textContent.includes(orderNo));
        if (row) { row.classList.add('hl'); setTimeout(() => row.classList.remove('hl'), 2600); }
      }, 80);
    } catch (e) { alert('录入失败：' + e.message); }
  }

  /* ================= 汇总与渲染 ================= */
  const fmt = n => Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const r2 = n => Math.round(n * 100) / 100;
  const share = o => o.amount * o.shareRate / 100;
  // 实际结算口径：已分单（绑定派单卡）的订单，收入统计用「分成 − 写手报酬」
  const effShare = o => share(o) - (o.dispatch && o.dispatch.reward ? o.dispatch.reward : 0);

  function render() {
    const P = getPeriod();
    const fStatus = shDoc.getElementById('fStatus').value;
    const kw = shDoc.getElementById('fKeyword').value.trim();
    const nLen = P.start.length;

    // 跨期口径：订单按「接单日 或 完单日」落范围
    const inP = d => d && d.slice(0, nLen) >= P.start && d.slice(0, nLen) <= P.end;
    const kwHit = o => !kw ||
      (o.orderNo || '').toLowerCase().includes(kw.toLowerCase()) ||
      (o.note || '').toLowerCase().includes(kw.toLowerCase());
    const view = orders.filter(o =>
      (inP(o.date) || inP(o.doneDate)) &&
      (!fStatus || o.status === fStatus || (fStatus === '待结算' && o.status === '已交付')) &&
      kwHit(o)
    );
    view.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b._id > a._id ? 1 : -1));

    const scope = orders.filter(o => inP(o.date) || inP(o.doneDate));

    const takeList = scope.filter(o => inP(o.date));
    const takeAmt = takeList.reduce((s, o) => s + o.amount, 0);
    const doneList = scope.filter(o => DONE_SET.has(stLabel(o.status)) && inP(o.doneDate));
    const doneAmt = doneList.reduce((s, o) => s + o.amount, 0);
    const pendingAmt = scope.filter(o => stLabel(o.status) === '待结算').reduce((s, o) => s + o.amount, 0);
    const settledShare = scope.filter(o => stLabel(o.status) === '已结算').reduce((s, o) => s + effShare(o), 0);
    const totalShare = scope.reduce((s, o) => s + effShare(o), 0);
    const dispatchCnt = scope.filter(o => o.dispatch).length;

    shDoc.getElementById('lblTake').textContent = P.scopeLabel + '接单金额';
    shDoc.getElementById('lblDone').textContent = P.scopeLabel + '完单金额';
    shDoc.getElementById('kTake').innerHTML = fmt(r2(takeAmt)) + '<small> 元</small>';
    shDoc.getElementById('subTake').textContent = takeList.length + ' 单';
    shDoc.getElementById('kDone').innerHTML = fmt(r2(doneAmt)) + '<small> 元</small>';
    shDoc.getElementById('subDone').textContent = doneList.length + ' 单';
    shDoc.getElementById('kPending').innerHTML = fmt(r2(pendingAmt)) + '<small> 元</small>';
    shDoc.getElementById('kSettled').innerHTML = fmt(r2(settledShare)) + '<small> 元</small>';
    shDoc.getElementById('kShare').innerHTML = fmt(r2(totalShare)) + '<small> 元</small>';
    shDoc.getElementById('subCount').textContent = scope.length + ' 单' + (dispatchCnt ? ' · 其中已分单 ' + dispatchCnt + ' 单（收入按实际结算口径：分成−报酬）' : '');
    const unitTxt = P.gran === 'day' ? '每日' : '每月';
    shDoc.getElementById('chartTitle').textContent = P.scopeLabel + unitTxt + '接单 / 完单金额';

    // —— 明细表（分页）——
    const tbody = shDoc.getElementById('tbody');
    const tfoot = shDoc.getElementById('tfoot');
    if (!view.length) {
      tbody.innerHTML = ''; tfoot.innerHTML = '';
      shDoc.getElementById('pager').innerHTML = '';
      shDoc.getElementById('emptyTip').style.display = 'block';
    } else {
      shDoc.getElementById('emptyTip').style.display = 'none';
      const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(view.length / pageSize)) : 1;
      if (page > totalPages) page = totalPages;
      const rows = pageSize > 0 ? view.slice((page - 1) * pageSize, page * pageSize) : view;
      tbody.innerHTML = rows.map(o => `
        <tr>
          <td>${o.date || ''}</td>
          <td><b class="cpy" data-copy="${esc(o.orderNo)}" title="点击复制单号">${esc(o.orderNo)}</b></td>
          <td class="num">${fmt(o.amount)}</td>
          <td class="num">${o.shareRate}%</td>
          <td class="num" style="color:var(--green);font-weight:600">${fmt(r2(share(o)))}</td>
          <td><span class="tag ${stLabel(o.status)}">${stLabel(o.status)}</span></td>
          <td>${o.doneDate || '—'}</td>
          <td>${o.dispatch ? '<span class="tag 进行中" title="已派单给 ' + esc(o.dispatch.toName) + '，报酬 ¥' + o.dispatch.reward + ' · 卡状态：' + esc(o.dispatch.status) + '">已分单·' + esc(o.dispatch.toName) + '</span>' : '<span style="color:#cbd5e1">—</span>'}</td>
          <td class="note-cell" title="${esc(o.note || '')}">${esc(o.note || '')}</td>
          <td>
            <button class="btn-mini" onclick="this.getRootNode().host.__ledger.openModal('${o._id}')">编辑</button>
            <button class="btn-danger-mini" onclick="this.getRootNode().host.__ledger.removeOrder('${o._id}')">删除</button>
          </td>
        </tr>`).join('');
      const vTake = view.reduce((s, o) => s + o.amount, 0);
      const vShare = view.reduce((s, o) => s + share(o), 0);
      tfoot.innerHTML = `<tr>
        <td colspan="2">合计 ${view.length} 单（全部页）</td>
        <td class="num">${fmt(r2(vTake))}</td>
        <td class="num">—</td>
        <td class="num" style="color:var(--green)">${fmt(r2(vShare))}</td>
        <td colspan="5"></td>
      </tr>`;
      renderPager(view.length, page, totalPages);
    }

    renderDailyChart(scope, P);
    renderLineChart(scope, P);
    renderCalendar(scope, P);
    renderStatusChart(view.length ? view : scope);
    renderTodo();
    renderSidebar();
  }

  function renderPager(total, p, tp) {
    const el = shDoc.getElementById('pager');
    const opts = [10, 20, 50, 100, 0].map(n =>
      `<option value="${n}" ${n === pageSize ? 'selected' : ''}>${n === 0 ? '全部' : n} 条/页</option>`).join('');
    el.innerHTML = `
      <span>共 ${total} 条</span>
      <select id="pgSize">${opts}</select>
      ${pageSize > 0 ? `
        <button class="btn-ghost" id="pgPrev" ${p <= 1 ? 'disabled' : ''}>‹ 上一页</button>
        <span class="pg">第 ${p} / ${tp} 页</span>
        <button class="btn-ghost" id="pgNext" ${p >= tp ? 'disabled' : ''}>下一页 ›</button>` : ''}`;
    shDoc.getElementById('pgSize').onchange = e => { pageSize = Number(e.target.value); page = 1; render(); };
    const prev = shDoc.getElementById('pgPrev');
    if (prev) prev.onclick = () => { if (page > 1) { page--; render(); window.scrollTo(0, document.documentElement.scrollHeight); } };
    const next = shDoc.getElementById('pgNext');
    if (next) next.onclick = () => { if (page < tp) { page++; render(); window.scrollTo(0, document.documentElement.scrollHeight); } };
  }

  function renderDailyChart(scope, P) {
    const box = shDoc.getElementById('dailyChart');
    const byTake = {}, byDone = {};
    scope.forEach(o => {
      if (o.date) { const k = P.keyOf(o.date); byTake[k] = (byTake[k] || 0) + o.amount; }
      const d = o.doneDate || (DONE_SET.has(stLabel(o.status)) ? o.date : null);
      if (d) { const k = P.keyOf(d); byDone[k] = (byDone[k] || 0) + o.amount; }
    });
    const max = Math.max(...P.keys.map(k => Math.max(byTake[k] || 0, byDone[k] || 0)), 1);
    const today = localDate();
    box.innerHTML = P.keys.map(k => {
      const t = byTake[k] || 0, dn = byDone[k] || 0;
      const hT = t ? Math.max(5, Math.round(t / max * 104)) : 0;
      const hD = dn ? Math.max(5, Math.round(dn / max * 104)) : 0;
      return `<div class="bar-col ${k === today ? 'today' : ''}" title="${k}
  接单 ${fmt(r2(t))} 元 / 完单 ${fmt(r2(dn))} 元">
        <div class="amt"></div>
        <div class="pair">
          <div class="bar take" style="height:${hT || 1}px;${t ? '' : 'background:#e2e8f0'}"></div>
          <div class="bar done" style="height:${hD || 1}px;${dn ? '' : 'background:#e2e8f0'}"></div>
        </div>
        <div class="day">${P.gran === 'day' ? k.slice(8) : k.slice(5)}</div></div>`;
    }).join('');
    const tSum = P.keys.reduce((s, k) => s + (byTake[k] || 0), 0);
    const dSum = P.keys.reduce((s, k) => s + (byDone[k] || 0), 0);
    shDoc.getElementById('chartFoot').innerHTML =
      `区间合计：接单 <b>${fmt(r2(tSum))}</b> 元 · 完单 <b>${fmt(r2(dSum))}</b> 元（蓝柱高=接单多、绿柱高=完单多，同刻度直接比高低；悬停看精确数）`;
  }

  function drawLine(box, keys, values, color, dashed, unit, wide) {
    const vmax = Math.max(...values, 1);
    const W = wide ? Math.max(1100, keys.length * 42) : Math.max(520, keys.length * 46), H = wide ? 320 : 210;
    const padL = 56, padR = 14, padT = 14, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const x = i => keys.length === 1 ? padL + iw / 2 : padL + i * iw / (keys.length - 1);
    const y = v => padT + ih - v / vmax * ih;
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const gv = vmax * i / 4, gy = y(gv);
      g += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#e2e8f0" stroke-width="1"/>
            <text x="${padL - 6}" y="${gy + 4}" text-anchor="end" font-size="10" fill="#94a3b8">${fmt(Math.round(gv))}</text>`;
    }
    const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const today = localDate();
    const lblStep = Math.max(1, Math.ceil(keys.length / 14));
    const xlabels = keys.map((k, i) => i % lblStep === 0 || k === today
      ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${k === today ? '#8b5cf6' : '#94a3b8'}" font-weight="${k === today ? 700 : 400}">${k.slice(5)}</text>` : '').join('');
    const dots = values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${color}"><title>${keys[i]}
  ${unit} ${fmt(r2(v))} 元</title></circle>`).join('');
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${g}
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2"${dashed ? ' stroke-dasharray="5 4"' : ''}/>
      ${dots}
      ${xlabels}
    </svg>`;
  }

  /* ================= 收入走势：方块卡 + 点击弹窗 ================= */
  let chartData = null;
  function renderLineChart(scope, P) {
    const daily = P.keys.map(k => scope.filter(o => P.keyOf(o.date) === k).reduce((s, o) => s + effShare(o), 0));
    let acc = 0;
    const cum = daily.map(v => r2(acc += v));
    const unitTxt = P.gran === 'day' ? '每日' : '每月';
    const peak = Math.max(...daily);
    const peakIdx = daily.indexOf(peak);
    chartData = { P, daily, cum, scope };
    shDoc.getElementById('tileDTitle').textContent = P.scopeLabel + unitTxt + '分成收入走势（预计）';
    shDoc.getElementById('tileCTitle').textContent = P.scopeLabel + unitTxt + '累计分成收入走势';
    shDoc.getElementById('tileDVal').innerHTML = fmt(r2(peak)) + '<small> 元</small>';
    shDoc.getElementById('tileDSub').textContent = peak > 0 ? `单日峰值 · ${P.keys[peakIdx]} · 点击看走势 →` : '暂无收入，点击看走势 →';
    shDoc.getElementById('tileCVal').innerHTML = fmt(r2(cum[cum.length - 1] || 0)) + '<small> 元</small>';
    shDoc.getElementById('tileCSub').textContent = '累计终点 = 预计总收入 · 点击看走势 →';
  }
  function openChart(kind) {
    if (!chartData) return;
    const { P, daily, cum } = chartData;
    if (kind === 'daily') {
      shDoc.getElementById('chartMTitle').textContent = shDoc.getElementById('tileDTitle').textContent;
      drawLine(shDoc.getElementById('chartMBody'), P.keys, daily, '#3b82f6', false, '当日分成收入', true);
    } else {
      shDoc.getElementById('chartMTitle').textContent = shDoc.getElementById('tileCTitle').textContent;
      drawLine(shDoc.getElementById('chartMBody'), P.keys, cum, '#16a34a', true, '累计分成收入', true);
    }
    shDoc.getElementById('chartMask').classList.add('show');
  }
  function closeChart() { shDoc.getElementById('chartMask').classList.remove('show'); }

  /* ================= 日历看板（点击日期弹当日明细） ================= */
  function dayStatsOf(d) {
    const take = orders.filter(o => o.date === d);
    const done = orders.filter(o => o.doneDate === d && DONE_SET.has(stLabel(o.status)));
    return {
      take, done,
      takeAmt: take.reduce((s, o) => s + o.amount, 0),
      doneAmt: done.reduce((s, o) => s + o.amount, 0),
      shareAmt: done.reduce((s, o) => s + effShare(o), 0),
    };
  }

  function renderCalendar(scope, P) {
    const card = shDoc.getElementById('calendarCard');
    const grid = shDoc.getElementById('calGrid');
    if (!P.calMonth) { card.style.display = 'none'; return; }
    card.style.display = '';
    shDoc.getElementById('calTitle').textContent = P.calMonth + ' 日历看板（点日期看当天接单明细）';

    // 今日简报：接单金额 / 完单金额 / 预计今天完单金额收入
    const td = dayStatsOf(localDate());
    shDoc.getElementById('todayBrief').innerHTML = `
      <span class="tb-take">今日接单金额：<b>${fmt(r2(td.takeAmt))}</b> 元（${td.take.length} 单）</span>
      <span class="tb-done">今日完单金额：<b>${fmt(r2(td.doneAmt))}</b> 元（${td.done.length} 单）</span>
      <span class="tb-share">预计今天完单金额收入：<b>${fmt(r2(td.shareAmt))}</b> 元</span>`;

    const byTake = {}, byShare = {}, byDone = {};
    scope.forEach(o => {
      if (o.date) byTake[o.date] = (byTake[o.date] || 0) + o.amount;
      const dk = o.doneDate || (DONE_SET.has(stLabel(o.status)) ? o.date : null);
      if (dk) {
        byShare[dk] = (byShare[dk] || 0) + effShare(o);
        if (DONE_SET.has(stLabel(o.status)) && o.doneDate) byDone[dk] = (byDone[dk] || 0) + o.amount;
      }
    });
    const days = monthDays(P.calMonth);
    const maxShare = Math.max(...days.map(d => byShare[d] || 0), 1);
    const startWd = (new Date(P.calMonth + '-01').getDay() + 6) % 7;   // 周一=0
    const today = localDate();
    const blanks = Array.from({ length: startWd }, () => '<div class="cal-cell blank"></div>').join('');
    const cells = days.map(d => {
      const t = byTake[d] || 0, dn = byDone[d] || 0, sh = r2(byShare[d] || 0);
      const alpha = sh > 0 ? (0.07 + 0.45 * (sh / maxShare)).toFixed(2) : 0;
      return `<div class="cal-cell ${d === today ? 'today' : ''}" style="${sh > 0 ? `background:rgba(22,163,74,${alpha})` : ''}"
        onclick="this.getRootNode().host.__ledger.openDayModal('${d}')" title="点击查看 ${d} 当天接单明细">
        <div class="cal-d">${Number(d.slice(8))}</div>
        <div class="cal-vals">接 ${fmt(r2(t))}<br>完 ${fmt(r2(dn))}<br>收 ${fmt(sh)}</div>
      </div>`;
    }).join('');
    grid.innerHTML = blanks + cells;
  }

  /* ---- 日历单日大弹窗 ---- */
  let dayModalDate = null;
  function openDayModal(d) {
    dayModalDate = d;
    renderDayModal();
    shDoc.getElementById('dayMask').classList.add('show');
  }
  function closeDayModal() { dayModalDate = null; shDoc.getElementById('dayMask').classList.remove('show'); }
  function renderDayModal() {
    const d = dayModalDate;
    if (!d) return;
    const st = dayStatsOf(d);
    shDoc.getElementById('dayMTitle').textContent = d + ' 当天接单情况';
    shDoc.getElementById('dayStats').innerHTML = `
      <div class="ds blue">接单金额（当日登记）<b>${fmt(r2(st.takeAmt))} 元 · ${st.take.length} 单</b></div>
      <div class="ds green">完单金额（当日做完）<b>${fmt(r2(st.doneAmt))} 元 · ${st.done.length} 单</b></div>
      <div class="ds purple">预计完单分成收入<b>${fmt(r2(st.shareAmt))} 元</b></div>`;
    const list = [...st.take, ...st.done.filter(o => o.date !== d)]
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const box = shDoc.getElementById('dayTableBox');
    if (!list.length) {
      box.innerHTML = '<div class="empty">当天没有接单 / 完单记录</div>';
    } else {
      box.innerHTML = `<table>
        <thead><tr>
          <th>接单日</th><th>订单编号</th>
          <th class="num">订单金额（元）</th><th class="num">分成比例</th><th class="num">分成金额（元）</th>
          <th>分类</th><th>完单日</th><th>备注</th><th style="width:90px">操作</th>
        </tr></thead>
        <tbody>
          ${list.map(o => `
            <tr>
              <td>${o.date || ''}</td>
              <td><b class="cpy" data-copy="${esc(o.orderNo)}" title="点击复制单号">${esc(o.orderNo)}</b>${o.doneDate === d && o.date !== d ? ' <span class="tag 待结算" title="当天完单">当日完单</span>' : ''}</td>
              <td class="num">${fmt(o.amount)}</td>
              <td class="num">${o.shareRate}%</td>
              <td class="num" style="color:var(--green);font-weight:600">${fmt(r2(share(o)))}</td>
              <td><span class="tag ${stLabel(o.status)}">${stLabel(o.status)}</span></td>
              <td>${o.doneDate || '—'}</td>
              <td>${o.dispatch ? '<span class="tag 进行中" title="已派单给 ' + esc(o.dispatch.toName) + '，报酬 ¥' + o.dispatch.reward + '">已分单·' + esc(o.dispatch.toName) + '</span>' : '<span style="color:#cbd5e1">—</span>'}</td>
              <td class="note-cell" title="${esc(o.note || '')}">${esc(o.note || '')}</td>
              <td>
                <button class="btn-mini" onclick="this.getRootNode().host.__ledger.openModal('${o._id}')">编辑</button>
                <button class="btn-danger-mini" onclick="this.getRootNode().host.__ledger.removeOrder('${o._id}')">删除</button>
              </td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="2">合计 ${list.length} 单</td>
          <td class="num">${fmt(r2(list.reduce((s, o) => s + o.amount, 0)))}</td>
          <td class="num">—</td>
          <td class="num" style="color:var(--green)">${fmt(r2(list.reduce((s, o) => s + share(o), 0)))}</td>
          <td colspan="5"></td>
        </tr></tfoot>
      </table>`;
    }
    shDoc.getElementById('dayHint').textContent = '编辑 / 删除后本弹窗自动刷新；「当日完单」标记 = 接单日在别处、当天做完的订单。';
  }

  function renderStatusChart(view) {
    const box = shDoc.getElementById('statusChart');
    const total = view.reduce((s, o) => s + o.amount, 0) || 1;
    box.innerHTML = STATUSES.map(st => {
      const list = view.filter(o => stLabel(o.status) === st);
      const amt = list.reduce((s, o) => s + o.amount, 0);
      const pct = Math.round(amt / total * 100);
      return `<div class="st-row">
        <span class="name"><span class="tag ${st}">${st}</span></span>
        <div class="track"><div class="fill" style="width:${pct}%;background:${ST_COLORS[st]}"></div></div>
        <span class="nums"><b>${list.length}</b> 单 · ${fmt(r2(amt))} 元 · ${pct}%</span>
      </div>`;
    }).join('');
  }

  /* ================= 今日待跟进（进行中/待开始） ================= */
  function renderTodo() {
    const banner = shDoc.getElementById('todoBanner');
    const list = orders.filter(o => ['待开始', '进行中'].includes(stLabel(o.status)));
    if (!list.length) { banner.style.display = 'none'; return; }
    banner.style.display = '';
    shDoc.getElementById('todoCount').textContent = list.length + ' 笔';
    shDoc.getElementById('todoList').innerHTML = list.map(o => `
      <div class="todo-item">
        <span class="tag ${stLabel(o.status)}">${stLabel(o.status)}</span>
        <b class="cpy" data-copy="${esc(o.orderNo)}" title="点击复制单号">${esc(o.orderNo)}</b>
        <span class="todo-meta">接单日 ${o.date} · ${fmt(o.amount)} 元 · 分成 ${fmt(r2(share(o)))} 元${o.note ? ' · ' + esc(o.note) : ''}</span>
        <select class="todo-act" data-id="${o._id}">
          <option value="">更新进度 →</option>
          ${STATUSES.filter(s => s !== stLabel(o.status)).map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
      </div>`).join('');
    shDoc.querySelectorAll('.todo-act').forEach(sel => {
      sel.onchange = () => { if (sel.value) quickUpdate(sel.dataset.id, sel.value); };
    });
  }

  async function quickUpdate(id, st) {
    const o = orders.find(x => x._id === id);
    if (!o) return;
    const doc = {
      date: o.date, orderNo: o.orderNo, amount: o.amount, shareRate: o.shareRate,
      status: st, doneDate: DONE_SET.has(st) ? (o.doneDate || localDate()) : null, note: o.note || '',
    };
    try {
      await saveOrder(doc, id);
      const i = orders.findIndex(x => x._id === id);
      if (i > -1) orders[i] = Object.assign({}, orders[i], doc);
      persistLocal();
      render();
      if (dayModalDate) renderDayModal();
    }
    catch (e) { alert('更新失败：' + e.message); }
  }

  /* ================= 交互 ================= */
  let editingId = null;
  const $ = id => shDoc.getElementById(id);
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // 【v23.3】单号点击复制：台账原来被 App 壳的 user-select:none 禁了选中，用户没法复制单号。
  // 现在除了放开选中，带 .cpy 的单号点一下直接进剪贴板。
  let cpyT = null;
  function cpyToast(msg) {
    // 注意：ShadowRoot 没有 createElement，元素要用 document.createElement 再挂进 shadow
    const t = document.createElement('div');
    t.className = 'cpy-toast';
    t.textContent = msg;
    const old = shDoc.querySelector('.cpy-toast');
    if (old) old.remove();
    shDoc.appendChild(t);
    clearTimeout(cpyT);
    cpyT = setTimeout(() => t.remove(), 1600);
  }
  async function copyText(txt) {
    try { await navigator.clipboard.writeText(txt); return true; }
    catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        shDoc.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
  }
  shDoc.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('.cpy');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const txt = el.dataset.copy || el.textContent.trim();
    copyText(txt).then(ok => cpyToast(ok ? '已复制：' + txt : '复制失败，请手动选中文字复制'));
  });

  function openModal(id) {
    editingId = id || null;
    $('formErr').textContent = '';
    $('modalTitle').textContent = id ? '编辑订单' : '新增订单';
    const o = id ? orders.find(x => x._id === id) : null;
    $('mDate').value = o ? o.date : localDate();
    $('mOrderNo').value = o ? o.orderNo : 'DD' + localDate().replace(/-/g, '') + '-';
    $('mAmount').value = o ? o.amount : '';
    $('mShare').value = o ? o.shareRate : '';
    $('mStatus').value = o ? stLabel(o.status) : '进行中';
    $('mDoneDate').value = o ? (o.doneDate || '') : localDate();
    $('mNote').value = o ? (o.note || '') : '';
    toggleDoneField();
    $('mask').classList.add('show');
    if (!id) { $('mAmount').focus(); }
  }
  function closeModal() { $('mask').classList.remove('show'); }

  function toggleDoneField() {
    const done = DONE_SET.has($('mStatus').value);
    const f = $('doneDateField');
    f.style.opacity = done ? '1' : '.45';
    $('mDoneDate').disabled = !done;
    if (done && !$('mDoneDate').value) $('mDoneDate').value = localDate();
  }

  async function submitOrder() {
    const st = $('mStatus').value;
    const doc = {
      date: $('mDate').value,
      orderNo: $('mOrderNo').value.trim(),
      amount: parseFloat($('mAmount').value),
      shareRate: parseFloat($('mShare').value),
      status: st,
      doneDate: DONE_SET.has(st) ? ($('mDoneDate').value || localDate()) : null,
      note: $('mNote').value.trim(),
    };
    const errs = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.date)) errs.push('请选择接单日期');
    if (!doc.orderNo) errs.push('订单编号不能为空');
    if (!(doc.amount >= 0) || isNaN(doc.amount)) errs.push('金额必须是非负数字');
    if (!(doc.shareRate > 0 && doc.shareRate <= 100)) errs.push('分成比例须为 1-100');
    if (DONE_SET.has(st) && !/^\d{4}-\d{2}-\d{2}$/.test(doc.doneDate)) errs.push('请填写完单日期');
    if (errs.length) { $('formErr').textContent = errs.join('；'); return; }
    try {
      const r = await saveOrder(doc, editingId);
      closeModal();
      if (editingId) {
        const i = orders.findIndex(x => x._id === editingId);
        if (i > -1) orders[i] = Object.assign({}, orders[i], doc);
      } else {
        const _id = r && r._id ? String(r._id) : 'loc-' + Date.now();
        orders.unshift(Object.assign({ _id, createdAt: new Date().toISOString() }, doc));
      }
      persistLocal();
      render();
      if (dayModalDate) renderDayModal();
    } catch (e) {
      $('formErr').textContent = e.message;
    }
  }

  async function removeOrder(id) {
    // 【2026-09-17 修复】订单编号不再拼进 onclick 字符串（编号含引号会破坏 JS 语法），按 id 反查
    const o = orders.find(x => x._id === id);
    const no = o ? o.orderNo : '';
    if (!confirm('确定删除订单「' + no + '」？删除后不可恢复。')) return;
    try {
      await deleteOrder(id);
      orders = orders.filter(x => x._id !== id);
      persistLocal();
      render();
      if (dayModalDate) renderDayModal();
    } catch (e) { alert('删除失败：' + e.message); }
  }

  function persistLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(orders)); } catch (e) {} }

  function exportCSV() {
    const rows = [['接单日期', '订单编号', '订单金额', '分成比例(%)', '分成金额', '分类', '完单日期', '备注']];
    let ta = 0, ts = 0;
    orders.forEach(o => {
      rows.push([o.date, o.orderNo, o.amount, o.shareRate, share(o).toFixed(2), stLabel(o.status), o.doneDate || '', o.note || '']);
      ta += o.amount; ts += share(o);
    });
    rows.push(['合计', orders.length + ' 单', ta.toFixed(2), '', ts.toFixed(2), '', '', '']);
    const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = '订单台账_' + localDate() + '.csv';
    a.click();
  }

  /* ================= 初始化 ================= */
  (function init() {
    $('todayStr').textContent = '今天 ' + new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
    const stSel = $('fStatus'), mSel = $('mStatus');
    STATUSES.forEach(s => {
      stSel.insertAdjacentHTML('beforeend', `<option value="${s}">${s}</option>`);
      mSel.insertAdjacentHTML('beforeend', `<option value="${s}">${s}</option>`);
    });
    $('fPeriodType').onchange = () => { periodType = $('fPeriodType').value; page = 1; buildPeriodInputs(); render(); };
    buildPeriodInputs();
    $('btnAdd').onclick = () => openModal(null);
    $('btnCancel').onclick = closeModal;
    $('btnSave').onclick = submitOrder;
    $('btnExport').onclick = exportCSV;
    $('mask').onclick = e => { if (e.target === $('mask')) closeModal(); };
    $('fStatus').onchange = () => { page = 1; render(); };
    $('fKeyword').oninput = () => { page = 1; render(); };
    $('mStatus').onchange = toggleDoneField;
    $('mAmount').addEventListener('keydown', e => { if (e.key === 'Enter') submitOrder(); });

    // 左侧栏
    $('monPrev').onclick = () => {
      const [y, m] = sideMonth.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      gotoMonth(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    };
    $('monNext').onclick = () => {
      const [y, m] = sideMonth.split('-').map(Number);
      const d = new Date(y, m, 1);
      gotoMonth(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    };
    $('qKw').oninput = renderQuickSearch;
    $('qkSave').onclick = quickSave;
    $('qkAmt').addEventListener('keydown', e => { if (e.key === 'Enter') quickSave(); });
    $('qkNo').addEventListener('keydown', e => { if (e.key === 'Enter') shDoc.getElementById('qkAmt').focus(); });

    loadOrders().then(() => {
      const el = $('dbState');
      if (USE_REMOTE) { el.textContent = 'MongoDB 云端已连接'; el.className = ''; }
      else { el.textContent = '本地模式（未连上服务器，数据暂存本浏览器）'; el.className = 'offline'; }
    });
  })();


    /* 【v20.6】嵌入模式下的侧栏抽屉开关：
       后台左侧已经有导航了，台账自己的侧栏（月份切换/快捷查询/快捷录入）改挂右下角 ⚡，
       点开可用、点空白/按 Esc 收起；独立打开本页时按钮不显示，侧栏照旧常驻在左边。 */
    (function () {
      var fab = shDoc.getElementById('sideFab');
      var sb = shDoc.querySelector('.sidebar');
      if (!fab || !sb) return;
      function setOpen(on) {
        sb.classList.toggle('open', on);
        fab.classList.toggle('on', on);
        fab.setAttribute('aria-expanded', on ? 'true' : 'false');
        fab.setAttribute('title', on ? '收起快捷工具' : '快捷工具：月份切换 / 快捷查询 / 快捷录入');
      }
      fab.addEventListener('click', function (e) {
        e.stopPropagation();
        setOpen(!sb.classList.contains('open'));
      });
      // 【v24.1】按用户反馈去掉"点空白处自动收起"——点表格/翻页都会把抽屉关掉，太烦。
      // 现在只有两种方式收起：再点一次 ⚡，或按 Esc。抽屉保持打开不影响其他操作。
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    })();
  

  // 页内跳转改成壳内导航：原页面「派单工作台 →」是外链，在面板里点会把整个后台替换掉
  shDoc.querySelectorAll('a[href^="/"]').forEach(a => {
    a.addEventListener('click', e => {
      let to = null;
      try { to = { '/dispatch.html': 'dispatch', '/index.html': 'orders' }[new URL(a.getAttribute('href'), location.origin).pathname]; } catch (err) {}
      if (to && typeof window.navigate === 'function') { e.preventDefault(); window.navigate(to); }
    });
  });

  // 行内 onclick 的落点：模板里写的是 this.getRootNode().host.__ledger.xxx(...)，
  // 因为模块作用域里的函数不是全局的（直接写 xxx() 会 ReferenceError）。
  host.__ledger = {
    openChart, closeChart, closeDayModal,
    gotoMonth, jumpToOrder, openModal, removeOrder, openDayModal,
    logout: () => {
      localStorage.removeItem('jdy_token');
      localStorage.removeItem('jdy_user');
      location.href = '/login.html';
    },
  };

  return { refresh: () => loadOrders() };
}
