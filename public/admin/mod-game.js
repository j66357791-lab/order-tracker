// admin/mod-game.js — 游戏控制器（V23 重做：大区导航 + 白话功能区 + 全表单化配置）
//
// 【V23 信息架构】按用户反馈重做：原来所有配置堆一页、满屏字段看不懂。
// 现在：顶部三大区（翻翻乐 / 山海斩妖录 / 数据与日志），翻翻乐里再按"玩家视角"分功能区，
// 每个功能区只回答一个问题：
//   道具说明与基础 —— 钥匙/碎片/魔法球/复活石都干嘛用、每天发多少
//   魔法球能换什么 —— 商铺兑换商品（下拉+数量，不再手写 frags=10）
//   福袋开出什么   —— 大中小福袋各开多少钱（两个数字框）
//   任务专区       —— 玩家在任务页看到什么、点什么
//   翻牌概率(高级) —— 翻牌能翻出什么（逐行表单，实时合计校验，不再写 JSON）
//   给玩家发道具   —— 按用户查询背包、发放/扣除
import { api, esc, toast, cnTime } from './app.js';

const ITEM_LBL = { frag: '魔法球碎片', key: '魔法钥匙', ball: '魔法球', bagS: '福袋·小', bagM: '福袋·中', bagL: '福袋·大' };
const GIVE_LBL = { frags: '魔法球碎片', keys: '魔法钥匙', balls: '魔法球', revives: '复活石', bagS: '福袋·小', bagM: '福袋·中', bagL: '福袋·大' };
const GIVE_KEYS = Object.keys(GIVE_LBL);
const ACTIONS = { daily: '每日领取', play: '去翻牌', bags: '去拆福袋', link: '跳转链接', info: '纯展示' };

