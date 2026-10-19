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
const MARKUP = "\n<div class=\"layout\">\n\n  <!-- ===== 左侧快捷导航栏 ===== -->\n  <aside class=\"sidebar\">\n    <div class=\"side-card\">\n      <h4>📅 月份切换</h4>\n      <div class=\"mon-nav\">\n        <button class=\"btn-ghost\" id=\"monPrev\">‹</button>\n        <b id=\"monCur\">—</b>\n        <button class=\"btn-ghost\" id=\"monNext\">›</button>\n      </div>\n      <div class=\"mon-list\" id=\"monList\"></div>\n      <div class=\"side-tip\">带 · 的月份有订单数据，点月份名可切换明细与日历</div>\n    </div>\n\n    <div class=\"side-card\">\n      <h4>🔍 快捷查询</h4>\n      <input type=\"search\" id=\"qKw\" placeholder=\"订单号 / 备注关键词\">\n      <div class=\"q-results\" id=\"qResults\"><div class=\"q-empty\">输入关键词即时匹配，点结果跳到明细行</div></div>\n    </div>\n\n    <div class=\"side-card quick-form\">\n      <h4>⚡ 快捷录入（比例默认<span id=\"qkRateHint\">45</span>%）</h4>\n      <input type=\"text\" id=\"qkNo\" placeholder=\"订单编号 *\">\n      <div class=\"row2\">\n        <input type=\"number\" id=\"qkAmt\" placeholder=\"金额（元）*\" min=\"0\" step=\"0.01\">\n        <input type=\"number\" id=\"qkRate\" value=\"45\" min=\"1\" max=\"100\" step=\"0.1\" title=\"分成比例%\" style=\"max-width:74px\">\n      </div>\n      <button class=\"btn-primary\" id=\"qkSave\">⚡ 一键录入</button>\n      <div class=\"side-tip\">接单日=今天 · 分类=待开始 · 完单后到明细里改进度</div>\n    </div>\n  </aside>\n\n  <!-- ===== 主内容 ===== -->\n  <div class=\"main\">\n    <div class=\"wrap\">\n      <header>\n        <h1>📋 订单统计系统</h1>\n        <div class=\"meta\">数据源：<b id=\"dbState\">连接中…</b> · <span id=\"todayStr\"></span> · 兼职写手接单台账 · <a href=\"/admin.html\" style=\"color:#b0642c\">🏠 管理工作台</a> · <a href=\"/admin.html#mall\" style=\"color:#07c160\">用户端配置</a> · <a href=\"/admin.html#game\" style=\"color:#7c4dff\">游戏管控</a> · <a href=\"#\" onclick=\"this.getRootNode().host.__ledger.logout();return false\" style=\"color:var(--sub)\">退出登录</a></div>\n      </header>\n\n      <!-- ===== 今日待跟进 ===== -->\n      <section class=\"todo-banner\" id=\"todoBanner\" style=\"display:none\">\n        <div class=\"todo-head\">🔔 今日待跟进订单（待开始 / 进行中）—— <span id=\"todoCount\"></span>，右侧下拉可直接更新进度</div>\n        <div class=\"todo-list\" id=\"todoList\"></div>\n      </section>\n\n      <!-- ===== 核心看板 ===== -->\n      <section class=\"kpis\">\n        <div class=\"kpi blue\"><div class=\"label\" id=\"lblTake\">接单金额</div><div class=\"value\" id=\"kTake\">0<small> 元</small></div><div class=\"sub\" id=\"subTake\">— 单</div></div>\n        <div class=\"kpi green\"><div class=\"label\" id=\"lblDone\">完单金额</div><div class=\"value\" id=\"kDone\">0<small> 元</small></div><div class=\"sub\" id=\"subDone\">— 单</div></div>\n        <div class=\"kpi amber\"><div class=\"label\">待结算（已交付未结算）</div><div class=\"value\" id=\"kPending\">0<small> 元</small></div><div class=\"sub\">按订单金额计</div></div>\n        <div class=\"kpi purple\"><div class=\"label\">已结算（我的分成）</div><div class=\"value\" id=\"kSettled\">0<small> 元</small></div><div class=\"sub\">已到账口径</div></div>\n        <div class=\"kpi blue\"><div class=\"label\">预计总收入</div><div class=\"value\" id=\"kShare\">0<small> 元</small></div><div class=\"sub\" id=\"subCount\">— 单</div></div>\n      </section>\n\n      <section class=\"panels\">\n        <div class=\"panel\">\n          <h3 id=\"chartTitle\">每日接单 / 完单金额</h3>\n          <div class=\"legend\">\n            <span><i style=\"background:var(--blue)\"></i>接单金额（按接单日）</span>\n            <span><i style=\"background:var(--green)\"></i>完单金额（按完单日，待结算+已结算）</span>\n            <span style=\"color:#94a3b8\">鼠标悬停柱子看当日数值</span>\n          </div>\n          <div class=\"bars\" id=\"dailyChart\"></div>\n          <div class=\"chart-foot\" id=\"chartFoot\"></div>\n        </div>\n        <div class=\"panel\">\n          <h3>订单分类看板（按进度）</h3>\n          <div class=\"status-rows\" id=\"statusChart\"></div>\n          <div class=\"st-note\">口径说明：<b>待结算 = 已交付未结算</b>，客户已收货、钱还没到；「已结算」才算到账。完单金额 = 待结算 + 已结算。</div>\n        </div>\n      </section>\n\n      <!-- ===== 收入走势（方块卡，点击弹窗看图） ===== -->\n      <section class=\"panels\" style=\"margin-bottom:16px;grid-template-columns:1fr 1fr\">\n        <div class=\"panel chart-tile\" onclick=\"this.getRootNode().host.__ledger.openChart('daily')\">\n          <h3 id=\"tileDTitle\">每日分成收入走势（预计）</h3>\n          <div class=\"tile-big\" id=\"tileDVal\">—</div>\n          <div class=\"tile-sub\" id=\"tileDSub\">点击查看走势图 →</div>\n        </div>\n        <div class=\"panel chart-tile\" onclick=\"this.getRootNode().host.__ledger.openChart('cum')\">\n          <h3 id=\"tileCTitle\">累计分成收入走势</h3>\n          <div class=\"tile-big\" id=\"tileCVal\">—</div>\n          <div class=\"tile-sub\" id=\"tileCSub\">点击查看走势图 →</div>\n        </div>\n      </section>\n\n      <!-- ===== 日历看板 ===== -->\n      <section class=\"panel\" style=\"margin-bottom:16px\" id=\"calendarCard\">\n        <h3 id=\"calTitle\">日历看板</h3>\n        <div class=\"today-brief\" id=\"todayBrief\"></div>\n        <div class=\"cal-head\"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>\n        <div class=\"cal-grid\" id=\"calGrid\"></div>\n        <div class=\"cal-legend\">\n          口径：<b>接单金额</b> = 当日登记的接单金额汇总 · <b>完单金额</b> = 当日做完（提交待结算/已结算）订单金额汇总 · <b>预计今天完单金额收入</b> = 当日完单订单的分成合计。\n          绿色深浅 = 预计当日收入。<b>点任意日期 → 弹出当天接单明细，可直接编辑/删除。</b>\n        </div>\n      </section>\n\n      <!-- ===== 明细表 ===== -->\n      <section class=\"toolbar\" id=\"tableTop\">\n        <select id=\"fPeriodType\" title=\"时间范围类型\">\n          <option value=\"month\">按月</option>\n          <option value=\"quarter\">按季度</option>\n          <option value=\"year\">按年</option>\n          <option value=\"day\">按日</option>\n        </select>\n        <span id=\"periodInputs\" style=\"display:inline-flex;gap:8px;align-items:center\"></span>\n        <select id=\"fStatus\"><option value=\"\">全部分类</option></select>\n        <input type=\"search\" id=\"fKeyword\" placeholder=\"搜订单编号 / 备注…\">\n        <span class=\"grow\"></span>\n        <a class=\"btn-ghost\" href=\"/dispatch.html\" style=\"text-decoration:none;display:inline-flex;align-items:center\">派单工作台 →</a>\n        <button class=\"btn-ghost\" id=\"btnExport\">导出 CSV</button><button class=\"btn-ghost\" id=\"btnRate\" title=\"把勾选的、或全部未结算订单的分成比例一次改完\">批量改分成</button><button class=\"btn-ghost\" id=\"btnAg\" title=\"按时间段和分类筛未结算单：看每单从接单日已等待几天，并汇总要付多少\">📆 高级筛选</button><button class=\"btn-ghost\" id=\"btnFind\" title=\"粘贴支付宝账单文本，按订单号定位台账里的单（只查询，不改状态）\">📥 账单找单</button><button class=\"btn-ghost\" id=\"btnReview\" title=\"逐单对账时撞上限额对不上 / 重复单号 / 台账查无此号的那些笔，先记在这里最后统一处理\" style=\"display:none\">🔎 二次核验</button>\n        <button class=\"btn-primary\" id=\"btnAdd\">＋ 新增订单</button>\n      </section>\n\n      <div class=\"table-card\" id=\"tableCard\">\n        <table>\n          <thead>\n            <tr>\n              <th style=\"width:32px\"><input type=\"checkbox\" id=\"ckAll\" title=\"全选/取消本页\"></th><th>接单日</th><th>订单编号</th>\n              <th class=\"num\">订单金额（元）</th><th class=\"num\">分成比例</th><th class=\"num\">分成金额（元）</th>\n              <th>分类</th><th>完单日</th><th>分单</th><th>备注</th><th style=\"width:90px\">操作</th>\n            </tr>\n          </thead>\n          <tbody id=\"tbody\"></tbody>\n          <tfoot id=\"tfoot\"></tfoot>\n        </table>\n        <div class=\"empty\" id=\"emptyTip\" style=\"display:none\">暂无订单，点右上角「＋ 新增订单」或左侧「⚡ 快捷录入」</div>\n        <div class=\"pager\" id=\"pager\"></div>\n      </div>\n      <div class=\"hint\">分成金额 = 订单金额 × 分成比例；「待结算」即已交付等钱的状态，「已结算」为实际到账口径。已分单订单在收入统计中按实际结算金额（分成 − 写手报酬）计入。</div>\n    </div>\n  </div>\n</div>\n\n<!-- 悬浮工具开关（仅嵌入后台时显示）：月份切换 · 快捷查询 · 快捷录入 -->\n<button class=\"side-fab\" id=\"sideFab\" type=\"button\" aria-expanded=\"false\"\n        title=\"快捷工具：月份切换 / 快捷查询 / 快捷录入\" aria-label=\"快捷工具\">⚡</button>\n\n<!-- 走势图弹窗（加宽） -->\n<div class=\"mask\" id=\"chartMask\" onclick=\"if(event.target===this)this.getRootNode().host.__ledger.closeChart()\">\n  <div class=\"modal chart-modal\">\n    <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:10px\">\n      <h2 id=\"chartMTitle\" style=\"font-size:16px;font-weight:700\"></h2>\n      <button class=\"btn-ghost\" onclick=\"this.getRootNode().host.__ledger.closeChart()\">关闭</button>\n    </div>\n    <div class=\"line-wrap\" id=\"chartMBody\"></div>\n  </div>\n</div>\n\n<!-- 日历单日明细大弹窗 -->\n<div class=\"mask\" id=\"dayMask\" onclick=\"if(event.target===this)this.getRootNode().host.__ledger.closeDayModal()\">\n  <div class=\"modal day-modal\">\n    <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:12px\">\n      <h2 id=\"dayMTitle\" style=\"font-size:16px;font-weight:700\"></h2>\n      <button class=\"btn-ghost\" onclick=\"this.getRootNode().host.__ledger.closeDayModal()\">关闭</button>\n    </div>\n    <div class=\"day-stats\" id=\"dayStats\"></div>\n    <div class=\"table-card\" id=\"dayTableBox\"></div>\n    <div class=\"hint\" id=\"dayHint\"></div>\n  </div>\n</div>\n\n<!-- 批量改分成弹窗 -->\n<div class=\"mask\" id=\"rateMask\">\n  <div class=\"modal\" style=\"max-width:540px\">\n    <h2>批量修改分成比例</h2>\n    <div class=\"field full\"><label>修改范围</label>\n      <select id=\"rateScope\">\n        <option value=\"sel\">仅已勾选的订单</option>\n        <option value=\"all\">全部未结算订单（不含「已结算」）</option>\n      </select>\n    </div>\n    <div class=\"field\"><label>新分成比例（%）</label><input type=\"number\" id=\"rateNew\" min=\"1\" max=\"100\" step=\"0.1\" value=\"45\"></div>\n    <label style=\"display:flex;gap:6px;align-items:center;font-size:13px;margin:10px 0\"><input type=\"checkbox\" id=\"rateAlsoDefault\"> 同时把该比例设为「新单默认分成比例」</label>\n    <div class=\"hint\" id=\"ratePreview\" style=\"margin:0 0 8px\">—</div>\n    <div class=\"form-err\" id=\"rateErr\"></div>\n    <div class=\"modal-actions\">\n      <button class=\"btn-ghost\" id=\"rateCancel\">取消</button>\n      <button class=\"btn-danger\" id=\"rateSave\">确认修改</button>\n    </div>\n  </div>\n</div>\n\n<!-- 账单粘贴找单（只查询，不改状态） -->\n<div class=\"mask\" id=\"findMask\">\n  <div class=\"modal find-modal\">\n    <div class=\"find-head\"><h2>📥 账单粘贴找单</h2><button class=\"btn-ghost find-x\" id=\"findClose\" title=\"关闭（Esc）\">✕</button></div>\n    <div class=\"hint\">把支付宝「批量付款」明细整块复制进来，自动识别 10-20 位订单号并对照台账。<b>这里只查询、不改任何数据</b>：要改「待结算 → 已结算」，点行上的「定位」回到明细，用原来的编辑按钮自己改。</div>\n    <textarea id=\"findText\" class=\"find-text\" rows=\"7\" placeholder=\"粘贴账单文本，例如：&#10;20261017110070001506610098468497&#10;2026-10-17 15:31:55&#10;转账&#10;批量付款-工资-技术服务-3316397630001242690&#10;35.86 58.36&#10;支付宝\"></textarea>\n    <div class=\"find-actions\"><button class=\"btn-primary\" id=\"findGo\">识别并对照台账</button><span class=\"find-sub\" id=\"findBusy\"></span><span class=\"grow\"></span><span class=\"find-sub\">Ctrl+Enter 直接查</span></div>\n    <div class=\"form-err\" id=\"findErr\"></div>\n    <div id=\"findOut\" class=\"find-out\"></div>\n  </div>\n</div>\n\n<!-- 高级筛选 · 未结算账龄 -->\n<div class=\"mask\" id=\"agMask\">\n  <div class=\"modal find-modal ag-modal\">\n    <div class=\"find-head\"><h2>📆 高级筛选 · 未结算账龄</h2><button class=\"btn-ghost find-x\" id=\"agClose\" title=\"关闭（Esc）\">✕</button></div>\n    <div class=\"hint\">等待天数默认<b>从接单日算到今天</b>（切「按完单日」则从完单日算）。这是只读报表：不改任何数据，也不动现有的分类和 KPI 口径。</div>\n    <div class=\"ag-form\">\n      <div class=\"ag-row\">\n        <label>时间口径<select id=\"agField\"><option value=\"date\">按接单日</option><option value=\"doneDate\">按完单日</option></select></label>\n        <label>起<input type=\"date\" id=\"agFrom\"></label>\n        <label>止<input type=\"date\" id=\"agTo\"></label>\n        <span class=\"ag-quick\"><button class=\"btn-mini\" data-ag=\"7\">近 7 天</button><button class=\"btn-mini\" data-ag=\"30\">近 30 天</button><button class=\"btn-mini\" data-ag=\"90\">近 90 天</button><button class=\"btn-mini\" data-ag=\"month\">本月</button><button class=\"btn-mini\" data-ag=\"lastmonth\">上月</button><button class=\"btn-mini\" data-ag=\"all\">不限</button></span>\n      </div>\n      <div class=\"ag-row\">\n        <label class=\"ag-wide\">分类（可多选）<span id=\"agStatus\" class=\"ag-chk\"></span></label>\n        <label>等待≥<input type=\"number\" id=\"agMinDays\" min=\"0\" max=\"3650\" step=\"1\" placeholder=\"0\">天</label>\n        <label>分单<select id=\"agSplit\"><option value=\"all\">全部</option><option value=\"yes\">只看已分单</option><option value=\"no\">只看未分单</option></select></label>\n        <label>关键词<input type=\"search\" id=\"agKw\" placeholder=\"订单编号 / 备注\"></label>\n        <button class=\"btn-primary\" id=\"agGo\">查询</button>\n        <span class=\"find-sub\" id=\"agBusy\"></span>\n      </div>\n      <div class=\"form-err\" id=\"agErr\"></div>\n    </div>\n    <div id=\"agOut\" class=\"find-out\"></div>\n  </div>\n</div>\n\n<!-- 二次核验专区 -->\n<div class=\"mask\" id=\"reviewMask\">\n  <div class=\"modal find-modal\">\n    <div class=\"find-head\"><h2>🔎 二次核验专区</h2><button class=\"btn-ghost find-x\" id=\"reviewClose\" title=\"关闭（Esc）\">✕</button></div>\n    <div class=\"hint\">这里放的是逐单对账时你按下「稍后核验」的那几笔 —— 金额对不上、单号在台账有多行、或台账根本没这个号。<b>它不是订单的分类</b>，不影响「待结算 / 已结算」的统计口径，处理完点「清掉标记」就消失。</div>\n    <div class=\"find-actions\"><button class=\"btn-primary\" id=\"reviewGo\">▶ 逐单过这批</button><span class=\"grow\"></span><button class=\"btn-ghost\" id=\"reviewRefresh\">刷新</button><span class=\"find-sub\" id=\"reviewBusy\"></span></div>\n    <div class=\"form-err\" id=\"reviewErr\"></div>\n    <div id=\"reviewOut\" class=\"find-out\"></div>\n  </div>\n</div>\n\n<!-- 逐单对账卡片 -->\n<div class=\"mask\" id=\"reconMask\">\n  <div class=\"modal recon-modal\">\n    <div class=\"recon-bar\">\n      <button class=\"btn-ghost\" id=\"reconBack\">← 返回账单列表</button>\n      <b class=\"recon-prog\" id=\"reconProg\"></b>\n      <span class=\"grow\"></span>\n      <span class=\"find-sub\">Y 已结算 · N 还没结算 · S 稍后核验/已核验 · 空格 跳过 · ← 上一张 · Esc 返回</span>\n    </div>\n    <div class=\"recon-track\"><i id=\"reconFill\"></i></div>\n    <div id=\"reconCard\"></div>\n    <div class=\"recon-actions\" id=\"reconActions\"></div>\n  </div>\n</div>\n\n<!-- 新增/编辑弹窗 -->\n<div class=\"mask\" id=\"mask\">\n  <div class=\"modal\">\n    <h2 id=\"modalTitle\">新增订单</h2>\n    <div class=\"form-grid\">\n      <div class=\"field\"><label>接单日期 *</label><input type=\"date\" id=\"mDate\"></div>\n      <div class=\"field\"><label>订单编号 *</label><input type=\"text\" id=\"mOrderNo\" placeholder=\"如 DD20260907-01\"></div>\n      <div class=\"field\"><label>订单金额（元）*</label><input type=\"number\" id=\"mAmount\" min=\"0\" step=\"0.01\" placeholder=\"如 850\"></div>\n      <div class=\"field\"><label>分成比例（%）*</label><input type=\"number\" id=\"mShare\" min=\"0\" max=\"100\" step=\"0.1\" placeholder=\"如 70\"></div>\n      <div class=\"field full\"><label>分类（订单进度）*</label><select id=\"mStatus\"></select></div>\n      <div class=\"field full\" id=\"doneDateField\">\n        <label>完单日期</label>\n        <input type=\"date\" id=\"mDoneDate\">\n        <span class=\"tip\">进度为「待结算 / 已结算」时必填，默认今天；改回进行中会自动清空</span>\n      </div>\n      <div class=\"field full\"><label>备注</label><textarea id=\"mNote\" placeholder=\"客户、内容类型、交接情况…（可留空）\"></textarea></div>\n    </div>\n    <div class=\"form-err\" id=\"formErr\"></div>\n    <div class=\"modal-actions\">\n      <button class=\"btn-ghost\" id=\"btnCancel\">取消</button>\n      <button class=\"btn-primary\" id=\"btnSave\">保存</button>\n    </div>\n  </div>\n</div>\n\n";

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
  // 【v26.66】批量改分成：勾选集合、本页行、服务端下发的新单默认比例
  const RATE_SEL = new Set();
  let PAGE_ROWS = [];
  let DEFAULT_RATE = 45;
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
      const wasRemote = USE_REMOTE;
      USE_REMOTE = false;
      try { orders = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e2) { orders = []; }
      // 【v26.71】降级要喊出来：接口一超时/一报 500，台账就会整表换成「本浏览器暂存」的数据，
      // 而页面长相完全没变 —— 只有角落里一行小字。管理员很容易把这份本地空表当成云端账本，
      // 或是在上面继续录入（录入内容只进 localStorage，永远不会到账本里）。
      // 只在「从云端模式掉下来」这一刻提示一次，避免每 6 秒轮询都弹一条。
      if (wasRemote !== false) {
        cpyToast('已连不上服务器，台账切为本地暂存模式：当前显示的不是云端账本，此处的改动也不会入账');
      }
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

  /* ================= 左侧栏：快捷录入（默认比例走服务端配置，见 /api/orders/share-default） ================= */
  async function quickSave() {
    const orderNo = shDoc.getElementById('qkNo').value.trim();
    const amount = parseFloat(shDoc.getElementById('qkAmt').value);
    // 原先是 `|| 40`：清空比例框就悄悄按 40 入账，且 5000、-3 这类值也能提交，
    // 台账与看板收入随之整体虚高/为负。现在回落到服务端配置的默认值并校验区间。
    const raw = parseFloat(shDoc.getElementById('qkRate').value);
    const rate = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : DEFAULT_RATE;
    if (!orderNo) { alert('请填订单编号'); return; }
    if (!(amount > 0)) { alert('请填正确的金额'); return; }
    if (!Number.isFinite(raw) || raw <= 0 || raw > 100) { alert('分成比例须为 1-100，已按当前默认 ' + DEFAULT_RATE + '% 录入'); }
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
    const settledList = scope.filter(o => stLabel(o.status) === '已结算');
    const settledShare = settledList.reduce((s, o) => s + effShare(o), 0);
    // 【v26.72】预计总收入 = 还没结算掉的这部分分成，不含已结算。
    // 原来这里是 scope 全量求和：已到账的钱也被算进「预计」里，于是这张卡既不是「还没到手的钱」
    // 也不是「历史总收入」，跟旁边那张「已结算（我的分成）」相加会重复计算一次。
    // 现在的口径是自洽的：区间内全部订单分成 = 预计总收入 + 已结算分成。
    const unsettledList = scope.filter(o => stLabel(o.status) !== '已结算');
    const totalShare = unsettledList.reduce((s, o) => s + effShare(o), 0);
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
    shDoc.getElementById('subCount').textContent = unsettledList.length + ' 单未结算'
      + (settledList.length ? '（已结算 ' + settledList.length + ' 单不计入）' : '')
      + (dispatchCnt ? ' · 其中已分单 ' + dispatchCnt + ' 单（收入按实际结算口径：分成−报酬）' : '');
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
      PAGE_ROWS = rows.map(o => o._id);
      tbody.innerHTML = rows.map(o => `
        <tr>
          <td><input type="checkbox" data-rck="${o._id}" ${RATE_SEL.has(String(o._id)) ? 'checked' : ''} title="勾选后可批量改分成"></td>
          <td>${o.date || ''}</td>
          <td><b class="cpy" data-copy="${esc(o.orderNo)}" title="点击复制单号">${esc(o.orderNo)}</b></td>
          <td class="num">${fmt(o.amount)}</td>
          <td class="num">${o.shareRate}%</td>
          <td class="num" style="color:var(--green);font-weight:600">${fmt(r2(share(o)))}</td>
          <td><span class="tag ${stLabel(o.status)}">${stLabel(o.status)}</span>${inReview(o._id, o.orderNo) ? '<span class="tag 需复核" title="在二次核验专区里，还没处理">需复核</span>' : ''}</td>
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
        <td></td>
        <td colspan="2">合计 ${view.length} 单（全部页）</td>
        <td class="num">${fmt(r2(vTake))}</td>
        <td class="num">—</td>
        <td class="num" style="color:var(--green)">${fmt(r2(vShare))}</td>
        <td colspan="5"></td>
      </tr>`;
      renderPager(view.length, page, totalPages);
    }

    syncRateHeader();
    renderDailyChart(scope, P);
    renderLineChart(scope, P);
    renderCalendar(scope, P);
    renderStatusChart(view.length ? view : scope);
    renderTodo();
    renderSidebar();
  }

  /* ================= 【v26.66】批量修改分成比例 ================= */
  const unsettled = o => stLabel(o.status) !== '已结算';
  // 本页全选框的状态跟随渲染结果（翻页/筛选后勾选集合仍保留，但要如实反映本页状态）
  function syncRateHeader() {
    const box = shDoc.getElementById('ckAll');
    if (!box) return;
    const onPage = PAGE_ROWS.filter(id => RATE_SEL.has(String(id)));
    box.checked = PAGE_ROWS.length > 0 && onPage.length === PAGE_ROWS.length;
    box.indeterminate = onPage.length > 0 && onPage.length < PAGE_ROWS.length;
  }

  // 本次要改的目标：勾选的那些，或全部未结算订单
  function rateTargets(mode) {
    if (mode === 'all') return orders.filter(unsettled);
    return orders.filter(o => RATE_SEL.has(String(o._id)) && unsettled(o));
  }

  // 预览必须由服务端按真实 filter 计算：本地 orders 只是当前页，
  // 用当前页的条数去确认「全部未结算」的改动，金额和条数都会严重偏小。
  let RATE_PREVIEW = null;
  let RATE_PREVIEW_TIMER = null;
  let RATE_PREVIEW_SEQ = 0;

  async function fetchRatePreview(mode, to) {
    const body = { shareRate: to, dryRun: true };
    if (mode === 'all') body.all = true;
    else {
      const list = rateTargets(mode);
      if (!list.length) return null;
      body.ids = list.map(o => o._id);
    }
    const r = await fetch('/api/orders/share-batch', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AH()), body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ ok: false, error: '响应异常' }));
    if (!r.ok || !j.ok) throw new Error(j.error || ('请求失败 ' + r.status));
    return j;
  }

  function rateFallbackStats(list, to) {
    const before = list.reduce((s, o) => s + share(o), 0);
    const after = list.reduce((s, o) => s + o.amount * to / 100, 0);
    return {
      willUpdate: list.length, skippedUnchanged: 0, estimated: true,
      amountTotal: r2(list.reduce((s, o) => s + (o.amount || 0), 0)),
      shareBefore: r2(before), shareAfter: r2(after), delta: r2(after - before),
    };
  }

  function paintRatePreview(pv, mode, to) {
    const box = shDoc.getElementById('ratePreview');
    const btn = shDoc.getElementById('rateSave');
    if (!pv) { box.textContent = '没有匹配到要修改的订单（已结算的订单默认不动，需要连它们一起改请先改状态或逐条编辑）。'; btn.disabled = true; return; }
    if (pv.overLimit) {
      box.innerHTML = `符合条件的有 <b>${pv.willUpdate}</b> 条，超过单次 5000 条上限，请分批操作。`;
      btn.disabled = true; return;
    }
    if (!pv.willUpdate && !pv.unavailable) { box.textContent = `这些订单的分成比例已经都是 ${to}%，本次不会有改动。`; btn.disabled = true; return; }
    if (pv.unavailable) {
      box.innerHTML = '预览请求没成功，暂时给不出准确条数。'
        + (mode === 'all' ? '<br><span style="color:#b0642c">本次仍会按「数据库里全部未结算订单」执行，条数与金额以提交结果为准 —— 请确认你接受这个范围。</span>' : '');
      btn.disabled = false; return;
    }
    const bits = [];
    if (Array.isArray(pv.byRate) && pv.byRate.length) {
      bits.push('现状：' + pv.byRate.map(g => `${g.from}% 有 ${g.n} 单`).join('、'));
    }
    box.innerHTML = `将修改 <b>${pv.willUpdate}</b> 条订单${pv.matched && pv.skippedUnchanged ? `（另 ${pv.skippedUnchanged} 条已是 ${to}%，不动）` : ''}`
      + `，涉及接单金额 ${fmt(pv.amountTotal)} 元<br>`
      + `你的分成收入 ${fmt(pv.shareBefore)} 元 → <b>${fmt(pv.shareAfter)} 元</b>`
      + `（<b>${pv.delta >= 0 ? '多 ' + fmt(pv.delta) : '少 ' + fmt(Math.abs(pv.delta))} 元</b>）`
      + (bits.length ? `<br><span style="color:#64748b">${bits.join(' ')}</span>` : '')
      + (pv.estimated ? '<br><span style="color:#b0642c">预览服务暂时没应答，上面按当前页估算，实际条数以提交结果为准。</span>' : '')
      + (mode === 'all' ? '<br><span style="color:#b0642c">范围是「全部未结算订单」（已按数据库核对），不是当前筛选出来的这些。</span>' : '');
    btn.disabled = false;
  }

  function renderRatePreview() {
    const mode = shDoc.getElementById('rateScope').value;
    const to = parseFloat(shDoc.getElementById('rateNew').value);
    const box = shDoc.getElementById('ratePreview');
    const seq = ++RATE_PREVIEW_SEQ;
    RATE_PREVIEW = null;
    clearTimeout(RATE_PREVIEW_TIMER);
    if (!(to > 0 && to <= 100)) { box.textContent = '请先填一个 1~100 之间的比例。'; shDoc.getElementById('rateSave').disabled = true; return; }
    const list = rateTargets(mode);
    if (!list.length) { paintRatePreview(null, mode, to); return; }
    box.textContent = '正在按数据库核对影响范围…';
    shDoc.getElementById('rateSave').disabled = true;
    RATE_PREVIEW_TIMER = setTimeout(() => {
      fetchRatePreview(mode, to)
        .then(pv => { if (seq === RATE_PREVIEW_SEQ) { RATE_PREVIEW = pv; paintRatePreview(pv, mode, to); } })
        .catch(() => {
          if (seq !== RATE_PREVIEW_SEQ) return;
          // 「全部未结算」不能退回按当前页估算（那正是最危险的错觉），只说"取不到准确数字"；
          // 勾选模式本来就是把这批 id 交给服务端，退回本地估算是同一批数据，可信。
          RATE_PREVIEW = mode === 'all' ? { unavailable: true } : rateFallbackStats(list, to);
          paintRatePreview(RATE_PREVIEW, mode, to);
        });
    }, 280);
  }

  function openRateModal() {
    if (!USE_REMOTE) { cpyToast('本地模式下不能批量改（数据只在本机）'); return; }
    const mode = shDoc.getElementById('rateScope');
    mode.value = RATE_SEL.size ? 'sel' : 'all';
    shDoc.getElementById('rateNew').value = DEFAULT_RATE;
    shDoc.getElementById('rateAlsoDefault').checked = false;
    shDoc.getElementById('rateErr').textContent = '';
    shDoc.getElementById('rateMask').classList.add('show');
    renderRatePreview();
  }
  function closeRateModal() { shDoc.getElementById('rateMask').classList.remove('show'); }

  async function postShareBatch(body) {
    const r = await fetch('/api/orders/share-batch', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AH()), body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ ok: false, error: '响应异常' }));
    if (!r.ok || !j.ok) throw new Error(j.error || ('请求失败 ' + r.status));
    return j;
  }

  async function submitRateBatch() {
    const err = shDoc.getElementById('rateErr');
    const btn = shDoc.getElementById('rateSave');
    const mode = shDoc.getElementById('rateScope').value;
    const to = parseFloat(shDoc.getElementById('rateNew').value);
    const list = rateTargets(mode);
    err.textContent = '';
    if (!(to > 0 && to <= 100)) { err.textContent = '分成比例须为 1-100'; return; }
    if (!list.length) { err.textContent = '没有要修改的订单'; return; }
    const pv = RATE_PREVIEW || {};
    // RATE_PREVIEW 为 null 只可能是「预览还在路上」（失败分支也会写一个值进来）
    if (!RATE_PREVIEW) { err.textContent = '正在按数据库核对影响范围，稍等一下再提交'; return; }
    if (pv.overLimit) { err.textContent = '超过单次 5000 条上限，请分批操作'; return; }
    // 这一步会改写历史台账的收入口径，必须二次确认并写清影响金额
    // 确认框里的条数/金额一律用服务端预览：本地只有当前页，全量模式下会小一个数量级
    const tip = pv.unavailable
      ? `确认把分成比例改为 ${to}%？\n预览未成功，${mode === 'all' ? '本次将按数据库里全部未结算订单执行，条数与金额以提交结果为准' : '将按勾选的 ' + list.length + ' 条执行'}。\n已结算订单不在本次范围内。`
      : `确认把 ${pv.willUpdate || list.length} 条订单的分成比例改为 ${to}%？\n你的分成收入将变化 ${
        fmt(r2((pv.shareAfter != null ? pv.shareAfter - pv.shareBefore : list.reduce((s, o) => s + o.amount * to / 100 - share(o), 0))))} 元。\n已结算订单不在本次范围内。`;
    if (!confirm(tip)) return;
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const j = await postShareBatch({ ids: mode === 'all' ? undefined : list.map(o => o._id), all: mode === 'all', shareRate: to });
      if (shDoc.getElementById('rateAlsoDefault').checked) {
        const d = await fetch('/api/orders/share-default', {
          method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AH()), body: JSON.stringify({ shareRate: to }),
        });
        const dj = await d.json().catch(() => ({}));
        if (dj && dj.ok) applyDefaultRate(dj.shareRate);
        else err.textContent = '批量已改，但默认比例设置失败：' + ((dj && dj.error) || d.status);
      }
      const ids = new Set(list.map(o => String(o._id)));
      orders = orders.map(o => ids.has(String(o._id)) ? Object.assign({}, o, { shareRate: to }) : o);
      RATE_SEL.clear();
      RATE_PREVIEW = null;
      const got = Number(j.amountDelta);
      cpyToast((j.message || ('已修改 ' + j.updated + ' 条'))
        + (Number.isFinite(got) ? `，你的分成收入${got >= 0 ? '多 ' : '少 '}${fmt(Math.abs(got))} 元` : ''));
      closeRateModal();
      render();
      loadOrders();   // 再与服务端核对一遍，避免本地推算与库内不一致
    } catch (e) {
      err.textContent = '修改失败：' + (e.message || e);
    } finally {
      btn.disabled = false; btn.textContent = '确认修改';
    }
  }

  // 默认比例落到位：快捷录入与新增表单都跟着走，不再各处写死数字
  function applyDefaultRate(v) {
    const n = parseFloat(v);
    if (!(n > 0 && n <= 100)) return;
    DEFAULT_RATE = n;
    const hint = shDoc.getElementById('qkRateHint'); if (hint) hint.textContent = n;
    const qk = shDoc.getElementById('qkRate'); if (qk && !qk.value.trim()) qk.value = n;
  }
  async function loadShareDefault() {
    if (!USE_REMOTE) return;
    try {
      const r = await fetch('/api/orders/share-default', { headers: AH() });
      const j = await r.json().catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
      if (j && j.ok) applyDefaultRate(j.shareRate);
    } catch (e) { /* 拿不到就用代码默认 45，不打扰 */ }
  }

  /* ================= 【v26.81】账单粘贴找单（只查询，不改状态） ================= */
  let FIND_LAST = null;   // 最近一次识别结果，逐单对账用它当数据源
  // 提取和比对都在 /api/orders/lookup 里做：页面只负责粘贴和展示。
  // 这样只有一条匹配代码，不会出现「前端显示能对上、后端却按另一套口径找」；
  // 也顺带绕开明细表最多加载 500 条的限制 —— 老月份的单照样能查出来。
  function openFindModal() {
    $('findErr').textContent = '';
    $('findMask').classList.add('show');
    setTimeout(() => $('findText').focus(), 30);
  }
  function closeFindModal() { $('findMask').classList.remove('show'); }

  function findSummary(j) {
    // 状态相关的数字一律从 cards 现算，不取服务端一次性算好的 counts：
    // 逐单对账会就地改卡片里的状态，用服务端快照会出现「行上已结算、汇总还写未结算」。
    // multi / noPay 是结构性计数（跟改状态无关），可以继续用服务端的。
    const cards = j.cards || [];
    const rows = cards.flatMap(c => c.rows);
    const hit = cards.filter(c => c.rows.length);
    return `<div class="find-sum">识别 <b>${j.extracted}</b> 个单号 → 台账命中 <b>${hit.length}</b> 笔 / <b>${rows.length}</b> 行`
      + `<span class="find-sub">（未结算 ${rows.filter(r => r.status !== '已结算').length} · 已结算 ${rows.filter(r => r.status === '已结算').length}）</span>`
      + `｜未命中 <b>${cards.length - hit.length}</b>`
      + (j.counts.multi ? `<span class="find-sub">｜${j.counts.multi} 笔撞上重复单号</span>` : '')
      + (j.counts.noPay ? `<span class="find-sub">｜${j.counts.noPay} 笔没识别到金额</span>` : '')
      + ((j.noteHits || []).length ? `<span class="find-sub">｜备注里还出现 ${j.noteHits.length} 处</span>` : '')
      + (j.noteProbeCapped ? '<span class="find-sub">（未命中超 50 个，备注兜底只查了前 50 个）</span>' : '')
      + '</div>';
  }

  function findRow(r, c) {
    // 「定位」需要这单已在页面加载的数据里，否则只给提示，不做静默失败
    const canGo = orders.some(x => String(x._id) === String(r._id));
    const diff = c.pay == null ? null : Math.round((c.pay - r.share) * 100) / 100;
    return `<tr>
      <td>${esc(r.date)}</td>
      <td><b class="cpy" data-copy="${esc(r.orderNo)}" title="点击复制单号">${esc(r.orderNo)}</b></td>
      <td class="num">${c.pay == null ? '—' : fmt(r2(c.pay))}</td>
      <td class="num">${fmt(r2(r.amount))}</td>
      <td class="num">${fmt(r2(r.share))}</td>
      <td class="num ${diff == null ? '' : diff === 0 ? 'd-eq' : 'd-ne'}">${diff == null ? '—' : diff === 0 ? '一致 ✓' : (diff > 0 ? '+' : '−') + fmt(Math.abs(diff))}</td>
      <td><span class="tag ${esc(stLabel(r.status))}">${esc(stLabel(r.status))}</span></td>
      <td class="note-cell" title="${esc(r.note)}">${esc(r.note)}</td>
      <td>${canGo
        ? `<button class="btn-mini" onclick="this.getRootNode().host.__ledger.locateOrder('${esc(String(r._id))}')">定位</button><button class="btn-mini" onclick="this.getRootNode().host.__ledger.openModal('${esc(String(r._id))}')">编辑</button>`
        : '<span class="find-sub" title="这单不在页面已加载的明细里（明细最多加载 500 条），按单号搜索即可">未加载</span>'}</td>
    </tr>`;
  }

  function findMissRow(c) {
    return `<tr class="rc-miss">
      <td>${c.payTime ? esc(c.payTime.slice(0, 10)) : '—'}</td>
      <td><b class="cpy" data-copy="${esc(c.orderNo)}" title="点击复制单号">${esc(c.orderNo)}</b></td>
      <td class="num">${c.pay == null ? '—' : fmt(r2(c.pay))}</td>
      <td class="num" colspan="4" style="color:var(--sub)">台账「订单编号」列没有这个号</td>
      <td class="find-sub">${esc(c.serial ? '流水 …' + c.serial.slice(-6) : '')}</td>
    </tr>`;
  }

  function renderFindResult(j) {
    const cards = j.cards || [], note = j.noteHits || [];
    const rowCards = cards.filter(c => c.rows.length);
    const missCards = cards.filter(c => !c.rows.length);
    const reconN = rowCards.reduce((s, c) => s + c.rows.filter(r => r.status !== '已结算').length, 0);
    $('findOut').innerHTML = findSummary(j)
      + `<div class="find-cta"><button class="btn-primary" id="reconGo" ${rowCards.length ? '' : 'disabled'}>▶ 逐单对账（${reconN} 单未结算）</button>`
      + '<span class="find-sub">一张卡对一笔：账单金额和后台金额并排，点「已结算 / 还没结算」就地改状态，自动下一张</span></div>'
      + (rowCards.length
        ? `<div class="table-card find-table"><table><thead><tr><th>接单日</th><th>订单编号</th><th class="num">账单金额</th><th class="num">订单金额</th><th class="num">后台分成</th><th class="num">差</th><th>当前分类</th><th>备注</th><th>操作</th></tr></thead><tbody>`
          + rowCards.map(c => c.rows.map(r => findRow(r, c)).join('')).join('')
          + (missCards.length ? missCards.map(findMissRow).join('') : '')
          + '</tbody></table></div>'
        : '<div class="q-empty">台账的「订单编号」列里没有这些号。可能是还没录入，或账单里的号不是台账用的那个号。</div>')
      + (missCards.length && rowCards.length
        ? `<details class="find-fold"><summary>台账没命中的单号（${missCards.length}）· 展开核对是不是复制漏了</summary><div class="find-miss">${missCards.map(c => esc(c.orderNo)).join(' · ')}</div></details>`
        : '')
      + (note.length
        ? `<details class="find-fold"><summary>备注里出现这些号的行（${note.length}）· 不是订单编号列，要不要算你自己判断</summary>`
          + note.map(n => `<div class="find-note-row">账单号 ${esc(n.from)} → 台账 ${esc(n.orderNo)}（${esc(n.date)} · ${esc(stLabel(n.status))}）${n.note ? ' · 备注：' + esc(n.note.slice(0, 30)) : ''}</div>`).join('')
          + '</details>'
        : '')
      + (j.truncated ? '<div class="find-warn">命中数量已达上限，结果被截断，请分批改。</div>' : '')
      + '<div class="hint">这个列表本身不改数据；改状态要么点上面的「逐单对账」，要么用行上的「编辑」。</div>';
    $('reconGo').onclick = startRecon;
  }

  async function runFind() {
    const text = $('findText').value;
    const err = $('findErr'), busy = $('findBusy'), btn = $('findGo');
    err.textContent = '';
    if (!text.trim()) { err.textContent = '先把账单文本粘贴进来'; return; }
    btn.disabled = true; busy.textContent = '对照中…';
    try {
      const r = await fetch('/api/orders/lookup', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AH()),
        body: JSON.stringify({ text }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: '响应异常' }));
      if (!r.ok || !j.ok) throw new Error(j.error || ('请求失败 ' + r.status));
      FIND_LAST = j;
      renderFindResult(j);
    } catch (e) {
      $('findOut').innerHTML = '';
      err.textContent = '查单失败：' + (e.message || e);
    } finally {
      btn.disabled = false; busy.textContent = '';
    }
  }

  function locateOrder(id) {
    const o = orders.find(x => String(x._id) === String(id));
    closeFindModal();
    if (!o) return;
    // 不复用 jumpToOrder：它按单号前 6 位筛、高亮第一个含该号的行。
    // 台账里存在重复单号（orderNo 没有唯一约束），前 6 位还会顺带命中别家平台的相邻号，
    // 于是「定位」可能跳到另一行。这里按完整单号筛、按 _id 定位到那一行。
    periodType = 'year';
    $('fPeriodType').value = 'year';
    buildPeriodInputs();
    $('yYear').value = (o.date || localDate()).slice(0, 4);
    $('fKeyword').value = o.orderNo || '';
    page = 1;
    render();
    setTimeout(() => {
      $('tableCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      const ck = shDoc.querySelector('#tbody [data-rck="' + id + '"]');
      const tr = ck && ck.closest('tr');
      if (tr) { tr.classList.add('hl'); setTimeout(() => tr.classList.remove('hl'), 2600); }
    }, 60);
  }

  /* ================= 【v26.82】逐单对账卡片 ================= */
  // 一张卡 = 一笔账单 × 台账一行。「已结算 / 还没结算」走的是编辑弹窗同一条
  // PUT /api/orders/:id（saveOrder），没有另开写入口径；一轮走完再 loadOrders() 回服务端核对。
  // 已经是「已结算」的行不进卡（没得可确认），账单里没命中的单号照样进卡，避免静默跳过。
  const RECON = { list: [], i: 0, log: [], busy: false, origin: 'find', cleared: 0 };

  function queueFromCards(cards, keepSettled) {
    const out = [];
    (cards || []).forEach(c => {
      if (!c.rows.length) { out.push({ c, r: null, key: c.key || null }); return; }
      c.rows.filter(r => keepSettled || r.status !== '已结算').forEach(r => out.push({ c, r, key: c.key || null }));
    });
    return out;
  }

  function startRecon() {
    if (!FIND_LAST) return;
    RECON.origin = 'find';
    RECON.list = queueFromCards(FIND_LAST.cards, false);
    RECON.i = 0; RECON.log = []; RECON.cleared = 0;
    $('reconMask').classList.add('show');
    paintRecon();
  }

  // 专区里的「逐单过这批」：先按单号回库里的当前状态（标记可能是几天前打的），
  // 再喂给同一套卡片引擎 —— 不分叉第二套对账 UI
  async function startReviewRecon() {
    if (!REVIEW.items.length) return;
    $('reviewErr').textContent = '';
    $('reviewBusy').textContent = '按台账现值刷新中…';
    try {
      const cards = await reviewCards();
      RECON.origin = 'review';
      RECON.list = queueFromCards(cards, true);
      RECON.i = 0; RECON.log = []; RECON.cleared = 0;
      $('reviewMask').classList.remove('show');
      $('reconMask').classList.add('show');
      paintRecon();
    } catch (e) {
      $('reviewErr').textContent = '打不开：' + (e.message || e);
    } finally {
      $('reviewBusy').textContent = '';
    }
  }

  function closeRecon() {
    $('reconMask').classList.remove('show');
    const n = RECON.log.length;
    if (RECON.origin === 'review') {
      // 从专区进来的，过完回专区（不是回粘贴页），并带上最新标记状态
      loadReview().then(() => { renderReview(); openReviewModal(); });
      if (n) { loadOrders(); cpyToast('本轮改了 ' + n + ' 单，已刷新台账'); }
      return;
    }
    if (!n) return;
    renderFindResult(FIND_LAST);
    loadOrders();
    cpyToast('本轮改了 ' + n + ' 单，已刷新台账');
  }

  function reconAmt(c, r) {
    if (!r || c.pay == null) return null;
    return Math.round((c.pay - r.share) * 100) / 100;
  }

  function reconDoneHtml() {
    const log = RECON.log;
    const set = log.filter(x => x.to === '已结算');
    const back = log.length - set.length;
    const amt = set.reduce((s, x) => s + x.share, 0);
    return `<div class="rc done">
      <h3>这一轮过完了</h3>
      <div class="rc-sum">共 ${RECON.list.length} 张卡，改动 <b>${log.length}</b> 单：置为已结算 <b>${set.length}</b>（后台分成合计 ¥${fmt(r2(amt))}）· 改回未结算 <b>${back}</b>。</div>
      ${log.length
        ? `<details class="find-fold" open><summary>改动明细（${log.length}）</summary>`
          + log.map(x => `<div class="find-note-row">${esc(x.orderNo)} · ${esc(x.date)} · ${esc(stLabel(x.from))} → <b>${esc(stLabel(x.to))}</b> · 后台分成 ¥${fmt(r2(x.share))}</div>`).join('')
          + '</details>'
        : '<div class="q-empty">一单都没改。</div>'}
      <div class="rc-sub">改错了不需要找回去：返回列表后在那一行点「编辑」就能改回来。</div>
      <button class="btn-primary" onclick="this.getRootNode().host.__ledger.closeRecon()">返回账单列表</button>
    </div>`;
  }

  function paintRecon() {
    const fill = $('reconFill');
    if (RECON.i >= RECON.list.length) {
      $('reconProg').textContent = RECON.list.length ? '全部过完' : '没有要确认的卡';
      fill.style.width = '100%';
      $('reconCard').innerHTML = reconDoneHtml();
      $('reconActions').innerHTML = '';
      return;
    }
    const it = RECON.list[RECON.i], c = it.c, r = it.r;
    const diff = reconAmt(c, r);
    $('reconProg').textContent = `第 ${RECON.i + 1} / ${RECON.list.length} 张`;
    fill.style.width = Math.round(RECON.i / RECON.list.length * 100) + '%';
    $('reconCard').innerHTML = `<div class="rc">
      <div class="rc-top">
        <span class="rc-bill">这笔账单</span>
        <b class="cpy rc-no" data-copy="${esc(c.orderNo)}" title="点击复制单号">${esc(c.orderNo)}</b>
        <span class="find-sub">${c.payTime ? esc(c.payTime) : '没识别到时间'}${c.serial ? ' · 流水 …' + esc(c.serial.slice(-6)) : ''}</span>
      </div>
      <div class="rc-grid">
        <div class="rc-side">
          <h4>支付宝这笔付了</h4>
          <div class="rc-big">${c.pay == null ? '?' : '¥ ' + fmt(r2(c.pay))}</div>
          ${c.pay == null
            ? '<div class="rc-sub warn">这行没识别到金额 —— 粘贴格式和预期不一样，金额以你自己看的为准</div>'
            : (c.payExtra.length ? `<div class="rc-sub">同一行还有一个 ${fmt(r2(c.payExtra[0]))}，看着像批量合计或余额，不参与判断</div>` : '')}
        </div>
        <div class="rc-side">
          <h4>台账这一行记的是</h4>
          ${r
            ? `<div class="rc-big green">¥ ${fmt(r2(r.share))}</div>
               <div class="rc-sub">订单金额 ¥${fmt(r2(r.amount))} · 分成 ${r.shareRate}% · 接单 ${esc(r.date)} · 完单 ${esc(r.doneDate || '—')}</div>
               <div class="rc-sub">当前分类：<span class="tag ${esc(stLabel(r.status))}">${esc(stLabel(r.status))}</span>${r.note ? ' · 备注 ' + esc(r.note.slice(0, 30)) : ''}</div>`
            : '<div class="rc-big none">台账没有这个单号</div><div class="rc-sub">可能还没录入，或者账单里的号不是台账用的那个号。跳过它，回头自己核对。</div>'}
        </div>
      </div>
      ${r ? `<div class="rc-diff ${diff == null ? '' : diff === 0 ? 'eq' : 'ne'}">${diff == null
          ? '没取到账单金额，比不了差额'
          : diff === 0 ? '金额一致 ✓' : '差 ' + (diff > 0 ? '+' : '−') + fmt(Math.abs(diff)) + ' 元 —— 只提醒，不拦你改'}</div>` : ''}
      ${r && c.rows.length > 1 ? `<div class="rc-warn">这个单号在台账有 ${c.rows.length} 行，现在看的是第 ${c.rows.indexOf(r) + 1} 行；不是这一笔就点「跳过」，下一张是另一行。</div>` : ''}
      ${RECON.origin === 'review' ? `<div class="rc-reason">${REASON_TEXT[c.reason] || '当初被你标为待核验'}${c.billNote ? '（' + esc(c.billNote) + '）' : ''}<span class="find-sub"> · 标记于 ${esc(c.billAt || '—')}</span></div>` : ''}
    </div>`;
    // 黄色卡：金额对不上 / 单号在台账多行 / 台账根本没这个号 —— 这种可以「稍后核验」进专区
    const yellow = !r || (diff != null && diff !== 0) || (r && c.rows.length > 1);
    const review = RECON.origin === 'review';
    const lateBtn = review
      ? `<button class="btn-primary" id="rcLate">已核验 · 清掉标记 <kbd>S</kbd></button>`
      : (yellow ? `<button class="btn-ghost" id="rcLate">稍后核验 <kbd>S</kbd></button>` : '');
    $('reconActions').innerHTML = (r
      ? `<button class="btn-primary" id="rcYes">已结算 ✓ <kbd>Y</kbd></button>`
        + `<button class="btn-ghost" id="rcNo">还没结算 ✕ <kbd>N</kbd></button>`
      : '')
      + lateBtn
      + `<button class="btn-ghost" id="rcSkip">${review ? '留着下次 · 不改 <kbd>空格</kbd>' : '跳过 · 不改 <kbd>空格</kbd>'}</button>`;
    const y = $('rcYes'), n = $('rcNo'), late = $('rcLate');
    if (y) y.onclick = () => reconApply('已结算');
    if (n) n.onclick = () => reconApply('待结算');
    if (late) late.onclick = reconLate;
    $('rcSkip').onclick = () => reconNext();
  }

  // 「稍后核验」= 把这一笔存进专区；「已核验·清掉标记」= 从专区摘掉
  async function reconLate() {
    const it = RECON.list[RECON.i];
    if (!it) return;
    const c = it.c, r = it.r;
    try {
      if (RECON.origin === 'review') {
        if (it.key) await clearReview([it.key]);
        render();
      } else {
        const diff = reconAmt(c, r);
        await flagReview([{
          orderNo: c.orderNo, _id: r ? r._id : null,
          reason: !r ? 'miss' : (c.rows.length > 1 ? 'multi' : 'diff'),
          bill: { pay: c.pay, time: c.payTime, serial: c.serial },
          note: diff == null ? '' : '账单 ' + c.pay + ' / 后台分成 ' + r.share + ' 差 ' + (diff > 0 ? '+' : '') + diff,
          at: localDate() + ' ' + new Date().toTimeString().slice(0, 8),
        }]);
        render();   // 角标要立刻出现在明细表上：纯标记不改状态，不会走 loadOrders 那次重画
      }
      reconNext();
    } catch (e) {
      cpyToast('标记没存上：' + (e.message || e));   // 留在这张卡，不假装成功
    }
  }

  async function reconApply(to) {
    const it = RECON.list[RECON.i];
    if (!it || !it.r || RECON.busy) return;
    const r = it.r;
    if (stLabel(r.status) === to) { reconNext(); return; }
    RECON.busy = true;
    ['rcYes', 'rcNo'].forEach(id => { const b = $(id); if (b) b.disabled = true; });
    try {
      const doc = { date: r.date, orderNo: r.orderNo, amount: r.amount, shareRate: r.shareRate, status: to, doneDate: r.doneDate, note: r.note };
      await saveOrder(doc, r._id);
      const o = orders.find(x => String(x._id) === String(r._id));
      if (o) Object.assign(o, doc);
      RECON.log.push({ orderNo: r.orderNo, date: r.date, from: r.status, to, share: r.share });
      r.status = to;
      // 从专区进来的，改完状态就意味着这笔核验过了，顺手把标记摘掉
      if (it.key) { await clearReview([it.key]); RECON.cleared++; }
      reconNext();
    } catch (e) {
      // 留在这张卡上，把失败说清楚，绝不假装过了
      cpyToast('改状态失败：' + (e.message || e));
    } finally {
      RECON.busy = false;
      ['rcYes', 'rcNo'].forEach(id => { const b = $(id); if (b) b.disabled = false; });
    }
  }

  function reconNext() { RECON.i++; paintRecon(); }
  function reconPrev() { if (RECON.i > 0) { RECON.i--; paintRecon(); } }

  /* ================= 【v26.83】二次核验专区 ================= */
  // 黄色那几笔（金额不符 / 重复单号 / 台账查无此号）先记在这儿，最后统一处理。
  // 它是独立于「分类」的一个标记：不进 KPI、不进分类看板、写手端也看不到。
  const REASON_TEXT = { diff: '账单金额与台账分成不一致', multi: '这个单号在台账有多行', miss: '台账里没有这个单号' };
  const REVIEW = { items: [] };

  async function reviewApi(body) {
    const r = await fetch('/api/orders/review', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AH()), body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ ok: false, error: '响应异常' }));
    if (!r.ok || !j.ok) throw new Error(j.error || ('请求失败 ' + r.status));
    REVIEW.items = j.items || [];
    paintReviewBtn();
    return j;
  }
  const flagReview = items => reviewApi({ op: 'add', items });
  const clearReview = keys => reviewApi({ op: 'clear', keys });

  async function loadReview() {
    try {
      const r = await fetch('/api/orders/review', { headers: AH() });
      const j = await r.json();
      REVIEW.items = j && j.ok && Array.isArray(j.items) ? j.items : [];
    } catch (e) { REVIEW.items = []; }
    paintReviewBtn();
  }

  function paintReviewBtn() {
    const b = $('btnReview');
    if (!b) return;
    const n = REVIEW.items.length;
    b.style.display = n ? '' : 'none';
    b.textContent = '🔎 二次核验' + (n ? '（' + n + '）' : '');
  }

  const reviewKeyOf = (id, orderNo) => (id ? 'o:' + id : 'n:' + orderNo);
  const inReview = (id, orderNo) => REVIEW.items.some(x => x.key === reviewKeyOf(id, orderNo));

  // 专区里的行 = 当初记的账单快照 + 台账现在的值（标记可能是几天前打的，不能拿旧状态去对）
  async function reviewCards() {
    if (!REVIEW.items.length) return [];
    const r = await fetch('/api/orders/lookup', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AH()),
      body: JSON.stringify({ text: REVIEW.items.map(x => x.orderNo).join('\n') }),
    });
    const j = await r.json().catch(() => ({ ok: false, error: '响应异常' }));
    if (!j.ok) throw new Error(j.error || '取不到台账现值');
    const byNo = new Map();
    (j.cards || []).forEach(c => byNo.set(c.orderNo, c));
    return REVIEW.items.map(x => {
      const c = byNo.get(x.orderNo);
      let rows = c ? c.rows.slice() : [];
      if (x._id) rows = rows.filter(o => String(o._id) === String(x._id));
      return {
        orderNo: x.orderNo, pay: x.bill ? x.bill.pay : null, payExtra: [],
        payTime: x.bill ? x.bill.time : null, serial: x.bill ? x.bill.serial : null,
        rows, key: x.key, reason: x.reason, billNote: x.note, billAt: x.at,
      };
    });
  }

  function openReviewModal() { $('reviewErr').textContent = ''; renderReview(); $('reviewMask').classList.add('show'); }
  function closeReviewModal() { $('reviewMask').classList.remove('show'); }

  function renderReview() {
    const items = REVIEW.items;
    if (!items.length) {
      $('reviewOut').innerHTML = '<div class="q-empty">专区是空的。逐单对账时遇到黄色那张卡，点「稍后核验」就会进这里。</div>';
      paintReviewBtn(); return;
    }
    const g = { diff: [], multi: [], miss: [] };
    items.forEach(x => (g[x.reason] || g.diff).push(x));
    $('reviewOut').innerHTML = `<div class="rv-sum">共 <b>${items.length}</b> 笔待核验：金额不符 <b>${g.diff.length}</b> · 重复单号 <b>${g.multi.length}</b> · 台账查无此号 <b>${g.miss.length}</b></div>`
      + Object.keys(g).filter(k => g[k].length).map(k => `<div class="rv-group"><h4>${REASON_TEXT[k]}（${g[k].length}）</h4>
        <div class="table-card find-table"><table><thead><tr><th>订单编号</th><th class="num">账单金额</th><th>账单时间</th><th>标记时备注</th><th>台账现值</th><th>操作</th></tr></thead><tbody>`
        + g[k].map(x => {
          const o = x._id ? orders.find(y => String(y._id) === String(x._id)) : null;
          return `<tr><td><b class="cpy" data-copy="${esc(x.orderNo)}" title="点击复制单号">${esc(x.orderNo)}</b></td>`
            + `<td class="num">${x.bill && x.bill.pay != null ? fmt(r2(x.bill.pay)) : '—'}</td>`
            + `<td class="find-sub">${esc((x.bill && x.bill.time) || '—')}</td>`
            + `<td class="note-cell" title="${esc(x.note)}">${esc(x.note)}</td>`
            + `<td>${o ? `<span class="tag ${esc(stLabel(o.status))}">${esc(stLabel(o.status))}</span>`
              : `<span class="find-sub">${x._id ? '台账里已找不到这行（可能被删）' : '本来就没有对应台账行'}</span>`}</td>`
            + `<td>${o ? `<button class="btn-mini" onclick="this.getRootNode().host.__ledger.locateOrder('${esc(String(x._id))}')">定位</button>` : ''}`
              + `<button class="btn-mini" onclick="this.getRootNode().host.__ledger.clearOneReview('${esc(x.key)}')">清掉标记</button></td></tr>`;
        }).join('')
        + '</tbody></table></div></div>').join('')
      + '<div class="hint">「清掉标记」只删这条核验记录、不动订单状态；「▶ 逐单过这批」会按台账<b>现在的值</b>重新取一遍再一张张过，改完状态自动把标记摘掉。</div>';
    paintReviewBtn();
  }

  function clearOneReview(key) {
    clearReview([key]).then(() => { renderReview(); render(); }).catch(e => { $('reviewErr').textContent = '清不掉：' + (e.message || e); });
  }

  /* ================= 【v26.84】高级筛选 · 未结算账龄 ================= */
  // 报表数字全部来自 /api/orders/aging（服务端全量取数）。不在前端用已加载的明细算，
  // 是因为明细接口有 500 条上限：拿被截断的数据汇总「下次要打多少钱」，金额会静默偏小。
  function buildAgStatus() {
    const box = $('agStatus');
    if (!box || box.children.length) return;
    box.innerHTML = STATUSES.map(s =>
      `<label><input type="checkbox" value="${s}" ${s !== '已结算' ? 'checked' : ''}> ${s}</label>`).join('');
  }

  function openAgModal() {
    buildAgStatus();
    $('agErr').textContent = '';
    if (!$('agFrom').value && !$('agTo').value) agQuick('90');   // 默认看近 90 天，别一进来就全表
    $('agMask').classList.add('show');
    if (!$('agOut').innerHTML) agQuery();
  }
  function closeAgModal() { $('agMask').classList.remove('show'); }

  function agQuick(kind) {
    const pad = n => String(n).padStart(2, '0');
    const fmtD = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const now = new Date();
    if (kind === 'all') { $('agFrom').value = ''; $('agTo').value = ''; return; }
    if (kind === 'month') { $('agFrom').value = fmtD(new Date(now.getFullYear(), now.getMonth(), 1)); $('agTo').value = ''; return; }
    if (kind === 'lastmonth') {
      $('agFrom').value = fmtD(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      $('agTo').value = fmtD(new Date(now.getFullYear(), now.getMonth(), 0));   // 上月最后一天
      return;
    }
    const n = Number(kind);
    if (!Number.isFinite(n) || n <= 0) return;
    $('agFrom').value = fmtD(new Date(Date.now() - n * 86400000));
    $('agTo').value = '';
  }

  async function agQuery() {
    const err = $('agErr'), busy = $('agBusy'), btn = $('agGo');
    err.textContent = '';
    const st = [...$('agStatus').querySelectorAll('input:checked')].map(x => x.value);
    if (!st.length) { err.textContent = '至少要选一个分类'; return; }
    const p = new URLSearchParams({
      field: $('agField').value, status: st.join(','), split: $('agSplit').value,
    });
    if ($('agFrom').value) p.set('from', $('agFrom').value);
    if ($('agTo').value) p.set('to', $('agTo').value);
    if ($('agMinDays').value) p.set('minDays', $('agMinDays').value);
    if ($('agKw').value.trim()) p.set('q', $('agKw').value.trim());
    btn.disabled = true; busy.textContent = '取数中…';
    try {
      const r = await fetch('/api/orders/aging?' + p.toString(), { headers: AH() });
      const j = await r.json().catch(() => ({ ok: false, error: '响应异常' }));
      if (!r.ok || !j.ok) throw new Error(j.error || ('请求失败 ' + r.status));
      renderAging(j);
    } catch (e) {
      $('agOut').innerHTML = '';
      err.textContent = '查询失败：' + (e.message || e);
    } finally {
      btn.disabled = false; busy.textContent = '';
    }
  }

  function renderAging(j) {
    const s = j.sums || {};
    const shown = j.rows ? j.rows.length : 0;
    $('agOut').innerHTML = `<div class="ag-cards">
        <div class="ag-card"><b>${j.total}</b><span>单（${esc((j.statuses || []).join('/'))}）</span></div>
        <div class="ag-card amber"><b>${fmt(r2(s.amount || 0))}</b><span>订单金额合计（元）</span></div>
        <div class="ag-card green"><b>${fmt(r2(s.share || 0))}</b><span>我的分成合计（元）</span></div>
        <div class="ag-card purple"><b>${fmt(r2(s.writerFee || 0))}</b><span>写手报酬合计（元）</span></div>
        <div class="ag-card blue"><b>${fmt(r2(s.net || 0))}</b><span>分成 − 报酬（元）</span></div>
      </div>
      <div class="hint">「下次要打多少钱」我不好替你定口径，所以四个数都列着：要给客户/平台对账看<b>订单金额</b>；算自己到手看<b>分成</b>；发写手工资看<b>报酬</b>；<b>分成−报酬</b>是分单后的净额。${j.total ? '最久的一单已经等了 <b>' + j.oldestDays + '</b> 天。' : '这个条件下没有单子。'}</div>
      ${j.truncated ? '<div class="find-warn">命中超过 5000 条已被截断，合计只按前 5000 条算，请缩短时间范围。</div>' : ''}
      ${j.total ? `<div class="table-card ag-buckets"><table><thead><tr><th>等待天数</th><th class="num">单数</th><th class="num">订单金额</th><th class="num">我的分成</th><th class="num">写手报酬</th></tr></thead><tbody>`
        + (j.buckets || []).map(b => `<tr class="${b.n ? '' : 'ag-zero'}"><td>${b.lo}${b.hiLabel ? '–' + b.hiLabel : '+'} 天</td><td class="num">${b.n}</td><td class="num">${fmt(r2(b.amount))}</td><td class="num">${fmt(r2(b.share))}</td><td class="num">${fmt(r2(b.writerFee))}</td></tr>`).join('')
        + '</tbody></table></div>' : ''}
      ${shown ? `<div class="table-card ag-table"><table><thead><tr><th>等待</th><th>接单日</th><th>订单编号</th><th class="num">订单金额</th><th class="num">分成</th><th class="num">报酬</th><th>分类</th><th>备注</th><th>操作</th></tr></thead><tbody>`
        + j.rows.map(agRow).join('')
        + '</tbody></table></div>' + (j.total > shown ? `<div class="hint">表里只列前 ${shown} 条（按等待天数从久到近），合计是全部 ${j.total} 条的。</div>` : '') : (j.total ? '' : '<div class="q-empty">这个条件下没有单子。把时间放宽，或勾上「已结算」再看。</div>')}
      <div class="hint">口径：时间范围筛的是<b>${j.field === 'doneDate' ? '完单日' : '接单日'}</b>${j.from ? '，起 ' + esc(j.from) : ''}${j.to ? '，止 ' + esc(j.to) : ''}${j.minDays ? '，且等待 ≥ ' + j.minDays + ' 天' : ''}${j.split !== 'all' ? '，' + (j.split === 'yes' ? '只看已分单' : '只看未分单') : ''}${j.keyword ? '，关键词「' + esc(j.keyword) + '」' : ''}。报表只读，点行上的「编辑」才会改数据。</div>`;
  }

  function agRow(o) {
    const cls = o.days >= 60 ? 'd-old' : o.days >= 30 ? 'd-mid' : 'd-new';
    const canGo = orders.some(x => String(x._id) === String(o._id));
    return `<tr>
      <td><span class="ag-days ${cls}">${o.days} 天</span></td>
      <td>${esc(o.date)}</td>
      <td><b class="cpy" data-copy="${esc(o.orderNo)}" title="点击复制单号">${esc(o.orderNo)}</b></td>
      <td class="num">${fmt(r2(o.amount))}</td>
      <td class="num">${fmt(r2(o.share))}</td>
      <td class="num">${o.writerFee ? fmt(r2(o.writerFee)) + '<span class="find-sub"> ' + esc(o.writer || '') + '</span>' : '<span style="color:#cbd5e1">—</span>'}</td>
      <td><span class="tag ${esc(stLabel(o.status))}">${esc(stLabel(o.status))}</span>${inReview(o._id, o.orderNo) ? '<span class="tag 需复核">需复核</span>' : ''}</td>
      <td class="note-cell" title="${esc(o.note)}">${esc(o.note)}</td>
      <td>${canGo
        ? `<button class="btn-mini" onclick="this.getRootNode().host.__ledger.agLocate('${esc(String(o._id))}')">定位</button><button class="btn-mini" onclick="this.getRootNode().host.__ledger.agEdit('${esc(String(o._id))}')">编辑</button>`
        : '<span class="find-sub" title="这单不在页面已加载的明细里（明细最多加载 500 条）">未加载</span>'}</td>
    </tr>`;
  }

  function agLocate(id) { closeAgModal(); locateOrder(id); }
  function agEdit(id) { closeAgModal(); openModal(id); }

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
    shDoc.getElementById('tileDTitle').textContent = P.scopeLabel + unitTxt + '分成收入走势（按接单日 · 含已结算）';
    shDoc.getElementById('tileCTitle').textContent = P.scopeLabel + unitTxt + '累计分成收入走势';
    shDoc.getElementById('tileDVal').innerHTML = fmt(r2(peak)) + '<small> 元</small>';
    shDoc.getElementById('tileDSub').textContent = peak > 0 ? `单日峰值 · ${P.keys[peakIdx]} · 点击看走势 →` : '暂无收入，点击看走势 →';
    shDoc.getElementById('tileCVal').innerHTML = fmt(r2(cum[cum.length - 1] || 0)) + '<small> 元</small>';
    // 【v26.72】这张图按「接单日期」落桶、且含已结算，所以它的终点是"区间内接单的订单分成合计"，
    // 既不等于预计总收入，也略小于「预计总收入 + 已结算分成」（后两者还含接单日在区间外、
    // 但完单日落在区间内的单）。原来直接标成"= 预计总收入"，两张卡数字对不上又看不出为什么。
    shDoc.getElementById('tileCSub').textContent = '累计终点 = 区间内接单的订单分成合计（含已结算）· 点击看走势 →';
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
      // 【v26.72】与「预计总收入」同口径：带「预计」二字的数一律不含已结算，否则同一块面板上
      // 两张卡口径不一致，做完的单结算掉之后当日「预计收入」会凭空少一块，看着像出鬼了。
      unpaid: done.filter(o => stLabel(o.status) !== '已结算'),
      takeAmt: take.reduce((s, o) => s + o.amount, 0),
      doneAmt: done.reduce((s, o) => s + o.amount, 0),
      shareAmt: done.filter(o => stLabel(o.status) !== '已结算').reduce((s, o) => s + effShare(o), 0),
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
      <span class="tb-share">预计今天完单收入（未结算）：<b>${fmt(r2(td.shareAmt))}</b> 元${td.unpaid.length ? '' : ' · 今天没有待结算的单'}</span>`;

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
      <div class="ds purple">预计完单分成收入（未结算）<b>${fmt(r2(st.shareAmt))} 元</b><small style="color:#8a8578">已结算的计入旁边「完单金额」</small></div>`;
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
    $('mShare').value = o ? o.shareRate : DEFAULT_RATE;
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
    // 【v26.66】批量改分成的入口与弹窗内联动
    $('btnRate').onclick = openRateModal;
    $('rateCancel').onclick = closeRateModal;
    $('rateMask').onclick = e => { if (e.target === $('rateMask')) closeRateModal(); };
    $('rateScope').onchange = renderRatePreview;
    $('rateNew').oninput = renderRatePreview;
    $('rateSave').onclick = submitRateBatch;
    // 【v26.81】账单粘贴找单
    $('btnFind').onclick = openFindModal;
    $('findClose').onclick = closeFindModal;
    $('findGo').onclick = runFind;
    $('findMask').onclick = e => { if (e.target === $('findMask')) closeFindModal(); };
    $('findText').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runFind(); });
    // 【v26.82】逐单对账：返回按钮、点背景、快捷键
    $('reconBack').onclick = closeRecon;
    $('reconMask').onclick = e => { if (e.target === $('reconMask')) closeRecon(); };
    document.addEventListener('keydown', e => {
      const recon = $('reconMask').classList.contains('show');
      const find = $('findMask').classList.contains('show');
      if (recon) {
        const t = e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        const k = e.key.toLowerCase();
        if (k === 'escape') { closeRecon(); return; }
        if (k === 'y') { reconApply('已结算'); return; }
        if (k === 'n') { reconApply('待结算'); return; }
        if (k === 's') { const late = $('rcLate'); if (late) reconLate(); return; }   // 只在卡上真有这个按钮时才响应
        if (k === ' ' || k === 'arrowright') { e.preventDefault(); reconNext(); return; }
        if (k === 'arrowleft') { e.preventDefault(); reconPrev(); return; }
        return;
      }
      if (e.key !== 'Escape') return;
      if ($('reviewMask').classList.contains('show')) { closeReviewModal(); return; }
      if ($('agMask').classList.contains('show')) { closeAgModal(); return; }
      if (find) closeFindModal();
    });
    // 【v26.83】二次核验专区
    $('btnReview').onclick = openReviewModal;
    $('reviewClose').onclick = closeReviewModal;
    $('reviewGo').onclick = startReviewRecon;
    $('reviewRefresh').onclick = () => { $('reviewBusy').textContent = '取清单中…'; loadReview().then(renderReview).then(() => { $('reviewBusy').textContent = ''; }); };
    $('reviewMask').onclick = e => { if (e.target === $('reviewMask')) closeReviewModal(); };
    // 【v26.84】高级筛选 · 未结算账龄
    $('btnAg').onclick = openAgModal;
    $('agClose').onclick = closeAgModal;
    $('agGo').onclick = agQuery;
    $('agMask').onclick = e => { if (e.target === $('agMask')) closeAgModal(); };
    [...shDoc.querySelectorAll('[data-ag]')].forEach(b => b.onclick = () => { agQuick(b.dataset.ag); agQuery(); });
    ['agField', 'agSplit', 'agFrom', 'agTo', 'agMinDays', 'agKw'].forEach(id => { $(id).onchange = agQuery; });
    $('agStatus').addEventListener('change', agQuery);
    // 勾选：明细表是分页渲染的，用事件委托挂在 tbody 上，翻页后旧监听不会残留
    $('tbody').addEventListener('change', e => {
      const ck = e.target.closest('[data-rck]');
      if (!ck) return;
      if (ck.checked) RATE_SEL.add(ck.dataset.rck); else RATE_SEL.delete(ck.dataset.rck);
      syncRateHeader();
    });
    $('ckAll').onchange = e => {
      PAGE_ROWS.forEach(id => { if (e.target.checked) RATE_SEL.add(String(id)); else RATE_SEL.delete(String(id)); });
      render();
    };
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
      // 复核标记要在明细画出来之后重画一次，否则「需复核」角标第一次是空的
      loadReview().then(render);
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
    openFindModal, closeFindModal, runFind, locateOrder,
    startRecon, closeRecon,
    openReviewModal, closeReviewModal, clearOneReview, startReviewRecon,
    openAgModal, closeAgModal, agLocate, agEdit,
    logout: () => {
      localStorage.removeItem('jdy_token');
      localStorage.removeItem('jdy_user');
      location.href = '/login.html';
    },
  };

  return { refresh: () => loadOrders() };
}
