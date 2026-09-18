// admin/mod-game.js — 游戏控制器面板（方案二第二步迁入）
// 合并来源：admin_game.html 全部功能 + dispatch.html 游戏工作台的山海数据块
import { api, esc, toast, cnTime } from './app.js';

export function mount(root) {
  root.innerHTML = `
  <div class="content-head">
    <div><h1 class="serif">游戏控制器</h1><div class="sub">翻翻乐活动配置热调 / 维护开关 / 道具发放 / 山海数据 —— 改动即时生效</div></div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="gmRefresh">刷新数据</button>
  </div>

  <div class="card">
    <h2 class="serif">翻翻乐数据总览</h2>
    <div class="sub">参与 / 存量 / 签到实时统计</div>
    <div class="grid3" id="gmStats"><div class="empty">加载中…</div></div>
    <div class="inline" style="margin-top:14px">
      <button class="btn-danger" id="gmCleanup">清场：作废所有进行中对局并退钥匙</button>
      <button class="btn-ghost" id="gmMaint">维护模式：读取中</button>
    </div>
  </div>

  <div class="card">
    <h2 class="serif">山海斩妖录数据</h2>
    <div class="sub">玩家总量 / 胜场 / 顶榜写手（原派单工作台数据块并入）</div>
    <div id="gmShanhai"><div class="empty">加载中…</div></div>
  </div>

  <div class="card">
    <h2 class="serif">游戏管控 · 魔法翻翻乐</h2>
    <div class="sub">改动即时生效，无需重启；商铺 / 任务专区 / 掉落概率都在这里配，前台游戏页即时跟随</div>
    <div class="tabs" id="gmCfgTabs" style="margin:10px 0 14px">
      <button data-t="base" class="on">基础</button>
      <button data-t="shop">🛒 魔法商铺</button>
      <button data-t="tasks">📋 任务专区</button>
      <button data-t="prob">🎲 掉落概率</button>
    </div>

    <div id="gmCfgBase">
      <div class="inline"><input id="gmCfgStart" placeholder="活动开始 2026-09-12"><input id="gmCfgEnd" placeholder="活动结束 2026-10-31"></div>
      <div class="inline" style="margin-top:8px"><input id="gmCfgDaily" type="number" placeholder="每日免费钥匙"><input id="gmCfgRevive" type="number" placeholder="每局复活上限"><input id="gmCfgCompose" type="number" placeholder="合成球需碎片"></div>
      <div class="inline" style="margin-top:8px"><input id="gmCfgBagS" placeholder="小福袋(元) 0.30,0.88"><input id="gmCfgBagM" placeholder="中福袋(元) 1.68,8.88"><input id="gmCfgBagL" placeholder="大福袋(元) 18.88,88.88"></div>
      <div style="margin-top:12px"><button class="btn-main" id="gmSaveCfg">保存基础配置</button></div>
    </div>

    <div id="gmCfgShop" style="display:none">
      <div class="sub">用<b>魔法球</b>兑换的商品。内容写法：<code>frags=10</code> 或 <code>keys=5;revives=1</code>（可发的道具：frags/keys/balls/revives/bagS/bagM/bagL）。取消勾选"上架"即在前台隐藏。</div>
      <div id="gmShopRows"></div>
      <div class="inline" style="margin-top:10px">
        <button class="btn-ghost" id="gmShopAdd">＋ 新增商品</button>
        <span style="flex:1"></span>
        <button class="btn-main" id="gmShopSave">保存商铺</button>
      </div>
    </div>

    <div id="gmCfgTasks" style="display:none">
      <div class="sub">任务专区展示条目。动作类型：<b>daily</b>=每日领取（走每日钥匙接口）· <b>play</b>=去翻牌 · <b>bags</b>=去拆福袋 · <b>link</b>=跳转链接 · <b>info</b>=纯展示</div>
      <div id="gmTaskRows"></div>
      <div class="inline" style="margin-top:10px">
        <button class="btn-ghost" id="gmTaskAdd">＋ 新增任务</button>
        <span style="flex:1"></span>
        <button class="btn-main" id="gmTaskSave">保存任务专区</button>
      </div>
    </div>

    <div id="gmCfgProb" style="display:none">
      <div class="sub">三波翻牌的掉落概率。每张表：<code>escape</code>=逃跑率%，<code>reward</code>=奖励项数组 [类型, 数量, 概率%]，类型 frags/key/ball/bagS/bagM/bagL 之一；每张表 合计 ≤ 100。第三波 5 个轮次逐轮加码。</div>
      <textarea id="gmProbJson" rows="16" style="width:100%;font-family:Consolas,monospace;font-size:12px"></textarea>
      <div class="err" id="gmProbErr"></div>
      <div class="inline" style="margin-top:10px">
        <button class="btn-main" id="gmProbSave">校验并保存概率表</button>
        <button class="btn-ghost" id="gmProbReset">还原为代码默认值</button>
      </div>
      <div class="sub" id="gmProbNow" style="margin-top:10px"></div>
    </div>
  </div>

  <div class="card">
    <h2 class="serif">玩家查询与道具发放</h2>
    <div class="sub">按用户ID（userId）查询背包；发放负数 = 扣除</div>
    <div class="inline"><input id="gmUid" placeholder="用户ID(userId)"><button class="btn-main" id="gmFind">查询背包</button></div>
    <div id="gmUserBox" style="margin-top:10px"></div>
    <div class="inline" style="margin-top:10px">
      <select id="gmGrantItem" style="max-width:160px">
        <option value="keys">魔法钥匙</option><option value="balls">魔法球</option>
        <option value="frags">碎片</option><option value="revives">复活石</option>
        <option value="bagS">福袋·小</option><option value="bagM">福袋·中</option><option value="bagL">福袋·大</option>
      </select>
      <input id="gmGrantN" type="number" value="1" style="max-width:90px">
      <button class="btn-main" id="gmGrant">发放（负数为扣除）</button>
    </div>
  </div>

  <div class="card">
    <h2 class="serif">兑换记录</h2>
    <div class="sub">最近 15 笔</div>
    <div id="gmRedeems"><div class="empty">加载中…</div></div>
  </div>

  <div class="card">
    <h2 class="serif">审计日志</h2>
    <div class="sub">最近 30 条关键动作</div>
    <div id="gmLogs"><div class="empty">加载中…</div></div>
  </div>`;

  const $ = id => root.querySelector('#' + id);
  let maintOn = false;
  let CFG = null;

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

  async function loadCfg() {
    try {
      const c = await api('/api/game/admin/config');
      const e = c.effective;
      $('gmCfgStart').value = e.start; $('gmCfgEnd').value = e.end;
      $('gmCfgDaily').value = e.dailyFreeKey; $('gmCfgRevive').value = e.maxRevivesPerGame; $('gmCfgCompose').value = e.composeFragCost;
      $('gmCfgBagS').value = e.bagS.join(','); $('gmCfgBagM').value = e.bagM.join(','); $('gmCfgBagL').value = e.bagL.join(',');
      CFG = c;
      renderShopRows(c.shop || []);
      renderTaskRows(c.tasks || []);
      $('gmProbJson').value = JSON.stringify(c.prob || {}, null, 2);
      $('gmProbNow').innerHTML = probSummary(c.prob);
    } catch (e) { toast(e.message); }
  }

  // ---------- 页签 ----------
  function showTab(t) {
    root.querySelectorAll('#gmCfgTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    for (const k of ['base', 'shop', 'tasks', 'prob']) $('gmCfg' + k[0].toUpperCase() + k.slice(1)).style.display = k === t ? '' : 'none';
  }
  root.querySelectorAll('#gmCfgTabs button').forEach(b => { b.onclick = () => showTab(b.dataset.t); });

  // ---------- 魔法商铺 ----------
  const ICONS = ['frag', 'key', 'ball', 'revive', 'bagS', 'bagM', 'bagL'];
  let SHOP_ROWS = [];
  function renderShopRows(list) {
    // give 统一成文本（"frags=10;keys=1"）：接口返回的是对象，编辑后是字符串，保存时只认一种形态
    SHOP_ROWS = list.map(x => Object.assign({}, x, { give: giveText(x.give) }));
    paintShopRows();
  }
  function paintShopRows() {
    $('gmShopRows').innerHTML = SHOP_ROWS.map((s, i) => `
      <div class="item-card" style="padding:10px 12px">
        <div class="inline" style="gap:6px">
          <input data-i="${i}" data-f="name" value="${esc(s.name)}" placeholder="商品名" style="flex:2;min-width:110px">
          <select data-i="${i}" data-f="icon" style="max-width:110px">${ICONS.map(k => `<option value="${k}" ${s.icon === k ? 'selected' : ''}>${{ frag: '碎片', key: '钥匙', ball: '魔法球', revive: '复活石', bagS: '福袋小', bagM: '福袋中', bagL: '福袋大' }[k]}</option>`).join('')}</select>
          <input data-i="${i}" data-f="cost" type="number" min="0" value="${s.cost ?? 0}" placeholder="魔法球" style="max-width:88px" title="所需魔法球">
        </div>
        <div class="inline" style="gap:6px;margin-top:6px">
          <input data-i="${i}" data-f="give" value="${esc(giveText(s.give))}" placeholder="内容 frags=10 或 keys=5;revives=1" style="flex:1;min-width:150px">
          <input data-i="${i}" data-f="desc" value="${esc(s.desc || '')}" placeholder="说明(选填)" style="flex:1;min-width:120px">
        </div>
        <div class="inline" style="gap:6px;margin-top:6px;justify-content:flex-end">
          <label style="font-size:12.5px;color:var(--ink2);display:flex;align-items:center;gap:5px"><input type="checkbox" data-i="${i}" data-f="enabled" ${s.enabled !== false ? 'checked' : ''}>上架</label>
          <button class="btn-ghost" style="padding:4px 12px" data-del="${i}">删除</button>
        </div>
      </div>`).join('') || '<div class="empty">还没有商品，点下方新增</div>';
  }
  const giveText = g => Object.entries(g || {}).map(([k, v]) => k + '=' + v).join(';');
  function parseGive(txt) {
    const g = {};
    for (const part of String(txt || '').split(/[;；]/)) {
      const seg = part.trim(); if (!seg) continue;
      const m = seg.match(/^(frags|keys|balls|revives|bagS|bagM|bagL)\s*[=:：]\s*(\d+)$/i);
      if (!m) return null;
      g[m[1]] = Number(m[2]);
    }
    return g;
  }
  $('gmShopRows').addEventListener('input', e => {
    const i = e.target.dataset.i, f = e.target.dataset.f;
    if (i === undefined || !f) return;
    if (f === 'enabled') SHOP_ROWS[i].enabled = e.target.checked;
    else SHOP_ROWS[i][f] = e.target.value;
  });
  $('gmShopRows').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { SHOP_ROWS.splice(Number(del.dataset.del), 1); paintShopRows(); }
  });
  $('gmShopAdd').onclick = () => { SHOP_ROWS.push({ id: 'item' + Date.now().toString(36), name: '', icon: 'ball', cost: 1, give: { frags: 1 }, desc: '', enabled: true }); paintShopRows(); };
  $('gmShopSave').onclick = async () => {
    const rows = SHOP_ROWS.map(s => ({
      id: s.id, name: s.name, icon: s.icon, cost: Number(s.cost) || 0,
      give: parseGive(s.give), desc: s.desc, enabled: !!s.enabled,
    }));
    for (const r of rows) {
      if (!r.name.trim()) { toast('有商品没填名称'); return; }
      if (r.give === null) { toast('「' + r.name + '」的内容格式不对，应如 frags=10 或 keys=5;revives=1'); return; }
      if (!Object.keys(r.give).length && r.enabled) { toast('「' + r.name + '」没写发放内容，先取消上架或补上'); return; }
    }
    try { await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify({ shop: rows }) }); toast('商铺已保存并即时生效'); loadCfg(); }
    catch (e) { toast(e.message); }
  };

  // ---------- 任务专区 ----------
  const ACTIONS = { daily: '每日领取', play: '去翻牌', bags: '去拆福袋', link: '跳转链接', info: '纯展示' };
  let TASK_ROWS = [];
  function renderTaskRows(list) { TASK_ROWS = list.map(x => Object.assign({}, x)); paintTaskRows(); }
  function paintTaskRows() {
    $('gmTaskRows').innerHTML = TASK_ROWS.map((t, i) => `
      <div class="item-card" style="padding:10px 12px">
        <div class="inline" style="gap:6px">
          <input data-ti="${i}" data-f="title" value="${esc(t.title)}" placeholder="任务名" style="flex:2;min-width:110px">
          <input data-ti="${i}" data-f="reward" value="${esc(t.reward || '')}" placeholder="奖励文案" style="max-width:110px">
          <select data-ti="${i}" data-f="action" style="max-width:110px">${Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}" ${t.action === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <div class="inline" style="gap:6px;margin-top:6px">
          <input data-ti="${i}" data-f="desc" value="${esc(t.desc || '')}" placeholder="任务说明" style="flex:1;min-width:150px">
          <input data-ti="${i}" data-f="link" value="${esc(t.link || '')}" placeholder="跳转链接(action=link 时填)" style="flex:1;min-width:130px">
        </div>
        <div class="inline" style="gap:6px;margin-top:6px;justify-content:flex-end">
          <label style="font-size:12.5px;color:var(--ink2);display:flex;align-items:center;gap:5px"><input type="checkbox" data-ti="${i}" data-f="enabled" ${t.enabled !== false ? 'checked' : ''}>启用</label>
          <button class="btn-ghost" style="padding:4px 12px" data-tdel="${i}">删除</button>
        </div>
      </div>`).join('') || '<div class="empty">还没有任务，点下方新增</div>';
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
    try { await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify({ tasks: rows }) }); toast('任务专区已保存并即时生效'); loadCfg(); }
    catch (e) { toast(e.message); }
  };

  // ---------- 掉落概率 ----------
  function probSummary(p) {
    if (!p) return '';
    const fmt = t => '逃跑 ' + t.escape + '% ｜ ' + t.reward.map(r => ({ frag: '碎片', key: '钥匙', ball: '魔法球', bagS: '福袋小', bagM: '福袋中', bagL: '福袋大' }[r[0]]) + '×' + r[1] + ' ' + r[2] + '%').join(' · ');
    const w3 = (p.wave3 || []).map((t, i) => '<div style="margin-top:4px">第3波第' + (i + 1) + '轮：' + fmt(t) + '</div>').join('');
    return '<div>第1波：' + fmt(p.wave1) + '</div><div style="margin-top:4px">第2波：' + fmt(p.wave2) + '</div>' + w3;
  }
  $('gmProbSave').onclick = async () => {
    $('gmProbErr').textContent = '';
    let p;
    try { p = JSON.parse($('gmProbJson').value); } catch (e) { $('gmProbErr').textContent = 'JSON 格式不对：' + e.message; return; }
    try { await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify({ prob: p }) }); toast('概率表已保存并即时生效（下一局开始用新表）'); loadCfg(); }
    catch (e) { $('gmProbErr').textContent = e.message; }
  };
  $('gmProbReset').onclick = async () => {
    if (!confirm('确定把概率表还原为代码内置默认值？')) return;
    try { await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify({ prob: null }) }); toast('已还原'); loadCfg(); }
    catch (e) { toast(e.message); }
  };

  async function saveCfg() {
    try {
      const b = {};
      if ($('gmCfgStart').value) b.start = $('gmCfgStart').value.trim();
      if ($('gmCfgEnd').value) b.end = $('gmCfgEnd').value.trim();
      if ($('gmCfgDaily').value !== '') b.dailyFreeKey = +$('gmCfgDaily').value;
      if ($('gmCfgRevive').value !== '') b.maxRevivesPerGame = +$('gmCfgRevive').value;
      if ($('gmCfgCompose').value !== '') b.composeFragCost = +$('gmCfgCompose').value;
      for (const [id, k] of [[$('gmCfgBagS'), 'bagS'], [$('gmCfgBagM'), 'bagM'], [$('gmCfgBagL'), 'bagL']])
        if (id.value) b[k] = id.value.split(',').map(Number);
      await api('/api/game/admin/config', { method: 'POST', body: JSON.stringify(b) });
      toast('配置已保存并立即生效'); loadCfg();
    } catch (e) { toast(e.message); }
  }

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
  return { refresh: () => { loadStats(); loadShanhai(); } };
}