export function mount(root) {
  root.innerHTML = `
  <div class="content-head">
    <div><h1 class="serif">游戏控制器</h1><div class="sub">按游戏分区管理 —— 改动保存后即时生效，玩家下次打开就是新的</div></div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="gmRefresh">刷新数据</button>
  </div>

  <div class="tabs" id="gmNav" style="margin-bottom:16px">
    <button data-z="ff" class="on">🃏 翻翻乐</button>
    <button data-z="sh">⚔️ 山海斩妖录</button>
    <button data-z="data">📊 数据与日志</button>
  </div>

  <!-- ============ 区一：翻翻乐 ============ -->
  <div id="gmZone-ff">
    <div class="tabs" id="gmFFNav" style="margin-bottom:14px">
      <button data-s="items" class="on">🎁 道具说明与基础</button>
      <button data-s="shop">🛒 魔法球能换什么</button>
      <button data-s="bags">🧧 福袋开出什么</button>
      <button data-s="tasks">📋 任务专区</button>
      <button data-s="prob">🎲 翻牌概率（高级）</button>
      <button data-s="grant">📤 给玩家发道具</button>
    </div>

    <!-- 1. 道具说明与基础 -->
    <div id="gmS-items">
      <div class="card">
        <h2 class="serif">每种道具是干嘛的</h2>
        <div id="gmItemGuide"><div class="empty">加载中…</div></div>
        <div class="sub" style="margin-top:10px">下面的数字就是玩家每天能拿到多少、攒多少能合成，改完点保存立即生效。</div>
        <div class="inline" style="margin-top:10px">
          <label class="mini-lbl">活动开始<input id="gmCfgStart" placeholder="2026-09-12"></label>
          <label class="mini-lbl">活动结束<input id="gmCfgEnd" placeholder="2026-10-31"></label>
          <label class="mini-lbl">每天免费领钥匙<input id="gmCfgDaily" type="number" min="0" max="10">把</label>
          <label class="mini-lbl">攒碎片合成魔法球要<input id="gmCfgCompose" type="number" min="1" max="100">个碎片</label>
          <label class="mini-lbl">每局最多用复活石<input id="gmCfgRevive" type="number" min="0" max="5">次</label>
        </div>
        <div style="margin-top:12px"><button class="btn-main" id="gmSaveCfg">保存基础设置</button></div>
      </div>
    </div>

    <!-- 2. 魔法球能换什么（商铺） -->
    <div id="gmS-shop" style="display:none">
      <div class="card">
        <h2 class="serif">魔法球能换什么（商铺兑换）</h2>
        <div class="sub">玩家翻牌攒魔法球，在这里配"多少个魔法球换什么"。每行一个兑换项，取消勾选"上架"就不在玩家端显示。</div>
        <div id="gmShopRows" style="margin-top:10px"></div>
        <div class="inline" style="margin-top:10px">
          <button class="btn-ghost" id="gmShopAdd">＋ 加一个兑换项</button>
          <span style="flex:1"></span>
          <button class="btn-main" id="gmShopSave">保存商铺</button>
        </div>
      </div>
    </div>

    <!-- 3. 福袋开出什么 -->
    <div id="gmS-bags" style="display:none">
      <div class="card">
        <h2 class="serif">福袋拆开开出什么</h2>
        <div class="sub">福袋开出的是<b>现金红包</b>，直接进玩家钱包（写手端可提现）。金额在这个区间里随机。</div>
        <div id="gmBagRows" style="margin-top:10px"></div>
        <div style="margin-top:12px"><button class="btn-main" id="gmBagSave">保存福袋金额</button></div>
      </div>
    </div>

    <!-- 4. 任务专区 -->
    <div id="gmS-tasks" style="display:none">
      <div class="card">
        <h2 class="serif">玩家在「任务专区」看到什么</h2>
        <div class="sub">每行一个任务条目；按钮类型决定玩家点下去会发生什么。</div>
        <div id="gmTaskRows" style="margin-top:10px"></div>
        <div class="inline" style="margin-top:10px">
          <button class="btn-ghost" id="gmTaskAdd">＋ 加一个任务</button>
          <span style="flex:1"></span>
          <button class="btn-main" id="gmTaskSave">保存任务专区</button>
        </div>
      </div>
    </div>

    <!-- 5. 翻牌概率（高级） -->
    <div id="gmS-prob" style="display:none">
      <div class="card">
        <h2 class="serif">翻牌能翻出什么（掉落概率）</h2>
        <div class="sub">三波翻牌，越往后奖越大、越容易"奖励逃跑"。每一行 = 一种奖励及其出现概率；<b>逃跑率 + 所有奖励概率 合计不能超过 100%</b>，页面会实时提示。改完只影响之后新开的对局。</div>
        <div id="gmProbBox" style="margin-top:10px"></div>
        <div class="err" id="gmProbErr"></div>
        <div class="inline" style="margin-top:10px">
          <button class="btn-main" id="gmProbSave">保存概率设置</button>
          <button class="btn-ghost" id="gmProbReset">全部还原为默认</button>
        </div>
      </div>
    </div>

    <!-- 6. 给玩家发道具 -->
    <div id="gmS-grant" style="display:none">
      <div class="card">
        <h2 class="serif">给玩家发道具 / 扣道具</h2>
        <div class="sub">输入玩家 ID 查背包；发放填正数、扣除填负数。</div>
        <div class="inline"><input id="gmUid" placeholder="玩家手机号 / 工号 / ID"><button class="btn-main" id="gmFind">查询背包</button></div>
        <div id="gmUserBox" style="margin-top:10px"></div>
        <div class="inline" style="margin-top:10px">
          <select id="gmGrantItem" style="max-width:170px">
            <option value="keys">魔法钥匙</option><option value="balls">魔法球</option>
            <option value="frags">魔法球碎片</option><option value="revives">复活石</option>
            <option value="bagS">福袋·小</option><option value="bagM">福袋·中</option><option value="bagL">福袋·大</option>
          </select>
          <input id="gmGrantN" type="number" value="1" style="max-width:90px">
          <button class="btn-main" id="gmGrant">发放（负数为扣除）</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ============ 区二：山海斩妖录 ============ -->
  <div id="gmZone-sh" style="display:none">
    <div class="card">
      <h2 class="serif">山海斩妖录数据</h2>
      <div class="sub">玩家总量 / 胜场 / 顶榜写手</div>
      <div id="gmShanhai"><div class="empty">加载中…</div></div>
    </div>

    <div class="card">
      <style>
        /* 【v26.17】技能树配置 · 紧凑竖向布局：分支一列往下排，节点一行一条 */
        .st-tabs { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 10px; }
        .st-tabs button { padding:5px 12px; border-radius:16px; border:1px solid #cfd8e3; background:#fff; font:600 12px/1.4 sans-serif; cursor:pointer; }
        .st-tabs button.on { background:#1f4e79; color:#fff; border-color:#1f4e79; }
        .st-branch { border:1px solid #dde5ee; border-radius:8px; padding:8px 10px; margin-bottom:8px; background:#fafcfe; }
        .st-bhead { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
        .st-bhead input { font-weight:700; }
        .st-row { display:grid; grid-template-columns:minmax(90px,1.2fr) 64px 52px 52px minmax(110px,1fr) 46px minmax(110px,1.2fr) minmax(110px,1.2fr) 26px; gap:4px; align-items:center; padding:4px 0; border-top:1px dashed #e7edf4; }
        .st-row:first-of-type { border-top:none; }
        .st-row input, .st-row select { font:12px/1.4 sans-serif; padding:3px 4px; border:1px solid #cfd8e3; border-radius:5px; min-width:0; width:100%; box-sizing:border-box; }
        .st-row .st-del { color:#b3452f; cursor:pointer; border:none; background:none; font:700 14px/1 sans-serif; }
        .st-head { font:700 10.5px/1.4 sans-serif; color:#8a97a8; display:grid; grid-template-columns:minmax(90px,1.2fr) 64px 52px 52px minmax(110px,1fr) 46px minmax(110px,1.2fr) minmax(110px,1.2fr) 26px; gap:4px; padding-bottom:2px; }
        .st-mini { font:11px/1.4 sans-serif; padding:3px 6px; border:1px solid #cfd8e3; border-radius:5px; background:#fff; }
        .st-fhead { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:8px; }
        .st-fhead input { font:12px/1.4 sans-serif; padding:3px 6px; border:1px solid #cfd8e3; border-radius:5px; }
        .st-fhead label { font:600 11px/1.4 sans-serif; color:#5b6a7d; display:flex; align-items:center; gap:3px; }
        /* 【v26.21】树状列布局：与玩家端技能阁同构（核心→汇集轨→五列平齐向下） */
        .st-rail { height:2px; background:#c9d4e0; border-radius:1px; margin:2px 8% 0; }
        .st-cols { display:flex; gap:8px; align-items:stretch; margin-top:8px; flex-wrap:wrap; }
        .st-col { flex:1; min-width:158px; border:1px solid #dde5ee; border-radius:8px; padding:6px; background:#fafcfe; display:flex; flex-direction:column; gap:5px; }
        .st-col::before { content:""; width:2px; height:8px; margin:0 auto; background:#c9d4e0; }
        .st-coladd { justify-content:flex-end; align-items:center; background:transparent; border-style:dashed; }
        .st-coladd::before { display:none; }
        .st-colhead { display:flex; gap:3px; align-items:center; }
        .st-colhead input { font:700 12px/1.4 sans-serif; padding:3px 4px; border:1px solid #cfd8e3; border-radius:5px; min-width:0; width:100%; box-sizing:border-box; }
        .st-card { border:1px solid #e3eaf2; border-radius:7px; padding:5px; background:#fff; display:flex; flex-direction:column; gap:4px; }
        .st-line { display:flex; gap:3px; align-items:center; }
        .st-line input, .st-line select { font:11.5px/1.4 sans-serif; padding:2px 3px; border:1px solid #cfd8e3; border-radius:4px; min-width:0; flex:1; width:auto; box-sizing:border-box; }
        .st-line input[type="number"] { width:40px; flex:0 0 40px; }
        .st-lbl { font:600 10px/1.4 sans-serif; color:#8a97a8; display:flex; align-items:center; gap:2px; flex:0 0 auto; }
        .st-lbl input { width:34px !important; flex:0 0 34px !important; }
        .st-wide { font:11.5px/1.4 sans-serif; padding:2px 4px; border:1px solid #e3eaf2; border-radius:4px; width:100%; box-sizing:border-box; background:#fbfdff; }
        .st-add { width:100%; }
        .st-adv-toggle { margin-left:auto; font:600 11px/1.4 sans-serif; color:#1f4e79; display:flex; align-items:center; gap:3px; }
        .st-line select { min-width:0; }
        /* 拖拽排序 */
        .st-card { cursor: grab; }
        .st-card.dragging, .st-card.st-dragging { opacity: .45; outline: 2px dashed #4a9a6e; }
        .st-card.st-over { outline: 2px dashed #4a9a6e; outline-offset: -2px; background: #eef8f1; }
        .st-colhead { cursor: grab; }
        .st-colhead.st-dragging { opacity: .5; }
        .st-colhead input, .st-colhead button { cursor: auto; }
      </style>
      <h2 class="serif">流派技能树配置</h2>
      <div class="sub">和玩家端一样的树：每个竖列是一个分支方向，技能从上往下排。<b>最常用就三件事</b>——改技能名、改「级」（最高等级）、在「前置」里选先学哪个技能。点 ✕ 删除，列底「＋加技能」。改完点下方「保存技能树」。</div>
      <div class="st-tabs" id="stTabs"></div>
      <div id="stEditor"><div class="empty">加载中…</div></div>
      <div style="margin-top:10px">
        <div class="inline">
          <button class="btn-ghost" id="stExport">导出为文本</button>
          <button class="btn-ghost" id="stImport">从文本导入</button>
          <span class="sub">导出后直接改文字，改完点「从文本导入」回填；把文本发我也行，我来解析写入</span>
        </div>
        <textarea id="stIOText" rows="12" style="display:none;width:100%;font:12px/1.8 monospace;margin-top:6px;padding:8px;border:1px solid #cfd8e3;border-radius:8px;box-sizing:border-box" placeholder="流派 万剑流派 | ⚔ | 新手 | 简介...&#10;  分支 万剑归宗 | 群体攻击&#10;    剑意 | 属性 | 耗1 | 级5 | atk:1 | 攻击力+1&#10;    剑芒 | 特殊 | 耗2 | 级3 | crit:2 | 暴击率+2% | 前置:剑意@2"></textarea>
      </div>
      <div class="inline" style="margin-top:10px">
        <button class="btn-ghost" id="stAddFaction">＋ 新增流派</button>
        <button class="btn-ghost" id="stReset">恢复默认技能树</button>
        <span style="flex:1"></span>
        <button class="btn-main" id="stSave">保存技能树</button>
      </div>
    </div>

    <div class="card">
      <style>
        .act-row { border:1px solid #dde5ee; border-radius:8px; padding:8px 10px; margin-bottom:8px; background:#fafcfe; }
        .act-row .line { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:5px; }
        .act-row .line:last-child { margin-bottom:0; }
        .act-row input, .act-row select, .act-row textarea { font:12px/1.5 sans-serif; padding:3px 5px; border:1px solid #cfd8e3; border-radius:5px; box-sizing:border-box; }
        .act-row textarea { width:100%; }
        .act-row label { font:600 11px/1.4 sans-serif; color:#5b6a7d; display:flex; align-items:center; gap:3px; }
        .act-badge-on { font:700 10px/1 sans-serif; color:#2f7a5a; background:#eef8f1; border-radius:8px; padding:3px 8px; }
        .act-badge-off { font:700 10px/1 sans-serif; color:#8a97a8; background:#eef1f5; border-radius:8px; padding:3px 8px; }
      </style>
      <h2 class="serif">活动管理</h2>
      <div class="sub">维护锁打开后，玩家端活动入口显示上锁样式、无法进入；测试账号（用户名或工号，逗号分隔）不受限制，可正常打开测试。</div>
      <div class="inline" style="margin-top:10px">
        <label class="mini-lbl">维护锁
          <select id="actLock"><option value="0">关闭（活动可正常访问）</option><option value="1">开启（玩家端上锁）</option></select>
        </label>
        <label class="mini-lbl">堆堆乐内测
          <select id="ddBeta"><option value="0">关闭</option><option value="1">开启（测试员不受时间限制可提前参与）</option></select>
        </label>
        <label class="mini-lbl" style="flex:1">测试账号（逗号分隔，用户名或工号）
          <input id="actTesters" placeholder="如：admin,1000001,tester01" style="width:100%">
        </label>
        <button class="btn-main" id="actSysSave">保存维护设置</button>
      </div>
      <div class="inline" style="margin-top:6px">
        <label class="mini-lbl">检索用户（用户名/工号）<input id="ddFind" placeholder="输入要测试的玩家账号" style="width:170px"></label>
        <button class="st-mini" id="ddFindBtn">查询</button>
        <span id="ddFindOut" class="sub" style="flex:1"></span>
      </div>
      <div class="inline" style="margin-top:6px">
        <label class="mini-lbl">清理堆堆乐参与记录（内测重置）：用户名/工号
          <input id="ddCleanUser" placeholder="留空 = 清空全部记录" style="width:200px">
        </label>
        <button class="btn-ghost" id="ddClean" style="color:#b3452f">清理记录</button>
        <span class="sub">清理后该玩家的免费次数/通关加成次数会重新可用</span>
      </div>
      <div style="margin-top:12px" id="actList"><div class="empty">加载中…</div></div>
      <div class="inline" style="margin-top:8px">
        <button class="btn-ghost" id="actAdd">＋ 新增活动</button>
        <button class="btn-ghost" id="actReload">刷新</button>
      </div>
    </div>
  </div>

  <!-- ============ 区三：数据与日志 ============ -->
  <div id="gmZone-data" style="display:none">
    <div class="card">
      <h2 class="serif">数据库占用</h2>
      <div class="sub">每个集合的文档数与占用空间（按存储大小排序）· 总计：<b id="gmDbTotal">-</b></div>
      <div id="gmDbStats" style="margin-top:10px"><div class="empty">加载中…</div></div>
      <div class="inline" style="margin-top:10px"><button class="btn-ghost" id="gmDbReload">重新统计</button></div>
    </div>
    <div class="card">
      <h2 class="serif">挂机收益 · 老玩家激活</h2>
      <div class="sub">解锁线：通关第 <b>2</b> 关 ｜ 符合条件 <b id="gmIdleEligible">-</b> 人 · 已激活计时 <b id="gmIdleActive">-</b> 人
        　<span class="muted">（"激活"= 把挂机计时起点设为现在，从这一刻开始累计，不补发历史时长）</span></div>
      <div id="gmIdleList" style="margin-top:10px"><div class="empty">加载中…</div></div>
      <div class="inline" style="margin-top:12px">
        <button class="btn-ghost" id="gmIdleCheck">刷新名单（并自动激活未激活的）</button>
        <button class="btn-main" id="gmIdleReset">全员重新计时（起点=现在）</button>
      </div>
    </div>
    <div class="card">
      <h2 class="serif">可清理项（开发阶段清历史数据）</h2>
      <div class="sub">只显示数量，点"清理"会二次确认后删除指定天数之前的数据；活跃数据不受影响。</div>
      <div id="gmDbClean" style="margin-top:10px"><div class="empty">加载中…</div></div>
    </div>
    <div class="card">
      <h2 class="serif">翻翻乐数据总览</h2>
      <div class="grid3" id="gmStats"><div class="empty">加载中…</div></div>
      <div class="inline" style="margin-top:14px">
        <button class="btn-danger" id="gmCleanup">清场：作废所有进行中对局并退钥匙</button>
        <button class="btn-ghost" id="gmMaint">维护模式：读取中</button>
      </div>
    </div>
    <div class="card">
      <h2 class="serif">兑换记录</h2>
      <div class="sub">最近 15 笔</div>
      <div id="gmRedeems"><div class="empty">加载中…</div></div>
    </div>
    <div class="card">
      <h2 class="serif">操作日志</h2>
      <div class="sub">最近 30 条关键动作</div>
      <div id="gmLogs"><div class="empty">加载中…</div></div>
    </div>
  </div>`;

  const $ = id => root.querySelector('#' + id);
  let maintOn = false, CFG = null;

  // ==================== 大区 / 功能区切换 ====================
  root.querySelectorAll('#gmNav button').forEach(b => { b.onclick = () => {
    root.querySelectorAll('#gmNav button').forEach(x => x.classList.toggle('on', x === b));
    for (const z of ['ff', 'sh', 'data']) $('gmZone-' + z).style.display = z === b.dataset.z ? '' : 'none';
    // 【v24.8】进"数据与日志"时刷新挂机激活名单
    if (b.dataset.z === 'data' && typeof loadIdle === 'function') loadIdle();
  }; });
  root.querySelectorAll('#gmFFNav button').forEach(b => { b.onclick = () => {
    root.querySelectorAll('#gmFFNav button').forEach(x => x.classList.toggle('on', x === b));
    for (const s of ['items', 'shop', 'bags', 'tasks', 'prob', 'grant']) $('gmS-' + s).style.display = s === b.dataset.s ? '' : 'none';
  }; });

  // ==================== 加载 ====================
  async function loadCfg() {
    try {
      const c = await api('/api/game/admin/config');
      CFG = c;
      const e = c.effective;
      $('gmCfgStart').value = e.start; $('gmCfgEnd').value = e.end;
      $('gmCfgDaily').value = e.dailyFreeKey; $('gmCfgCompose').value = e.composeFragCost; $('gmCfgRevive').value = e.maxRevivesPerGame;
      renderGuide(e);
      renderShopRows(c.shop || []);
      renderBagRows(e);
      renderTaskRows(c.tasks || []);
      PROB = normProbIn(c.prob || {});
      renderProb();
    } catch (err) { toast(err.message); }
  }

  function renderGuide(e) {
    const rows = [
      ['🔑', '魔法钥匙', '开一局翻牌的"门票"', `玩家每天可免费领 <b>${e.dailyFreeKey}</b> 把，翻牌赢了也能拿到`],
      ['🧩', '魔法球碎片', '攒着合成魔法球', `每 <b>${e.composeFragCost}</b> 个碎片可合成 1 个魔法球`],
      ['🔮', '魔法球', '在商铺兑换奖励', `能换什么在上方「魔法球能换什么」里配置，当前 ${(CFG.shop || []).filter(s => s.enabled !== false).length} 个兑换项`],
      ['💗', '复活石', '翻到"奖励逃跑"时抵消一次', `每局限用 <b>${e.maxRevivesPerGame}</b> 次`],
      ['🧧', '福袋', '拆开直接得现金红包', '大/中/小三种，开出金额在「福袋开出什么」里配置'],
    ];
    $('gmItemGuide').innerHTML = rows.map(([ico, name, use, note]) => `
      <div class="item-card" style="padding:10px 14px">
        <div class="inline" style="justify-content:flex-start;gap:12px">
          <span style="font-size:22px">${ico}</span>
          <b style="min-width:80px">${name}</b>
          <span class="sub" style="flex:1">${use} —— ${note}</span>
        </div>
      </div>`).join('');
  }

  // ==================== 基础设置 ====================
  async function saveCfg() {
    try {
      const b = {};
      if ($('gmCfgStart').value) b.start = $('gmCfgStart').value.trim();
      if ($('gmCfgEnd').value) b.end = $('gmCfgEnd').value.trim();
      if ($('gmCfgDaily').value !== '') b.dailyFreeKey = +$('gmCfgDaily').value;
      if ($('gmCfgCompose').value !== '') b.composeFragCost = +$('gmCfgCompose').value;
      if ($('gmCfgRevive').value !== '') b.maxRevivesPerGame = +$('gmCfgRevive').value;
      await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify(b) });
      toast('基础设置已保存，立即生效'); loadCfg();
    } catch (e) { toast(e.message); }
  }

  // ==================== 商铺（魔法球能换什么） ====================
  // 【v23.1】图标人工选择：内置图标下拉（带缩略图预览）+ 可直接贴图片地址，不再按道具类型自动配
  const ICON_IMG = { frag: '/assets/game/icon_frag.png', key: '/assets/game/icon_key.png', ball: '/assets/game/icon_ball.png', revive: '/assets/game/icon_revive.png', bagS: '/assets/game/bag_s.png', bagM: '/assets/game/bag_m.png', bagL: '/assets/game/bag_l.png' };
  const isIconUrl = v => /^(https?:\/\/|\/assets\/|\/games\/)/.test(v || '');
  const icoSrc = v => isIconUrl(v) ? v : (ICON_IMG[v] || '');
  let SHOP_ROWS = [];
  function renderShopRows(list) {
    SHOP_ROWS = list.map(x => ({
      id: x.id, name: x.name || '', icon: x.icon || 'ball', cost: x.cost ?? 1,
      pairs: giveToPairs(x.give), desc: x.desc || '', enabled: x.enabled !== false,
    }));
    paintShopRows();
  }
  function giveToPairs(g) {
    const pairs = Object.entries(g || {}).map(([k, v]) => [k, Number(v) || 0]).filter(([, v]) => v > 0);
    return pairs.length ? pairs : [['frags', 1]];
  }
  function pairsToGive(pairs) {
    const g = {};
    for (const [k, v] of pairs) if (GIVE_KEYS.includes(k) && v > 0) g[k] = v;
    return g;
  }
  function paintShopRows() {
    $('gmShopRows').innerHTML = SHOP_ROWS.map((s, i) => {
      const urlMode = isIconUrl(s.icon);
      return `
      <div class="item-card" style="padding:10px 12px">
        <div class="inline" style="gap:6px">
          <span style="width:44px;height:44px;border-radius:10px;border:1px solid var(--line);background:#fff;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
            ${s.icon ? `<img src="${esc(icoSrc(s.icon))}" style="width:36px;height:36px;object-fit:contain" onerror="this.style.opacity=.2">` : '<span class="sub" style="font-size:10px">未选</span>'}
          </span>
          <input data-i="${i}" data-f="name" value="${esc(s.name)}" placeholder="兑换项名称，如：魔法钥匙×5" style="flex:2;min-width:130px">
          <label class="mini-lbl" style="flex-direction:row;align-items:center;gap:5px">需要魔法球<input data-i="${i}" data-f="cost" type="number" min="0" value="${s.cost ?? 0}" style="max-width:80px"></label>
          <label style="font-size:12.5px;color:var(--ink2);display:flex;align-items:center;gap:5px"><input type="checkbox" data-i="${i}" data-f="enabled" ${s.enabled ? 'checked' : ''}>上架</label>
          <button class="btn-ghost" style="padding:4px 12px" data-del="${i}">删除</button>
        </div>
        <div class="inline" style="gap:6px;margin-top:6px">
          <span style="font-size:12.5px;color:var(--ink2)">图标：</span>
          <select data-i="${i}" data-f="iconSel" style="max-width:150px">
            ${Object.entries(ICON_IMG).map(([k, src]) => `<option value="${k}" ${s.icon === k ? 'selected' : ''}>${GIVE_LBL[k]}</option>`).join('')}
            <option value="__custom" ${urlMode ? 'selected' : ''}>自定义图片…</option>
          </select>
          <input data-i="${i}" data-f="iconUrl" value="${urlMode ? esc(s.icon) : ''}" placeholder="粘贴图片地址（https://… 或 /assets/…）" style="flex:1;min-width:160px;${urlMode ? '' : 'display:none'}">
          <span style="flex:1"></span>
        </div>
        <div class="inline" style="gap:6px;margin-top:6px">
          <span style="font-size:12.5px;color:var(--ink2)">兑换后发给玩家：</span>
          ${s.pairs.map((p, pi) => `
            <select data-i="${i}" data-p="${pi}" data-f="ptype" style="max-width:120px">${GIVE_KEYS.map(k => `<option value="${k}" ${p[0] === k ? 'selected' : ''}>${GIVE_LBL[k]}</option>`).join('')}</select>
            <input data-i="${i}" data-p="${pi}" data-f="pnum" type="number" min="1" value="${p[1]}" style="max-width:76px">`).join('')}
          ${s.pairs.length < 3 ? `<button class="btn-ghost" style="padding:4px 10px" data-more="${i}">＋再加一种</button>` : ''}
          <button class="btn-ghost" style="padding:4px 10px" data-less="${i}" ${s.pairs.length > 1 ? '' : 'disabled style="opacity:.5;"'}>－减一种</button>
        </div>
        <div class="inline" style="gap:6px;margin-top:6px">
          <input data-i="${i}" data-f="desc" value="${esc(s.desc)}" placeholder="给玩家的一句话说明（选填）" style="flex:1;min-width:150px">
        </div>
      </div>`;
    }).join('') || '<div class="empty">还没有兑换项，点下方「加一个兑换项」</div>';
  }
  $('gmShopRows').addEventListener('input', e => {
    const i = e.target.dataset.i, f = e.target.dataset.f;
    if (i === undefined || !f) return;
    const s = SHOP_ROWS[i]; if (!s) return;
    if (f === 'ptype') s.pairs[Number(e.target.dataset.p)][0] = e.target.value;
    else if (f === 'pnum') s.pairs[Number(e.target.dataset.p)][1] = Number(e.target.value) || 0;
    else if (f === 'enabled') s.enabled = e.target.checked;
    else if (f === 'cost') s.cost = Number(e.target.value) || 0;
    else if (f === 'iconUrl') s.icon = e.target.value.trim();   // 自定义图片地址实时写入，缩略图即时预览
    else if (f === 'iconSel') { /* select 走 change */ }
    else s[f] = e.target.value;
    if (f === 'iconUrl') { const img = e.target.closest('.item-card').querySelector('img'); if (img && isIconUrl(s.icon)) { img.src = s.icon; img.style.opacity = 1; } }
  });
  $('gmShopRows').addEventListener('change', e => {
    const i = e.target.dataset.i, f = e.target.dataset.f;
    if (i === undefined || f !== 'iconSel') return;
    const s = SHOP_ROWS[i]; if (!s) return;
    if (e.target.value === '__custom') { s.icon = 'https://'; paintShopRows(); }
    else { s.icon = e.target.value; paintShopRows(); }
  });
  $('gmShopRows').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { SHOP_ROWS.splice(Number(del.dataset.del), 1); paintShopRows(); return; }
    const more = e.target.closest('[data-more]');
    if (more) { SHOP_ROWS[Number(more.dataset.more)].pairs.push(['frags', 1]); paintShopRows(); return; }
    const less = e.target.closest('[data-less]');
    if (less && SHOP_ROWS[Number(less.dataset.less)].pairs.length > 1) { SHOP_ROWS[Number(less.dataset.less)].pairs.pop(); paintShopRows(); }
  });
  $('gmShopAdd').onclick = () => { SHOP_ROWS.push({ id: 'item' + Date.now().toString(36), name: '', icon: 'ball', cost: 1, pairs: [['frags', 1]], desc: '', enabled: true }); paintShopRows(); };
  $('gmShopSave').onclick = async () => {
    const rows = SHOP_ROWS.map(s => ({
      id: s.id, name: s.name, icon: s.icon, cost: s.cost,
      give: pairsToGive(s.pairs), desc: s.desc, enabled: !!s.enabled,
    }));
    for (const r of rows) {
      if (!r.name.trim()) { toast('有兑换项没填名称'); return; }
      if (!r.icon) { toast('「' + r.name + '」还没选图标（选一个内置的，或贴图片地址）'); return; }
      if (!(r.icon in ICON_IMG) && !/^(https?:\/\/|\/assets\/|\/games\/)/.test(r.icon)) { toast('「' + r.name + '」的图片地址要以 http(s):// 或 /assets/ 开头'); return; }
      if (!Object.keys(r.give).length) { toast('「' + r.name + '」还没选兑换后发什么'); return; }
      if (r.enabled && !(r.cost > 0)) { toast('「' + r.name + '」要填需要多少个魔法球（想免费送就先取消上架）'); return; }
    }
    try { await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify({ shop: rows }) }); toast('商铺已保存，玩家端立即生效'); loadCfg(); }
    catch (e) { toast(e.message); }
  };

  // ==================== 福袋 ====================
  function renderBagRows(e) {
    const info = [['bagS', '🧧', '小福袋', '随手翻出来的小红包'], ['bagM', '🧧', '中福袋', '值得开心一下'], ['bagL', '🧧', '大福袋', '大奖级，翻牌越深越容易出']];
    $('gmBagRows').innerHTML = info.map(([k, ico, name, tip]) => `
      <div class="item-card" style="padding:12px 14px">
        <div class="inline" style="justify-content:flex-start;gap:10px">
          <span style="font-size:20px">${ico}</span>
          <b style="min-width:60px">${name}</b>
          <span class="sub" style="flex:1">${tip}：拆开随机开出</span>
          <label class="mini-lbl" style="flex-direction:row;align-items:center;gap:5px">最少<input data-bag="${k}" data-f="min" type="number" step="0.01" min="0" value="${e[k][0]}" style="max-width:90px">元</label>
          <label class="mini-lbl" style="flex-direction:row;align-items:center;gap:5px">最多<input data-bag="${k}" data-f="max" type="number" step="0.01" min="0" value="${e[k][1]}" style="max-width:90px">元</label>
        </div>
      </div>`).join('');
  }
  $('gmBagSave').onclick = async () => {
    const b = {};
    for (const k of ['bagS', 'bagM', 'bagL']) {
      const min = Number(root.querySelector(`[data-bag="${k}"][data-f="min"]`).value), max = Number(root.querySelector(`[data-bag="${k}"][data-f="max"]`).value);
      if (!(max > min)) { toast(GIVE_LBL[k].replace('·', '') + '的"最多"要大于"最少"'); return; }
      b[k] = [min, max];
    }
    try { await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify(b) }); toast('福袋金额已保存，立即生效'); loadCfg(); }
    catch (e) { toast(e.message); }
  };

  // ==================== 任务专区 ====================
  let TASK_ROWS = [];
  function renderTaskRows(list) { TASK_ROWS = list.map(x => Object.assign({}, x)); paintTaskRows(); }
  function paintTaskRows() {
    $('gmTaskRows').innerHTML = TASK_ROWS.map((t, i) => `
      <div class="item-card" style="padding:10px 12px">
        <div class="inline" style="gap:6px">
          <input data-ti="${i}" data-f="title" value="${esc(t.title)}" placeholder="任务名，如：每日登录" style="flex:2;min-width:120px">
          <input data-ti="${i}" data-f="reward" value="${esc(t.reward || '')}" placeholder="奖励文案，如：钥匙×1" style="max-width:120px">
          <select data-ti="${i}" data-f="action" style="max-width:120px">${Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}" ${t.action === k ? 'selected' : ''}>按钮：${v}</option>`).join('')}</select>
          <label style="font-size:12.5px;color:var(--ink2);display:flex;align-items:center;gap:5px"><input type="checkbox" data-ti="${i}" data-f="enabled" ${t.enabled !== false ? 'checked' : ''}>启用</label>
          <button class="btn-ghost" style="padding:4px 12px" data-tdel="${i}">删除</button>
        </div>
        <div class="inline" style="gap:6px;margin-top:6px">
          <input data-ti="${i}" data-f="desc" value="${esc(t.desc || '')}" placeholder="给玩家看的说明" style="flex:1;min-width:150px">
          <input data-ti="${i}" data-f="link" value="${esc(t.link || '')}" placeholder="跳转地址（按钮选「跳转链接」时填）" style="flex:1;min-width:130px">
        </div>
      </div>`).join('') || '<div class="empty">还没有任务，点下方「加一个任务」</div>';
  }
  $('gmTaskRows').addEventListener('input', e => {
    const i = e.target.dataset.ti, f = e.target.dataset.f;
    if (i === undefined || !f) return;
    if (f === 'enabled') TASK_ROWS[i].enabled = e.target.checked;
    else TASK_ROWS[i][f] = e.target.value;
  });
  $('gmTaskRows').addEventListener('click', e => {
    const del = e.target.closest('[data-tdel]');
    if (del) { TASK_ROWS.splice(Number(del.dataset.tdel), 1); paintTaskRows(); }
  });
  $('gmTaskAdd').onclick = () => { TASK_ROWS.push({ id: 'task' + Date.now().toString(36), title: '', desc: '', reward: '', action: 'info', link: '', enabled: true }); paintTaskRows(); };
  $('gmTaskSave').onclick = async () => {
    const rows = TASK_ROWS.map(t => ({ id: t.id, title: t.title, desc: t.desc, reward: t.reward, action: t.action, link: t.link, enabled: !!t.enabled }));
    for (const r of rows) {
      if (!r.title.trim()) { toast('有任务没填名称'); return; }
      if (r.action === 'link' && !/^https?:\/\/|^\//.test(r.link || '')) { toast('「' + r.title + '」选了跳转链接，要填 / 开头或 http 开头的地址'); return; }
    }
    try { await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify({ tasks: rows }) }); toast('任务专区已保存，玩家端立即生效'); loadCfg(); }
    catch (e) { toast(e.message); }
  };

  // ==================== 翻牌概率（表单化，不再写 JSON） ====================
  let PROB = {};
  function normProbIn(p) {
    const conv = t => ({ escape: Number(t.escape) || 0, rows: (t.reward || []).map(r => [r[0], Number(r[1]), Number(r[2])]) });
    return { wave1: conv(p.wave1 || { escape: 30, reward: [] }), wave2: conv(p.wave2 || { escape: 30, reward: [] }), wave3: (p.wave3 || []).map(conv) };
  }
  function probSum(t) { return t.rows.reduce((s, r) => s + (Number(r[2]) || 0), 0) + (Number(t.escape) || 0); }
  function renderProb() {
    const opts = sel => Object.keys(ITEM_LBL).map(k => `<option value="${k}" ${sel === k ? 'selected' : ''}>${ITEM_LBL[k]}</option>`).join('');
    const table = (title, t, gi, ri) => {
      const sum = probSum(t);
      const ok = sum <= 100.5;
      const riAttr = ri !== undefined ? `data-ri="${ri}" ` : '';
      return `<div class="item-card" style="padding:12px 14px">
        <div class="inline" style="justify-content:flex-start;gap:10px">
          <b>${title}</b>
          <label class="mini-lbl" style="flex-direction:row;align-items:center;gap:5px">逃跑率<input data-g="${gi}" ${riAttr}data-f="escape" type="number" min="0" max="100" value="${t.escape}" style="max-width:76px">%</label>
          <span style="flex:1"></span>
          <span style="font-size:12.5px;font-weight:700;color:${ok ? 'var(--green2)' : 'var(--red)'}">合计 ${Math.round(sum * 10) / 10}% ${ok ? '✓' : '（超 100%！）'}</span>
        </div>
        <div style="margin-top:8px">${t.rows.map((r, xi) => `
          <div class="inline" style="gap:6px;margin-top:4px">
            <select data-g="${gi}" ${riAttr}data-xi="${xi}" data-f="type" style="max-width:130px">${opts(r[0])}</select>
            <label class="mini-lbl" style="flex-direction:row;align-items:center;gap:5px">数量<input data-g="${gi}" ${riAttr}data-xi="${xi}" data-f="n" type="number" min="1" value="${r[1]}" style="max-width:70px"></label>
            <label class="mini-lbl" style="flex-direction:row;align-items:center;gap:5px">概率<input data-g="${gi}" ${riAttr}data-xi="${xi}" data-f="p" type="number" min="0" max="100" step="0.5" value="${r[2]}" style="max-width:80px">%</label>
            <span style="flex:1"></span>
            <button class="btn-ghost" style="padding:4px 10px" data-rmrow="${gi}|${ri === undefined ? '' : ri}|${xi}">删</button>
          </div>`).join('')}</div>
        <button class="btn-ghost" style="margin-top:8px;padding:5px 12px" data-addrow="${gi}|${ri === undefined ? '' : ri}">＋ 加一种奖励</button>
      </div>`;
    };
    $('gmProbBox').innerHTML =
      table('第一波（开局）', PROB.wave1, 'wave1') +
      table('第二波', PROB.wave2, 'wave2') +
      PROB.wave3.map((t, i) => table(`第三波 · 第${i + 1}轮（大奖波）`, t, 'wave3', i)).join('') +
      '<div class="sub" style="margin-top:8px">说明：「逃跑率」是玩家翻到"奖励逃跑了"的概率；奖励概率调高、逃跑率就要相应调低。三波各配各的。</div>';
  }
  function getT(g, ri) { return ri === undefined || ri === '' ? PROB[g] : PROB[g][Number(ri)]; }
  $('gmProbBox').addEventListener('input', e => {
    const d = e.target.dataset; if (!d.g || !d.f) return;
    const t = getT(d.g, d.ri); if (!t) return;
    if (d.f === 'escape') t.escape = Number(e.target.value) || 0;
    else if (d.f === 'type') t.rows[Number(d.xi)][0] = e.target.value;
    else if (d.f === 'n') t.rows[Number(d.xi)][1] = Math.max(1, Number(e.target.value) || 1);
    else if (d.f === 'p') t.rows[Number(d.xi)][2] = Math.max(0, Number(e.target.value) || 0);
    renderProb();
  });
  $('gmProbBox').addEventListener('click', e => {
    const rm = e.target.closest('[data-rmrow]');
    if (rm) { const [g, ri, xi] = rm.dataset.rmrow.split('|'); const t = getT(g, ri); t.rows.splice(Number(xi), 1); renderProb(); return; }
    const add = e.target.closest('[data-addrow]');
    if (add) { const [g, ri] = add.dataset.addrow.split('|'); const t = getT(g, ri); if (t.rows.length < 6) { t.rows.push(['frag', 1, 5]); renderProb(); } }
  });
  $('gmProbSave').onclick = async () => {
    $('gmProbErr').textContent = '';
    const build = t => ({ escape: t.escape, reward: t.rows.map(r => [r[0], r[1], r[2]]) });
    for (const [name, t] of [['第一波', PROB.wave1], ['第二波', PROB.wave2], ...PROB.wave3.map((x, i) => [`第三波第${i + 1}轮`, x])]) {
      if (probSum(t) > 100.5) { $('gmProbErr').textContent = name + '的概率合计超过 100%，把某项调低一点再保存'; return; }
    }
    const prob = { wave1: build(PROB.wave1), wave2: build(PROB.wave2), wave3: PROB.wave3.map(build) };
    try { await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify({ prob }) }); toast('概率设置已保存，下一局开始生效'); loadCfg(); }
    catch (e) { $('gmProbErr').textContent = e.message; }
  };
  $('gmProbReset').onclick = async () => {
    if (!confirm('确定把翻牌概率全部还原为默认值？')) return;
    try { await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify({ prob: null }) }); toast('已还原为默认概率'); loadCfg(); }
    catch (e) { toast(e.message); }
  };

  // ==================== 玩家查询 / 发放 ====================
  // 【v23.2】玩家标识支持三种输入：手机号（=登录用户名）/ 7位工号 uid / 玩家ID(users._id)。
  // 原来 direct 传任何字符串去查 game_profiles，输错就是一排 undefined。
  async function resolveUserId(input) {
    const key = String(input || '').trim();
    if (!key) throw new Error('先在上方输入玩家的手机号 / 工号 / ID');
    try {
      const u = await api('/api/admin/find-user/' + encodeURIComponent(key));
      return { id: u.user._id, label: (u.user.name || u.user.phone || '玩家') + (u.user.uid ? '（工号 ' + u.user.uid + '）' : '') };
    } catch (e) {
      // 不是手机号/工号：当作用户 ID 原样使用
      return { id: key, label: '玩家 ID：' + key };
    }
  }
  function profileTable(label, p) {
    const q = x => (x === undefined || x === null) ? 0 : x;
    if (!p) return '<div class="empty">该玩家还没有游戏档案（还没玩过游戏）。<br>可以直接在下方发放道具，系统会自动建档。</div>';
    return `<table><tr><th>钥匙</th><th>魔法球</th><th>碎片</th><th>复活石</th><th>福袋小/中/大</th><th>累计局数</th></tr>
      <tr><td class="num">${q(p.keys)}</td><td class="num">${q(p.balls)}</td><td class="num">${q(p.frags)}</td><td class="num">${q(p.revives)}</td>
      <td class="num">${q(p.bagS)}/${q(p.bagM)}/${q(p.bagL)}</td><td class="num">${q(p.totalGames)}</td></tr></table>`;
  }
  async function findUser() {
    try {
      const u = await resolveUserId($('gmUid').value);
      const p = await api('/api/admin/game-profile/' + encodeURIComponent(u.id));
      $('gmUserBox').innerHTML = '<div class="sub" style="margin-bottom:6px">玩家：' + esc(u.label) + '</div>' + profileTable(u.label, p.profile);
    } catch (e) { $('gmUserBox').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  async function grant() {
    try {
      const u = await resolveUserId($('gmUid').value);
      const r = await api('/api/admin/game-grant', { method: 'POST', body: JSON.stringify({ userId: u.id, item: $('gmGrantItem').value, amount: +$('gmGrantN').value }) });
      toast('发放成功，档案已更新');
      $('gmUserBox').innerHTML = '<div class="sub" style="margin-bottom:6px">玩家：' + esc(u.label) + '</div>' + profileTable(u.label, r.profile);
    } catch (e) { toast(e.message); }
  }

  // ==================== 数据与日志 ====================
  async function loadStats() {
    try {
      const s = await api('/api/admin/activity-stats');
      $('gmStats').innerHTML = `
        <div class="stat"><b>${s.game?.totalPlayers ?? '-'}</b><span>参与玩家</span></div>
        <div class="stat"><b>${s.game?.totalGames ?? '-'}</b><span>累计局数</span></div>
        <div class="stat"><b>${s.game?.playingSessions ?? '-'}</b><span>进行中对局</span></div>
        <div class="stat"><b>${s.game?.totalKeysLeft ?? '-'}</b><span>场外钥匙存量</span></div>
        <div class="stat"><b>${s.game?.totalBallsLeft ?? '-'}</b><span>场外魔法球存量</span></div>
        <div class="stat"><b>${s.checkin?.today ?? '-'}</b><span>今日签到人数</span></div>`;
      const m = await api('/api/admin/activity-maintenance');
      maintOn = !!m.maintenance;
      $('gmMaint').textContent = '维护模式：' + (maintOn ? '开启中(点击关闭)' : '关闭(点击开启)');
    } catch (e) { toast(e.message); }
    try {
      const r = await api('/api/game/admin/redeems?limit=15');
      $('gmRedeems').innerHTML = r.redeems.length
        ? `<table><tr><th>时间</th><th>用户</th><th>商品</th><th>花费球数</th></tr>` +
          r.redeems.map(x => `<tr><td class="num">${cnTime(x.createdAt)}</td><td class="num">${esc(x.userId)}</td><td>${esc(x.name)}</td><td class="num">${x.cost}</td></tr>`).join('') +
          `</table><div style="margin-top:6px;font-size:12px;color:var(--ochre)">近${r.redeems.length}笔合计消耗魔法球 ${r.totalCost} 个</div>`
        : '<div class="empty">暂无兑换记录</div>';
    } catch (e) { $('gmRedeems').textContent = e.message; }
    try {
      const l = await api('/api/game/admin/logs?limit=30');
      $('gmLogs').innerHTML = l.logs.length
        ? `<table><tr><th>时间</th><th>用户</th><th>动作</th><th>详情</th></tr>` +
          l.logs.map(x => `<tr><td class="num">${cnTime(x.createdAt)}</td><td class="num">${esc(x.userId)}</td><td><span class="tag t0">${esc(x.action)}</span></td><td style="word-break:break-all">${esc(JSON.stringify(x.detail || {}))}</td></tr>`).join('') + '</table>'
        : '<div class="empty">暂无日志</div>';
    } catch (e) { $('gmLogs').textContent = e.message; }
  }

  async function loadShanhai() {
    try {
      const j = await api('/api/shanhai/admin/stats');
      $('gmShanhai').innerHTML = j.ok ? `
        <div class="grid3" style="margin-bottom:10px">
          <div class="stat"><b>${j.players}</b><span>山海玩家</span></div>
          <div class="stat"><b>${j.totals?.wins ?? 0}</b><span>累计胜场</span></div>
          <div class="stat"><b>${j.totals?.totalKills ?? 0}</b><span>累计斩妖</span></div>
        </div>
        ${j.top?.length ? `<table><tr><th>写手</th><th>胜场</th><th>局数</th><th>最佳击杀</th></tr>` +
          j.top.map(t => `<tr><td>${esc(t.username || '-')}</td><td class="num">${t.wins}</td><td class="num">${t.plays}</td><td class="num">${t.bestKills ?? '-'}</td></tr>`).join('') + '</table>'
          : '<div class="empty">还没有胜场记录</div>'}`
        : '<div class="empty">加载失败</div>';
    } catch (e) { $('gmShanhai').innerHTML = '<div class="empty">加载失败</div>'; }
  }

  async function cleanup() {
    if (!confirm('确定作废所有进行中的对局？玩家钥匙将退回。')) return;
    try { const r = await api('/api/admin/game-cleanup', { method: 'POST' }); toast('已清理 ' + r.cleaned + ' 局'); loadStats(); }
    catch (e) { toast(e.message); }
  }
  async function toggleMaint() {
    try {
      await api('/api/admin/activity-maintenance', { method: 'POST', body: JSON.stringify({ maintenance: !maintOn }) });
      toast(!maintOn ? '维护模式已开启' : '维护模式已关闭'); maintOn = !maintOn;
      $('gmMaint').textContent = '维护模式：' + (maintOn ? '开启中(点击关闭)' : '关闭(点击开启)');
    } catch (e) { toast(e.message); }
  }

  // ==================== 【v24.0】数据库占用与清理 ====================
  async function loadDb() {
    try {
      const s = await api('/api/admin/db/stats');
      $('gmDbTotal').textContent = s.totalText || '-';
      $('gmDbStats').innerHTML = `<table><tr><th>集合</th><th>文档数</th><th>数据大小</th><th>存储占用</th><th>索引</th></tr>` +
        s.collections.map(c => `<tr><td><code>${esc(c.name)}</code></td><td class="num">${c.count ?? '-'}</td><td class="num">${fmtB(c.size)}</td><td class="num">${fmtB(c.storage)}</td><td class="num">${fmtB(c.indexSize)}</td></tr>`).join('') + '</table>';
    } catch (e) { $('gmDbStats').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
    try {
      const c = await api('/api/admin/db/cleanup-candidates');
      $('gmDbClean').innerHTML = c.candidates.map(x => `
        <div class="item-card" style="padding:10px 14px">
          <div class="inline" style="justify-content:flex-start;gap:10px">
            <b style="min-width:150px">${esc(x.label)}</b>
            <span class="sub" style="flex:1">${x.days} 天前的数据</span>
            <b class="num">${x.count}</b><span class="sub">条</span>
            <input type="number" min="1" value="${x.days}" data-days="${x.target}" style="max-width:76px" title="改成别的天数再点清理">
            <button class="btn-danger" style="padding:5px 14px" data-clean="${x.target}" ${x.count ? '' : 'disabled style="opacity:.5;padding:5px 14px"'}>清理</button>
          </div>
        </div>`).join('');
    } catch (e) { $('gmDbClean').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  const fmtB = n => n == null ? '-' : (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
  $('gmDbReload').onclick = loadDb;

  // ==================== 【v24.8】挂机老玩家激活 ====================
  function renderIdleList(r) {
    $('gmIdleEligible').textContent = r.eligible;
    $('gmIdleActive').textContent = r.eligible - (r.list || []).filter(x => !x.active).length;
    const list = r.list || [];
    $('gmIdleList').innerHTML = list.length
      ? '<table><tr><th>玩家</th><th>已通关</th><th>挂机状态</th></tr>' + list.slice(0, 30).map(x =>
        `<tr><td>${esc(x.username || x.userId.slice(-6))}</td><td class="num">第 ${x.top} 关</td>
         <td>${x.active ? '<span style="color:var(--green2)">已激活 · 计时中</span>' : '<span style="color:#c9a227">未激活</span>'}</td></tr>`).join('') + '</table>'
        + (list.length > 30 ? `<div class="sub" style="margin-top:6px">仅显示前 30 位，共 ${list.length} 位</div>` : '')
      : '<div class="empty">还没有符合条件的玩家（通关第 ' + r.unlockStage + ' 关即可）</div>';
  }
  async function loadIdle() {
    try {
      const r = await api('/api/shanhai/admin/idle-eligible');
      renderIdleList(r);
      if (r.activated > 0) toast('已激活 ' + r.activated + ' 位玩家的挂机计时');
    } catch (e) { $('gmIdleList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  $('gmIdleCheck').onclick = loadIdle;
  $('gmIdleReset').onclick = async () => {
    if (!confirm('把所有符合条件玩家的挂机计时起点设为"现在"？\n\n用于活动开始/回档后重新计时，不会补发历史时长。')) return;
    try {
      const r = await api('/api/shanhai/admin/idle-activate', { method: 'POST', body: JSON.stringify({ reset: true }) });
      renderIdleList(r);
      toast('已对 ' + r.eligible + ' 位玩家重新计时');
    } catch (e) { toast(e.message); }
  };
  $('gmDbClean').addEventListener('click', async e => {
    const btn = e.target.closest('[data-clean]');
    if (!btn) return;
    const target = btn.dataset.clean;
    const days = Number(root.querySelector(`[data-days="${target}"]`).value) || 30;
    if (!confirm('确定删除「' + target + '」中 ' + days + ' 天前的数据？删除后不可恢复。')) return;
    try { const r = await api('/api/admin/db/cleanup', { method: 'POST', body: JSON.stringify({ target, days }) }); toast('已清理 ' + r.deleted + ' 条'); loadDb(); }
    catch (err) { toast(err.message); }
  });

  $('gmRefresh').onclick = () => { loadStats(); loadShanhai(); loadCfg(); };
  $('gmCleanup').onclick = cleanup;
  $('gmMaint').onclick = toggleMaint;
  $('gmSaveCfg').onclick = saveCfg;
  $('gmFind').onclick = findUser;
  $('gmGrant').onclick = grant;

  // ==================== 【v26.17】流派技能树配置 ====================
  // 数据结构与服务端一致：factions[{id,name,icon,desc,starter,branches[{id,name,role,nodes[
  //   {id,name,type,cost,max,eff,desc,req:{node,lv}}]}]}]
  // 紧凑竖向：流派 pill 切换 → 分支块竖排 → 节点一行一条
  let ST = { factions: [], cur: 0, custom: false, adv: false };
  const ST_TYPE = { minor: '属性', special: '特殊', play: '玩法', ultimate: '主动' };
  // 【v26.23 修复】连点"＋加技能"时旧 id 生成规则可能撞车（同一毫秒+随机段重复），
  // 保存被"节点 id 重复"校验拦下——这就是"新建技能后保存失败"的元凶。加自增计数彻底防撞
  let _stUidN = 0;
  const stUid = () => 'n' + Date.now().toString(36).slice(-6) + (++_stUidN) + Math.floor(Math.random() * 90 + 10);

  // ==================== 【v26.24】文本导入/导出（批量配置技能树） ====================
  // 文本格式（竖线分段，缩进表达层级，# 开头是注释）：
  //   流派 万剑流派 | ⚔ | 新手 | 简介...
  //     分支 万剑归宗 | 群体攻击
  //       剑意 | 属性 | 耗1 | 级5 | atk:1 | 攻击力+1
  //       剑芒 | 特殊 | 耗2 | 级3 | crit:2 | 暴击率+2% | 前置:剑意@2
  function exportTreeText() {
    const T = { minor: '属性', special: '特殊', play: '玩法', ultimate: '主动' };
    const lines = ['# 山海技能树配置（竖线分段；改完粘贴回上方点「从文本导入」，或直接发给客服代解析）'];
    for (const f of ST.factions) {
      lines.push(`流派 ${f.name} | ${f.icon || '✦'}${f.starter ? ' | 新手' : ''}${f.desc ? ' | ' + f.desc : ''}`);
      for (const b of (f.branches || [])) {
        lines.push(`  分支 ${b.name}${b.role ? ' | ' + b.role : ''}`);
        for (const n of (b.nodes || [])) {
          let s = `    ${n.name} | ${T[n.type] || n.type || '属性'} | 耗${+n.cost || 0} | 级${+n.max || 1}`;
          const eff = Object.entries(n.eff || {}).map(([k, v]) => k + ':' + v).join(',');
          if (eff) s += ` | ${eff}`;
          if (n.desc) s += ` | ${n.desc}`;
          if (n.req && n.req.node) {
            let rn = n.req.node;
            for (const bb of (f.branches || [])) { const x = (bb.nodes || []).find(y => y.id === n.req.node); if (x) { rn = x.name; break; } }
            s += ` | 前置:${rn}@${n.req.lv || 1}`;
          }
          lines.push(s);
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  function parseTreeText(text) {
    const T2 = { '属性': 'minor', '特殊': 'special', '玩法': 'play', '主动': 'ultimate', minor: 'minor', special: 'special', play: 'play', ultimate: 'ultimate' };
    const factions = [];
    let curF = null, curB = null;
    const oldList = ST.factions || [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      if (/^流派/.test(line)) {
        const parts = line.slice(2).split('|').map(s => s.trim()).filter(s => s !== '');
        const name = parts.shift();
        if (!name) return { err: '流派行缺少名称：' + line };
        const starter = parts.includes('新手');
        const rest = parts.filter(p => p !== '新手');
        let icon = '✦';
        if (rest.length && rest[0].length <= 3) icon = rest.shift();
        const desc = rest.join('｜');
        let f = oldList.find(x => x.name === name);        // 同名沿用旧 id：玩家已学等级/流派选择不丢
        if (!f) f = { id: 'f' + stUid(), name, icon, desc, starter, branches: [] };
        else { f.icon = icon; f.desc = desc; f.starter = starter; f.branches = f.branches || []; }
        if (!factions.includes(f)) factions.push(f);
        curF = f; curB = null;
      } else if (/^分支/.test(line)) {
        if (!curF) return { err: '「分支」行出现在流派之前：' + line };
        const parts = line.slice(2).split('|').map(s => s.trim());
        const name = parts.shift();
        if (!name) return { err: '分支行缺少名称：' + line };
        let b = curF.branches.find(x => x.name === name);
        if (!b) { b = { id: 'b' + stUid(), name, role: '', nodes: [] }; curF.branches.push(b); }
        b.role = parts[0] || '';
        curB = b;
      } else {
        if (!curB) return { err: '技能行出现在分支之前（先写流派和分支行）：' + line };
        const parts = line.replace(/^[-•·]\s*/, '').split('|').map(s => s.trim());
        const name = parts.shift();
        if (!name) return { err: '技能行缺少名称：' + line };
        let type = 'minor', cost = 1, max = 5, effText = '', desc = '', reqName = null, reqLv = 1;
        for (const p of parts) {
          if (/^耗\d/.test(p)) { cost = Math.max(0, parseInt(p.slice(1), 10) || 0); continue; }
          if (/^级\d/.test(p)) { max = Math.max(1, parseInt(p.slice(1), 10) || 1); continue; }
          if (/^前置[:：]/.test(p)) {
            const m = p.slice(3).split(/[@＠]/);
            reqName = (m[0] || '').trim(); reqLv = Math.max(1, parseInt(m[1], 10) || 1);
            continue;
          }
          if (/^[a-zA-Z]{2,20}:\s*-?\d/.test(p)) { effText = effText ? effText + ',' + p : p; continue; }
          if (T2[p]) { type = T2[p]; continue; }
          desc = desc ? desc + '，' + p : p;
        }
        // 同流派同名节点沿用旧 id（改名/改数值不影响已学等级）；若它挂在别的分支则先挪走
        let node = null;
        for (const bb of curF.branches) {
          const i = (bb.nodes || []).findIndex(y => y.name === name);
          if (i >= 0) { node = bb.nodes.splice(i, 1)[0]; break; }
        }
        if (!node) node = { id: stUid() };
        node.name = name; node.type = type; node.cost = cost; node.max = max;
        node.eff = textToEff(effText); node.desc = desc;
        if (reqName) { node._reqName = reqName; node._reqLv = reqLv; }
        else delete node.req;
        curB.nodes.push(node);
      }
    }
    if (!factions.length) return { err: '没有解析到任何流派（第一行应为：流派 名称）' };
    // 前置按技能名解析成节点 id（允许引用后面才出现的技能）
    for (const f of factions) {
      const byName = new Map();
      for (const b of (f.branches || [])) for (const n of (b.nodes || [])) byName.set(n.name, n);
      for (const b of (f.branches || [])) for (const n of (b.nodes || [])) {
        if (!n._reqName) continue;
        const t = byName.get(n._reqName);
        if (!t || t === n) return { err: `流派「${f.name}」里找不到前置技能「${n._reqName}」（检查名字是否写对，不能以自己为前置）` };
        n.req = { node: t.id, lv: n._reqLv || 1 };
        delete n._reqName; delete n._reqLv;
      }
    }
    return { factions };
  }
  // 【v26.23】拖拽排序：正在拖的节点/分支（编辑态内存，保存时按数组顺序落库）
  let STDRAG = null;
  function moveNode(from, to) {
    const f = ST.factions[ST.cur];
    if (!f || !f.branches[from.bi] || !f.branches[to.bi]) return;
    if (from.bi === to.bi && from.ni === to.ni) return;
    const src = f.branches[from.bi].nodes;
    const node = src.splice(from.ni, 1)[0];
    let ni = to.ni;
    if (from.bi === to.bi && from.ni < to.ni) ni -= 1;   // 同列后移：先删后插要回一位
    f.branches[to.bi].nodes.splice(Math.max(0, Math.min(f.branches[to.bi].nodes.length, ni)), 0, node);
  }

  async function loadSkillTree() {
    try {
      const j = await api('/api/shanhai/admin/factions');
      if (!j.ok) throw new Error(j.error || '加载失败');
      ST.factions = j.factions || []; ST.cur = 0; ST.custom = !!j.custom;
      renderSkillTree();
    } catch (e) { $('stEditor').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  function effToText(eff) { return Object.entries(eff || {}).map(([k, v]) => k + ':' + v).join(', '); }
  function textToEff(s) {
    const out = {};
    for (const part of String(s || '').split(/[,，]/)) {
      const seg = part.trim(); if (!seg) continue;
      const i = seg.indexOf(':'); if (i < 1) continue;
      const k = seg.slice(0, i).trim(), v = Number(seg.slice(i + 1).trim());
      if (/^[a-zA-Z]{2,20}$/.test(k) && Number.isFinite(v)) out[k] = v;
    }
    return out;
  }

  function renderSkillTree() {
    const tabs = $('stTabs');
    tabs.innerHTML = ST.factions.map((f, i) =>
      `<button data-i="${i}" class="${i === ST.cur ? 'on' : ''}">${esc(f.icon || '✦')} ${esc(f.name)}${f.starter ? '（新手）' : ''}</button>`).join('');
    tabs.querySelectorAll('button').forEach(b => b.onclick = () => { ST.cur = +b.dataset.i; renderSkillTree(); });
    const f = ST.factions[ST.cur];
    if (!f) { $('stEditor').innerHTML = '<div class="empty">没有流派，点"新增流派"开始</div>'; return; }
    const nodeOpts = fid => {
      const ff = ST.factions[fid];
      let out = '<option value="">无前置</option>';
      for (const b of (ff.branches || [])) for (const n of (b.nodes || [])) {
        out += `<option value="${esc(n.id)}">${esc(n.id)} · ${esc(n.name)}</option>`;
      }
      return out;
    };
    $('stEditor').innerHTML = `
      <div class="st-fhead">
        <label>ID <input data-f="id" value="${esc(f.id)}" style="width:110px"></label>
        <label>名称 <input data-f="name" value="${esc(f.name)}" style="width:130px"></label>
        <label>图标 <input data-f="icon" value="${esc(f.icon || '')}" style="width:44px"></label>
        <label>简介 <input data-f="desc" value="${esc(f.desc || '')}" style="flex:1;min-width:160px"></label>
        <label><input type="checkbox" data-f="starter" ${f.starter ? 'checked' : ''}> 新手流派</label>
        <label class="st-adv-toggle"><input type="checkbox" data-adv ${ST.adv ? 'checked' : ''}> 高级设置</label>
      </div>
      <div class="st-rail"></div>
      <div class="st-cols">
      ${(f.branches || []).map((b, bi) => `
      <div class="st-col">
        <div class="st-colhead" draggable="true" data-b="${bi}" title="按住此处拖动，可左右调整分支顺序">
          <input data-b="${bi}" data-k="name" value="${esc(b.name)}" placeholder="分支名" title="分支名称">
          <input data-b="${bi}" data-k="role" value="${esc(b.role || '')}" placeholder="定位" title="定位说明">
          <button class="st-del" data-act="delBranch" data-b="${bi}" title="删除整个分支">✕</button>
        </div>
        ${(b.nodes || []).map((n, ni) => `
        <div class="st-card" draggable="true" data-b="${bi}" data-n="${ni}">
          <div class="st-line">
            <input data-n="${bi}_${ni}" data-k="name" value="${esc(n.name)}" placeholder="技能名" title="技能名（节点 id: ${esc(n.id)}）">
            <label class="st-lbl" title="最高可升级等级">级<input data-n="${bi}_${ni}" data-k="max" type="number" min="1" max="50" value="${+n.max || 1}"></label>
            <button class="st-del" data-act="delNode" data-b="${bi}" data-n="${ni}" title="删除该技能">✕</button>
          </div>
          <div class="st-line">
            <select data-n="${bi}_${ni}" data-k="reqNode" title="前置技能：选了之后，前置技能达到指定等级才能学本技能">${nodeOpts(ST.cur).replace(`value="${esc((n.req || {}).node || '')}"`, `value="${esc((n.req || {}).node || '')}" selected`)}</select>
            ${(n.req && n.req.node) ? `<label class="st-lbl" title="前置技能需达到的等级">需<input data-n="${bi}_${ni}" data-k="reqLv" type="number" min="1" max="50" value="${(n.req || {}).lv || 1}"></label>` : ''}
          </div>
          <div class="st-adv" style="${ST.adv ? '' : 'display:none'}">
            <div class="st-line">
              <select data-n="${bi}_${ni}" data-k="type" title="节点类型">${Object.entries(ST_TYPE).map(([k, v]) => `<option value="${k}" ${n.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
              <label class="st-lbl" title="每次学习消耗天赋点">耗<input data-n="${bi}_${ni}" data-k="cost" type="number" min="0" max="20" value="${+n.cost || 0}"></label>
            </div>
            <input class="st-wide" data-n="${bi}_${ni}" data-k="eff" value="${esc(effToText(n.eff))}" placeholder="加成：atk:2, crit:3">
            <input class="st-wide" data-n="${bi}_${ni}" data-k="desc" value="${esc(n.desc || '')}" placeholder="说明（玩家可见）">
          </div>
        </div>`).join('')}
        <button class="st-mini st-add" data-act="addNode" data-b="${bi}">＋ 加技能</button>
      </div>`).join('')}
      <div class="st-col st-coladd"><button class="st-mini" data-act="addBranch" title="新增一个分支列；把新列第一个技能的「前置」指向某个节点，就能实现从该节点分叉出多个方向">＋ 加分支</button></div>
      </div>`;
    bindSkillTree();
  }

  function bindSkillTree() {
    const f = ST.factions[ST.cur];
    if (!f) return;
    const ed = $('stEditor');
    // 【v26.22】高级设置开关：默认只显示"技能名/最高等级/前置"，勾选后才展开类型/消耗/加成/说明
    const adv = ed.querySelector('[data-adv]');
    if (adv) adv.onchange = () => { ST.adv = adv.checked; renderSkillTree(); };
    // 流派头
    ed.querySelectorAll('[data-f]').forEach(el => {
      const k = el.dataset.f;
      const apply = () => {
        if (k === 'starter') f.starter = el.checked;
        else f[k] = el.value;
      };
      el.onchange = apply; if (el.type === 'text' || el.type === 'checkbox') el.oninput = apply;
    });
    // 分支头
    ed.querySelectorAll('[data-b][data-k]').forEach(el => {
      el.oninput = el.onchange = () => { f.branches[+el.dataset.b][el.dataset.k] = el.value; };
    });
    // 节点行（key 形如 bi_ni）
    ed.querySelectorAll('[data-n][data-k]').forEach(el => {
      const [bi, ni] = el.dataset.n.split('_').map(Number);
      el.oninput = el.onchange = () => {
        const n = f.branches[bi].nodes[ni];
        const k = el.dataset.k;
        if (k === 'cost') n.cost = Math.max(0, Math.round(+el.value || 0));
        else if (k === 'max') n.max = Math.max(1, Math.round(+el.value || 1));
        else if (k === 'reqNode') {
          if (el.value) { n.req = { node: el.value, lv: Math.max(1, (n.req || {}).lv || 1) }; }
          else delete n.req;
          // 联动启停前置等级输入框（只重渲，保持简单）
          renderSkillTree();
        }
        else if (k === 'reqLv') { n.req = n.req || { node: '', lv: 1 }; n.req.lv = Math.max(1, Math.round(+el.value || 1)); }
        else if (k === 'eff') n.eff = textToEff(el.value);
        else n[k] = el.value;
      };
    });
    // 按钮（增删）
    ed.querySelectorAll('[data-act]').forEach(el => {
      el.onclick = () => {
        const act = el.dataset.act, bi = +el.dataset.b, ni = +el.dataset.n;
        if (act === 'addBranch') f.branches.push({ id: stUid() + 'b', name: '新分支', role: '', nodes: [{ id: stUid(), name: '新技能', type: 'minor', cost: 1, max: 5, eff: { atk: 1 }, desc: '' }] });
        else if (act === 'delBranch') { if (f.branches.length <= 1) return toast('至少保留一个分支'); if (!confirm('删除该分支及其全部技能？')) return; f.branches.splice(bi, 1); }
        else if (act === 'addNode') f.branches[bi].nodes.push({ id: stUid(), name: '新技能', type: 'minor', cost: 1, max: 5, eff: { atk: 1 }, desc: '' });
        else if (act === 'delNode') { if (f.branches[bi].nodes.length <= 1) return toast('分支至少保留一个技能'); f.branches[bi].nodes.splice(ni, 1); }
        renderSkillTree();
      };
    });
    // 【v26.23】拖拽排序：节点卡可拖（同列排序 / 跨列移动），分支列头可拖（左右调顺序）
    ed.querySelectorAll('.st-card').forEach(card => {
      card.addEventListener('dragstart', e => {
        if (e.target.closest('input,select,button')) { e.preventDefault(); return; }   // 输入框内选字不触发卡片拖拽
        STDRAG = { kind: 'n', bi: +card.dataset.b, ni: +card.dataset.n };
        card.classList.add('st-dragging');
        try { e.dataTransfer.effectAllowed = 'move'; } catch (err) { }
      });
      card.addEventListener('dragend', () => { card.classList.remove('st-dragging'); ed.querySelectorAll('.st-over').forEach(x => x.classList.remove('st-over')); STDRAG = null; });
      card.addEventListener('dragover', e => { if (STDRAG && STDRAG.kind === 'n') { e.preventDefault(); card.classList.add('st-over'); } });
      card.addEventListener('dragleave', () => card.classList.remove('st-over'));
      card.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        card.classList.remove('st-over');
        if (!STDRAG || STDRAG.kind !== 'n') return;
        moveNode(STDRAG, { bi: +card.dataset.b, ni: +card.dataset.n });
        STDRAG = null;
        renderSkillTree();
      });
    });
    ed.querySelectorAll('.st-col').forEach(col => {
      col.addEventListener('dragover', e => { if (STDRAG) e.preventDefault(); });
      col.addEventListener('drop', e => {
        e.preventDefault();
        if (!STDRAG) return;
        const toBi = +col.dataset.b;
        if (Number.isNaN(toBi)) return;
        if (STDRAG.kind === 'n') {
          // 落到列空白处 → 移到该列末尾
          if (!(STDRAG.bi === toBi && STDRAG.ni === f.branches[toBi].nodes.length)) {
            const node = f.branches[STDRAG.bi].nodes.splice(STDRAG.ni, 1)[0];
            f.branches[toBi].nodes.push(node);
            renderSkillTree();
          }
        } else if (STDRAG.bi !== toBi) {
          const br = f.branches.splice(STDRAG.bi, 1)[0];
          let at = toBi;
          if (STDRAG.bi < toBi) at -= 1;
          f.branches.splice(at, 0, br);
          renderSkillTree();
        }
        STDRAG = null;
      });
    });
    ed.querySelectorAll('.st-colhead').forEach(head => {
      head.addEventListener('dragstart', e => {
        if (e.target.closest('input,select,button')) { e.preventDefault(); return; }
        STDRAG = { kind: 'b', bi: +head.dataset.b };
        head.classList.add('st-dragging');
        try { e.dataTransfer.effectAllowed = 'move'; } catch (err) { }
      });
      head.addEventListener('dragend', () => { head.classList.remove('st-dragging'); STDRAG = null; });
    });
  }

  $('stSave').onclick = async () => {
    try {
      const j = await api('/api/shanhai/admin/factions', { method: 'PUT', body: JSON.stringify({ factions: ST.factions }) });
      if (!j.ok) throw new Error(j.error || '保存失败');
      toast('技能树已保存，玩家端即时生效');
    } catch (e) { toast(e.message); }
  };
  $('stReset').onclick = async () => {
    if (!confirm('恢复为系统默认技能树？当前自定义配置将被清除（玩家已学等级保留，但节点若在默认树中不存在将不再生效）。')) return;
    try {
      const j = await api('/api/shanhai/admin/factions/reset', { method: 'POST', body: '{}' });
      if (!j.ok) throw new Error(j.error || '操作失败');
      ST.factions = j.factions || []; ST.cur = 0; ST.custom = false;
      renderSkillTree();
      toast('已恢复默认技能树');
    } catch (e) { toast(e.message); }
  };
  $('stAddFaction').onclick = () => {
    ST.factions.push({ id: 'f' + stUid(), name: '新流派', icon: '✦', desc: '', starter: false, branches: [
      { id: 'b' + stUid(), name: '主修', role: '', nodes: [{ id: stUid(), name: '新技能', type: 'minor', cost: 1, max: 5, eff: { atk: 1 }, desc: '' }] },
    ] });
    ST.cur = ST.factions.length - 1;
    renderSkillTree();
  };
  // 【v26.24】文本导入/导出
  $('stExport').onclick = () => {
    const ta = $('stIOText');
    ta.style.display = 'block';
    ta.value = exportTreeText();
    ta.focus(); ta.select();
    toast('已导出当前技能树文本，可直接修改或复制');
  };
  $('stImport').onclick = () => {
    const ta = $('stIOText');
    ta.style.display = 'block';
    if (!ta.value.trim()) return toast('请先在文本框里粘贴/编写配置');
    const r = parseTreeText(ta.value);
    if (r.err) return toast('导入失败：' + r.err);
    ST.factions = r.factions; ST.cur = 0;
    renderSkillTree();
    toast('已导入到编辑器，请检查无误后点「保存技能树」');
  };

  // ==================== 【v26.25】活动管理（维护锁 + 测试账号 + 活动增删改排序） ====================
  // 【v26.29】时间显示统一按北京时间（+8）格式化，与录入口径一致（此前用浏览器本地时区会偏移）
  const dts = v => { const d = new Date(v); if (isNaN(d)) return ''; return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16); };
  let ACTROWS = [];

  async function loadActMgr() {
    try {
      const j = await api('/api/shanhai/admin/activities');
      if (!j.ok) throw new Error(j.error || '加载失败');
      $('actLock').value = j.sys.locked ? '1' : '0';
      $('actTesters').value = (j.sys.testAccounts || []).join(',');
      $('ddBeta').value = j.sys.duiduileBeta ? '1' : '0';
      ACTROWS = j.list;
      renderActRows();
    } catch (e) { $('actList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  function renderActRows() {
    $('actList').innerHTML = ACTROWS.length
      ? ACTROWS.map((a, i) => `
      <div class="act-row" data-i="${i}">
        <div class="line">
          <label>标题<input data-k="title" value="${esc(a.title)}" style="width:170px"></label>
          <label>类型
            <select data-k="type">
              <option value="" ${!a.type ? 'selected' : ''}>普通活动</option>
              <option value="duiduile" ${a.type === 'duiduile' ? 'selected' : ''}>灵气堆堆乐</option>
            </select>
          </label>
          <label>角标<input data-k="tag" value="${esc(a.tag || '')}" style="width:70px" title="列表里的小字，如：限时/中秋"></label>
          <label>启用<input type="checkbox" data-k="enabled" ${a.enabled ? 'checked' : ''}></label>
          <span class="${a.enabled ? 'act-badge-on' : 'act-badge-off'}">${a.enabled ? '展示中' : '已停用'}</span>
          <span style="flex:1"></span>
          <button class="st-mini" data-act="up" data-i="${i}" title="上移">↑</button>
          <button class="st-mini" data-act="down" data-i="${i}" title="下移">↓</button>
          <button class="st-mini" data-act="save" data-i="${i}">保存</button>
          <button class="st-mini" data-act="del" data-i="${i}" style="color:#b3452f">删除</button>
        </div>
        <div class="line">
          <label>图片地址（可选，活动页顶部横幅）<input data-k="img" value="${esc(a.img || '')}" placeholder="/games/shanhai/assets/activity/banner.png" style="flex:1;min-width:220px"></label>
        </div>
        <div class="line">
          <label>开始<input data-k="start" type="datetime-local" value="${dts(a.start)}"></label>
          <label>结束<input data-k="end" type="datetime-local" value="${dts(a.end)}"></label>
          <span class="sub" style="flex:1">留空表示不限时间；时间未到/已结束的活动不会出现在玩家端</span>
        </div>
        <div class="line">
          <label style="flex:1">活动内容（换行即分段，玩家端原样展示）<textarea data-k="content" rows="4">${esc(a.content || '')}</textarea></label>
        </div>
      </div>`).join('')
      : '<div class="empty">还没有活动，点「＋ 新增活动」创建</div>';
    // 行内编辑 → 内存
    $('actList').querySelectorAll('.act-row').forEach(row => {
      const i = +row.dataset.i;
      row.querySelectorAll('[data-k]').forEach(el => {
        const apply = () => {
          if (el.dataset.k === 'enabled') ACTROWS[i][el.dataset.k] = el.checked;
          else ACTROWS[i][el.dataset.k] = el.value;
        };
        el.onchange = apply;
        if (el.type !== 'checkbox') el.oninput = apply;
      });
    });
    $('actList').querySelectorAll('[data-act]').forEach(btn => {
      btn.onclick = async () => {
        const act = btn.dataset.act, i = +btn.dataset.i;
        if (act === 'save') {
          const a = ACTROWS[i];
          try {
            const j = await api('/api/shanhai/admin/activities/save', { method: 'POST', body: JSON.stringify(a) });
            if (!j.ok) throw new Error(j.error || '保存失败');
            toast('活动已保存'); loadActMgr();
          } catch (e) { toast(e.message); }
        } else if (act === 'del') {
          if (!confirm('删除活动「' + (ACTROWS[i].title || '未命名') + '」？')) return;
          if (!ACTROWS[i].id) { ACTROWS.splice(i, 1); renderActRows(); return; }
          try {
            const j = await api('/api/shanhai/admin/activities/del', { method: 'POST', body: JSON.stringify({ id: ACTROWS[i].id }) });
            if (!j.ok) throw new Error(j.error || '删除失败');
            toast('已删除'); loadActMgr();
          } catch (e) { toast(e.message); }
        } else if (act === 'up' || act === 'down') {
          const j = act === 'up' ? i - 1 : i + 1;
          if (j < 0 || j >= ACTROWS.length) return;
          [ACTROWS[i], ACTROWS[j]] = [ACTROWS[j], ACTROWS[i]];
          const ids = ACTROWS.map(x => x.id).filter(Boolean);
          try { await api('/api/shanhai/admin/activities/reorder', { method: 'POST', body: JSON.stringify({ ids }) }); } catch (e) { }
          renderActRows();
        }
      };
    });
  }

  $('actSysSave').onclick = async () => {
    try {
      const j = await api('/api/shanhai/admin/activity-sys', {
        method: 'POST',
        body: JSON.stringify({ locked: $('actLock').value === '1', testAccounts: $('actTesters').value, duiduileBeta: $('ddBeta').value === '1' }),
      });
      if (!j.ok) throw new Error(j.error || '保存失败');
      toast('维护设置已保存（玩家端入口立即生效）');
    } catch (e) { toast(e.message); }
  };
  $('ddClean').onclick = async () => {
    const who = $('ddCleanUser').value.trim();
    if (!confirm(who ? `清掉「${who}」的堆堆乐参与记录？（其免费/加成次数将重置）` : '确定清空【全部】堆堆乐参与记录？')) return;
    try {
      const j = await api('/api/shanhai/admin/duiduile/cleanup', { method: 'POST', body: JSON.stringify({ username: who }) });
      if (!j.ok) throw new Error(j.error || '清理失败');
      toast('已清理 ' + j.deleted + ' 条参与记录');
    } catch (e) { toast(e.message); }
  };
  // 【v26.30】检索用户 → 一键加入/移出测试名单（免去手打名单猜名字）
  $('ddFindBtn').onclick = async () => {
    const q = $('ddFind').value.trim();
    if (!q) return toast('请输入用户名或工号');
    const out = $('ddFindOut');
    out.textContent = '查询中…';
    try {
      const j = await api('/api/shanhai/admin/activities/finduser', { method: 'POST', body: JSON.stringify({ q }) });
      if (!j.ok) throw new Error(j.error || '查询失败');
      if (!j.found) { out.innerHTML = `<span style="color:#b3452f">没找到「${esc(q)}」，确认是玩家登录的用户名或 7 位工号</span>`; return; }
      const u = j.user;
      out.innerHTML = `找到：<b>${esc(u.displayName)}</b>（用户名 ${esc(u.username)}${u.uid ? ' / 工号 ' + esc(u.uid) : ''} · ${u.role === 'admin' ? '管理员' : u.role === 'writer' ? '写手' : '用户'}）　` +
        `<button class="st-mini" id="ddToggleTester">${j.inList ? '移出测试名单' : '✓ 锁定为测试员'}</button>`;
      out.querySelector('#ddToggleTester').onclick = async () => {
        let list = $('actTesters').value.split(/[,，\s]+/).filter(Boolean);
        if (j.inList) list = list.filter(x => x !== u.username && x !== String(u.uid || ''));
        else { list.push(u.username); if (u.uid) list.push(String(u.uid)); }
        $('actTesters').value = list.join(',');
        $('actSysSave').onclick();
        j.inList = !j.inList;
        $('ddFindBtn').onclick();
      };
    } catch (e) { out.textContent = e.message; }
  };
  $('ddFind').addEventListener('keydown', e => { if (e.key === 'Enter') $('ddFindBtn').onclick(); });
  $('actAdd').onclick = () => {
    ACTROWS.unshift({ id: '', title: '新活动', tag: '', img: '', content: '活动说明……', start: '', end: '', enabled: false });
    renderActRows();
    toast('已添加草稿（默认停用），填写后点该行的「保存」');
  };
  $('actReload').onclick = loadActMgr;

  $('gmRefresh').onclick = () => { loadStats(); loadShanhai(); loadCfg(); loadSkillTree(); loadActMgr(); };
  loadStats(); loadShanhai(); loadCfg(); loadDb(); loadIdle(); loadSkillTree(); loadActMgr();
  return { refresh: () => { loadStats(); loadShanhai(); loadCfg(); loadDb(); loadIdle(); loadSkillTree(); loadActMgr(); } };
}
