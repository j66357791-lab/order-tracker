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
        <div class="inline"><input id="gmUid" placeholder="玩家 ID（userId）"><button class="btn-main" id="gmFind">查询背包</button></div>
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
  </div>

  <!-- ============ 区三：数据与日志 ============ -->
  <div id="gmZone-data" style="display:none">
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
  async function findUser() {
    try {
      const p = await api('/api/admin/game-profile/' + $('gmUid').value.trim());
      $('gmUserBox').innerHTML = `<table><tr><th>钥匙</th><th>魔法球</th><th>碎片</th><th>复活石</th><th>福袋小/中/大</th><th>累计局数</th></tr>
        <tr><td class="num">${p.profile.keys}</td><td class="num">${p.profile.balls}</td><td class="num">${p.profile.frags}</td><td class="num">${p.profile.revives}</td>
        <td class="num">${p.profile.bagS}/${p.profile.bagM}/${p.profile.bagL}</td><td class="num">${p.profile.totalGames ?? '-'}</td></tr></table>`;
    } catch (e) { $('gmUserBox').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  async function grant() {
    try {
      await api('/api/admin/game-grant', { method: 'POST', body: JSON.stringify({ userId: $('gmUid').value.trim(), item: $('gmGrantItem').value, amount: +$('gmGrantN').value }) });
      toast('发放成功'); findUser();
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

  $('gmRefresh').onclick = () => { loadStats(); loadShanhai(); loadCfg(); };
  $('gmCleanup').onclick = cleanup;
  $('gmMaint').onclick = toggleMaint;
  $('gmSaveCfg').onclick = saveCfg;
  $('gmFind').onclick = findUser;
  $('gmGrant').onclick = grant;

  loadStats(); loadShanhai(); loadCfg();
  return { refresh: () => { loadStats(); loadShanhai(); loadCfg(); } };
}
