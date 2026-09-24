// mod-shanhai.js — 【v26.2】山海斩妖录 · 交易所台账 + 做市机器人 + 玩家道具管控
// 三块：
//   ① 做市机器人：按管理员设定的价格区间与节奏自动买卖，保证任何时候都有人接单（玩家的兜底）
//   ② 交易所台账：玩家与机器人成交一处分账，机器人笔数单独标注，手续费口径清晰
//   ③ 玩家道具管控：可直接查人、发放/扣除仙玉·灵气·体力，处理异常档案
import { api, esc, toast, cnTime } from './app.js';

const fmtT = t => {
  try { const d = new Date(t); return cnTime ? cnTime(d) : d.toLocaleString('zh-CN', { hour12: false }); }
  catch (e) { return String(t || ''); }
};

// 【v26.3.2】跳过原因写成人话，不然看到 bot_orders_full 会以为机器人坏了
const SKIP_LABEL = {
  bot_no_cash: '机器人余额不足（去「补充额度」）',
  bot_no_lingqi: '机器人灵气不足（去「补充额度」）',
  bot_orders_full: '机器人挂单已满（等旧单被吃掉，30 分钟后自动回收）',
  bot_same_price: '同价位已有单（正常，避免重复堆叠）',
  // 【v26.5】这两条就是防套利的护栏在起作用：玩家挂了机器人不愿意接受的价格，直接不碰
  ask_too_high: '有卖单报价高于机器人买价上限（正常，防被套利）',
  bid_too_low: '有买单报价低于机器人卖价下限（正常，防被套利）',
  race: '被抢先成交（正常）',
  settle_error: '结算异常（需排查）',
  buyer_no_cash: '对手方余额不足（正常）',
  disabled: '做市已暂停',
  exchange_closed: '交易所总闸已关闭',
};

export function mount(root) {
  const $ = id => root.querySelector('#' + id);
  root.innerHTML = `
  <div class="card">
    <h2 class="serif">交易所总闸</h2>
    <div class="sub">万一觉得不对劲，一键停用整个交易所——玩家入口还在，但挂单 / 成交 / 转入 / 转出全部被拒（提示"正在维护"）。
      <b>不影响主站余额、提现、充值</b>，随时可以再开。</div>
    <div class="inline" style="margin-top:10px">
      <select id="exSw" style="width:160px">
        <option value="1">开放使用</option>
        <option value="0">停用维护</option>
      </select>
      <button class="btn-main" id="exSwSave">保存</button>
      <span class="sub" id="exSwState" style="margin-left:auto"></span>
    </div>
  </div>

  <div class="card">
    <h2 class="serif">做市机器人</h2>
    <div class="sub">按你设定的价格区间与节奏自动买卖，优先吃玩家挂的单——<b>保证任何时候都有人接盘</b>，玩家不会挂上去没人理。
      机器人用独立账户结算，不进玩家数、不上榜；它同样按 0.5% 交手续费。</div>
    <div class="grid3" style="margin-top:12px">
      <div><label class="lab">做市开关</label>
        <select id="mkEnabled"><option value="1">运行中</option><option value="0">已暂停</option></select></div>
      <div><label class="lab">每轮间隔（秒）</label><input id="mkInterval" type="number" min="15" max="3600" step="5"></div>
      <div><label class="lab">每轮笔数（最少 ~ 最多）</label>
        <div class="inline"><input id="mkTradesMin" type="number" min="1" max="50" style="width:70px">
        <span class="sub">~</span><input id="mkTradesMax" type="number" min="1" max="50" style="width:70px"></div></div>
      <div><label class="lab">价格波动区间（元/灵气）</label>
        <div class="inline"><input id="mkPriceMin" type="number" min="0.0001" step="0.0001" style="width:92px">
        <span class="sub">~</span><input id="mkPriceMax" type="number" min="0.0001" step="0.0001" style="width:92px"></div>
        <div class="sub" style="margin-top:2px">最低可到 0.0001，与交易所同口径</div></div>
      <div><label class="lab">买卖最小价差（元/灵气）</label>
        <input id="mkSpread" type="number" min="0.0001" step="0.0001" placeholder="默认 0.001">
        <div class="sub" style="margin-top:2px">卖单最低价 − 买单最高价。<b>必须盖住双向手续费</b>，否则玩家能低买高卖刷钱</div></div>
      <div><label class="lab">机器人当前实际报价</label>
        <div class="sub" id="mkPrices" style="padding-top:6px">加载中…</div></div>
      <div><label class="lab">每笔数量区间（灵气）</label>
        <div class="inline"><input id="mkAmountMin" type="number" min="1" style="width:80px">
        <span class="sub">~</span><input id="mkAmountMax" type="number" min="1" style="width:80px"></div></div>
      <div><label class="lab">机器人可用额度</label>
        <div class="sub" id="mkFund" style="padding-top:6px">加载中…</div></div>
    </div>
    <div class="inline" style="margin-top:12px;flex-wrap:wrap;gap:8px">
      <button class="btn-main" id="mkSave">保存配置</button>
      <button class="btn-ghost" id="mkRun">立即跑一轮</button>
      <button class="btn-ghost" id="mkFundAdd">补充额度</button>
      <button class="btn-ghost" id="mkClear">收回机器人挂单</button>
      <span class="sub" id="mkState" style="margin-left:auto"></span>
    </div>
    <div class="sub" id="mkLast" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <h2 class="serif">交易所台账</h2>
    <div class="sub">玩家与机器人的每一笔成交都在这里。机器人的单带 <b>灵傀</b> 标记，方便对账时把「真实玩家之间的交易」和
      「做市带来的活跃度」分开看——两者的手续费口径完全一致。</div>
    <div class="grid3" style="margin-top:12px" id="exStats"></div>
    <div class="inline" style="margin:12px 0">
      <button class="btn-ghost on" data-f="all" id="exF-all">全部</button>
      <button class="btn-ghost" data-f="human" id="exF-human">仅玩家</button>
      <button class="btn-ghost" data-f="bot" id="exF-bot">仅做市</button>
      <button class="btn-ghost" id="exReload" style="margin-left:auto">刷新</button>
    </div>
    <div style="overflow-x:auto"><table id="exTable" style="width:100%;border-collapse:collapse;font-size:12.5px"></table></div>
    <div class="inline" style="margin-top:10px">
      <button class="btn-ghost" id="exPrev">上一页</button>
      <span class="sub" id="exPage">第 1 页</span>
      <button class="btn-ghost" id="exNext">下一页</button>
    </div>
  </div>

  <div class="card">
    <h2 class="serif">山海玩家道具管控</h2>
    <div class="sub">查人支持：昵称模糊 / 手机号 / 工号 / 用户 ID。发放填正数、扣除填负数；扣除时不允许扣成负数（防止档案被扣崩）。</div>
    <div class="inline" style="margin-top:10px">
      <input id="plQ" placeholder="搜索昵称 / 手机号 / 工号 / 用户ID" style="flex:1">
      <button class="btn-main" id="plSearch">查询</button>
    </div>
    <div style="overflow-x:auto;margin-top:10px"><table id="plTable" style="width:100%;border-collapse:collapse;font-size:12.5px"></table></div>
  </div>

  <div class="card" id="plDetailCard" style="display:none">
    <h2 class="serif">玩家档案 · <span id="plTitle"></span></h2>
    <div class="sub" id="plSub"></div>
    <div class="grid3" style="margin-top:12px">
      <div><label class="lab">仙玉（±）</label><input id="grXianyu" type="number" step="1" placeholder="正数发放 / 负数扣除"></div>
      <div><label class="lab">灵气（±）</label><input id="grLingqi" type="number" step="1" placeholder="正数发放 / 负数扣除"></div>
      <div><label class="lab">体力（±）</label><input id="grStamina" type="number" step="1" placeholder="上限 10，谨慎加"></div>
    </div>
    <div class="inline" style="margin-top:12px;flex-wrap:wrap;gap:8px">
      <button class="btn-main" id="grDo">执行发放 / 扣除</button>
      <button class="btn-ghost" id="grClearBag">清空背包</button>
      <button class="btn-ghost" id="grUnequip">卸下全部装备</button>
      <button class="btn-ghost" id="grRefresh">刷新档案</button>
    </div>
    <div class="sub" id="grHint" style="margin-top:8px"></div>
    <div style="margin-top:12px" id="plExtra"></div>
  </div>`;

  const th = (t) => `<th style="text-align:left;padding:7px 8px;border-bottom:1px solid #e6e1d6;color:#8a8272;font-weight:600;white-space:nowrap">${t}</th>`;
  const td = (t, st) => `<td style="padding:7px 8px;border-bottom:1px solid #f2eee5;${st || ''}">${t}</td>`;

  // ==================== ⓪ 交易所总闸 ====================
  async function loadSwitch() {
    try {
      const d = await api('/api/shanhai/admin/exchange/switch');
      if (!d.ok) throw new Error(d.error || '加载失败');
      $('exSw').value = d.enabled ? '1' : '0';
      $('exSwState').textContent = d.enabled ? '● 交易所正常开放' : '○ 交易所已停用（玩家侧显示维护中）';
      $('exSwState').style.color = d.enabled ? '' : '#b3452f';
    } catch (e) { toast('总闸状态加载失败：' + (e.message || e)); }
  }
  $('exSwSave').onclick = async () => {
    const enabled = $('exSw').value === '1';
    if (!enabled && !confirm('确认停用交易所？玩家将无法挂单、成交、转入转出（已成交的记录与余额都保留）。')) return;
    try {
      const d = await api('/api/shanhai/admin/exchange/switch', { method: 'POST', body: JSON.stringify({ enabled }) });
      if (!d.ok) throw new Error(d.error || '保存失败');
      toast(enabled ? '交易所已开放' : '交易所已停用');
      await loadSwitch();
    } catch (e) { toast('保存失败：' + (e.message || e)); }
  };

  // ==================== ① 做市配置 ====================
  let MK = null;
  async function loadMarket() {
    try {
      const d = await api('/api/shanhai/admin/market/config');
      if (!d.ok) throw new Error(d.error || '加载失败');
      MK = d;
      const c = d.cfg;
      $('mkEnabled').value = c.enabled ? '1' : '0';
      $('mkInterval').value = c.intervalSec;
      $('mkTradesMin').value = c.tradesMin; $('mkTradesMax').value = c.tradesMax;
      $('mkPriceMin').value = c.priceMin; $('mkPriceMax').value = c.priceMax;
      $('mkAmountMin').value = c.amountMin; $('mkAmountMax').value = c.amountMax;
      $('mkSpread').value = c.spreadMin === undefined ? 0.001 : c.spreadMin;
      // 机器人实际报价：让管理员一眼看出买卖盘有没有被劈开
      const pz = d.prices || {};
      if (pz.askMin !== undefined) {
        const gain = pz.spread > 0 ? ((pz.spread / (pz.bidMax || 1)) * 100).toFixed(1) : '0';
        $('mkPrices').innerHTML = `卖单最低 <b>¥${pz.askMin}</b> ｜ 买单最高 <b>¥${pz.bidMax}</b> ｜ 价差 <b>¥${pz.spread}</b>（${gain}%）`
          + `<br><span style="color:#8a8272">中间价 ¥${pz.mid} · 玩家低买高卖一轮必亏，无法套利</span>`;
      } else {
        $('mkPrices').textContent = '—';
      }
      $('mkFund').innerHTML = `灵气 <b>${(d.fund.lingqi || 0).toLocaleString()}</b>`
        + `（挂单冻结 ${(d.fund.lingqiFrozen || 0).toLocaleString()}）· 余额 <b>¥${(d.balance || 0).toFixed(2)}</b>`;
      const sum = c.lastSummary;
      $('mkState').textContent = c.enabled ? '● 运行中' : '○ 已暂停';
      const skipTxt = (sum && sum.skips && sum.skips.length)
        ? '，跳过 ' + sum.skips.map(x => SKIP_LABEL[x] || x).join('；')
        : '';
      $('mkLast').textContent = c.lastRunAt
        ? `上轮（${fmtT(c.lastRunAt)}）：尝试 ${sum ? sum.tried : '-'} 笔，成交 ${sum ? sum.deals : '-'} 笔，挂单 ${sum ? sum.posts : '-'} 笔` + skipTxt
        : '还没有跑过';
    } catch (e) { toast('做市配置加载失败：' + (e.message || e)); }
  }
  $('mkSave').onclick = async () => {
    try {
      const body = {
        enabled: $('mkEnabled').value === '1',
        intervalSec: +$('mkInterval').value,
        tradesMin: +$('mkTradesMin').value, tradesMax: +$('mkTradesMax').value,
        priceMin: +$('mkPriceMin').value, priceMax: +$('mkPriceMax').value,
        spreadMin: +$('mkSpread').value || 0.001,
        amountMin: +$('mkAmountMin').value, amountMax: +$('mkAmountMax').value,
      };
      const d = await api('/api/shanhai/admin/market/config', { method: 'POST', body: JSON.stringify(body) });
      if (!d.ok) throw new Error(d.error || '保存失败');
      toast('做市配置已保存，下一轮生效');
      await loadMarket();
    } catch (e) { toast('保存失败：' + (e.message || e)); }
  };
  $('mkRun').onclick = async () => {
    try {
      toast('正在跑一轮…');
      const d = await api('/api/shanhai/admin/market/run', { method: 'POST', body: '{}' });
      toast(`本轮：成交 ${d.deals || 0} 笔，挂单 ${d.posts || 0} 笔`);
      await Promise.all([loadMarket(), loadLedger()]);
    } catch (e) { toast('执行失败：' + (e.message || e)); }
  };
  $('mkFundAdd').onclick = async () => {
    const lq = prompt('补充多少灵气给机器人？（负数=扣回）', '20000');
    if (lq === null) return;
    const cash = prompt('再补充多少余额（元）给机器人？（可留空）', '');
    if (cash === null) return;
    try {
      const d = await api('/api/shanhai/admin/market/fund', {
        method: 'POST', body: JSON.stringify({ lingqi: +lq || 0, cash: +cash || 0 }),
      });
      if (!d.ok) throw new Error(d.error || '失败');
      toast('额度已更新');
      await loadMarket();
    } catch (e) { toast('失败：' + (e.message || e)); }
  };
  $('mkClear').onclick = async () => {
    if (!confirm('把机器人当前所有挂单撤掉并收回流动资金？')) return;
    try {
      const d = await api('/api/shanhai/admin/market/clear-orders', { method: 'POST', body: '{}' });
      toast(`已撤销 ${d.cleared || 0} 张挂单，收回灵气 ${d.lingqiBack || 0}`);
      await Promise.all([loadMarket(), loadLedger()]);
    } catch (e) { toast('失败：' + (e.message || e)); }
  };

  // ==================== ② 交易所台账 ====================
  let page = 0, filter = 'all';
  async function loadLedger() {
    try {
      const qs = `?page=${page}&limit=50` + (filter === 'all' ? '' : `&only=${filter}`);
      const d = await api('/api/shanhai/admin/exchange/ledger' + qs);
      if (!d.ok) throw new Error(d.error || '加载失败');
      const s = d.stats, all = s.all || {}, hu = s.human || {}, bo = s.bot || {};
      const card = (label, main, sub) => `<div style="background:#fbf9f4;border:1px solid #ece7db;border-radius:10px;padding:10px 12px">
        <div class="sub" style="margin:0">${label}</div>
        <div style="font:900 17px/1.5 'PingFang SC';color:#2b2a26">${main}</div>
        <div class="sub" style="margin:0">${sub}</div></div>`;
      $('exStats').innerHTML =
        card('累计成交', `${all.cnt || 0} 笔`, `金额 ¥${(all.total || 0).toFixed(2)} · 灵气 ${(all.lingqi || 0).toLocaleString()}`)
        + card('玩家之间', `${hu.cnt || 0} 笔`, `金额 ¥${(hu.total || 0).toFixed(2)} · 手续费 ¥${(hu.fee || 0).toFixed(2)}`)
        + card('做市机器人', `${bo.cnt || 0} 笔`, `金额 ¥${(bo.total || 0).toFixed(2)} · 手续费 ¥${(bo.fee || 0).toFixed(2)}`)
        + card('平台手续费累计', `¥${(s.platformFeeTotal || 0).toFixed(2)}`, `${s.feeLog ? s.feeLog.cnt : 0} 笔 · 费率 0.5%`)
        + card('市场挂单', `${s.openOrders || 0} 张`, `玩家 ${s.humanOpenOrders || 0} 张 · 机器人 ${s.botOpenOrders || 0}/${s.botMaxPerSide || 20} 张`,)
        + card('机器人额度', s.botFund ? `${(s.botFund.lingqi || 0).toLocaleString()} 灵气` : '-', s.botFund ? `余额 ¥${(s.botFund.balance || 0).toFixed(2)} · 冻结灵气 ${(s.botFund.lingqiFrozen || 0).toLocaleString()}` : '');

      const rows = d.rows || [];
      let h = `<tr>${th('时间')}${th('类型')}${th('买家')}${th('卖家')}${th('方向')}${th('数量')}${th('单价')}${th('金额')}${th('手续费')}</tr>`;
      if (!rows.length) h += `<tr><td colspan="9" style="padding:22px;text-align:center;color:#a09884">还没有成交记录</td></tr>`;
      for (const r of rows) {
        // 【v26.10】三种来源要分清：真实玩家成交 / 机器人与玩家成交 / 做市撮合（演习，不转移资产）
        const tag = r.sim
          ? `<span style="display:inline-block;padding:0 6px;border-radius:5px;background:#eef1f6;color:#5a6a88;font-size:11px">撮合</span>`
          : (r.bot
            ? `<span style="display:inline-block;padding:0 6px;border-radius:5px;background:#efe6d2;color:#8a6a2a;font-size:11px">做市</span>`
            : `<span style="display:inline-block;padding:0 6px;border-radius:5px;background:#e3f0e8;color:#2f6b4c;font-size:11px">玩家</span>`);
        const name = (n, id) => bot && (id === '__market__')
          ? `<b style="color:#8a6a2a">灵傀</b>`
          : `${esc(n || '-')}`;
        // 【v26.10】单价改 4 位：交易所允许 0.0001 级定价，toFixed(2) 会把 0.0810 显示成 ¥0.08、
        // 0.0001 直接显示成 ¥0.00 —— 台账看着像全场免费成交。
        h += `<tr>${td(fmtT(r.createdAt), 'white-space:nowrap')}${td(tag)}${td(name(r.buyerReal, r.buyerId))}${td(name(r.sellerReal, r.sellerId))}
          ${td(r.side === 'sell' ? '买入' : '卖出')}${td((r.amount || 0).toLocaleString())}${td('¥' + (r.price || 0).toFixed(4))}
          ${td('¥' + (r.total || 0).toFixed(4), 'font-weight:700')}${td('¥' + (r.fee || 0).toFixed(4), 'color:#8a6a2a')}</tr>`;
      }
      $('exTable').innerHTML = h;
      $('exPage').textContent = `第 ${page + 1} 页 · 共 ${d.total || 0} 笔`;
    } catch (e) { toast('台账加载失败：' + (e.message || e)); }
  }
  ['all', 'human', 'bot'].forEach(f => {
    $('exF-' + f).onclick = () => {
      filter = f; page = 0;
      ['all', 'human', 'bot'].forEach(x => $('exF-' + x).classList.toggle('on', x === f));
      loadLedger();
    };
  });
  $('exReload').onclick = () => loadLedger();
  $('exPrev').onclick = () => { if (page > 0) { page--; loadLedger(); } };
  $('exNext').onclick = () => { page++; loadLedger(); };

  // ==================== ③ 玩家道具管控 ====================
  let curUser = null;
  async function searchPlayers() {
    const q = $('plQ').value.trim();
    try {
      const d = await api('/api/shanhai/admin/players?limit=40' + (q ? `&q=${encodeURIComponent(q)}` : ''));
      if (!d.ok) throw new Error(d.error || '查询失败');
      const rows = d.rows || [];
      let h = `<tr>${th('昵称')}${th('用户ID')}${th('仙玉')}${th('灵气')}${th('冻结')}${th('账户余额')}${th('体力')}${th('通关')}${th('操作')}</tr>`;
      if (!rows.length) h += `<tr><td colspan="9" style="padding:22px;text-align:center;color:#a09884">没找到匹配的玩家</td></tr>`;
      for (const r of rows) {
        h += `<tr>${td(esc(r.username || '-'))}${td(`<span class="sub" style="word-break:break-all">${esc(r.userId)}</span>`)}
          ${td(r.xianyu || 0)}${td(r.lingqi || 0)}${td(r.lingqiFrozen || 0)}
          ${td('¥' + (r.balance || 0).toFixed(2))}${td(r.stamina || 0)}${td('第 ' + (r.topStage || 0) + ' 关')}
          ${td(`<button class="btn-ghost" data-uid="${esc(r.userId)}">管控</button>`)}</tr>`;
      }
      $('plTable').innerHTML = h;
      $('plTable').querySelectorAll('button[data-uid]').forEach(b => {
        b.onclick = () => openPlayer(b.dataset.uid);
      });
    } catch (e) { toast('查询失败：' + (e.message || e)); }
  }
  $('plSearch').onclick = searchPlayers;
  $('plQ').onkeydown = e => { if (e.key === 'Enter') searchPlayers(); };

  async function openPlayer(uid) {
    curUser = uid;
    try {
      const d = await api('/api/shanhai/admin/player/' + encodeURIComponent(uid));
      if (!d.ok) throw new Error(d.error || '加载失败');
      const p = d.profile;
      $('plDetailCard').style.display = 'block';
      $('plTitle').textContent = p.username || uid;
      $('plSub').innerHTML = `用户ID <b>${esc(uid)}</b> · 仙玉 ${p.xianyu || 0} · 灵气 ${p.lingqi || 0}（冻结 ${p.lingqiFrozen || 0}）`
        + ` · 体力 ${p.stamina || 0} · 局数 ${p.plays || 0} / 胜 ${p.wins || 0}`;
      const eq = p.equip || {};
      const eqTxt = Object.entries(eq).filter(([, v]) => v).map(([k, v]) => `${k}:${esc(v.name || '')}`).join('、') || '无';
      const bag = (p.bag || []);
      $('plExtra').innerHTML = `
        <div class="sub"><b>已穿戴</b>：${eqTxt}</div>
        <div class="sub" style="margin-top:4px"><b>背包</b>（${bag.length} 件）：${bag.slice(0, 8).map(i => esc(i.name)).join('、') || '空'}${bag.length > 8 ? ' …' : ''}</div>
        <div class="sub" style="margin-top:10px"><b>最近流水</b></div>
        <div style="max-height:220px;overflow:auto;margin-top:4px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <tr>${th('时间')}${th('动作')}${th('明细')}</tr>
          ${(d.logs || []).map(l => `<tr>${td(fmtT(l.createdAt), 'white-space:nowrap')}${td(esc(l.action || ''))}${td(`<span class="sub">${esc(JSON.stringify(l.detail || {}).slice(0, 90))}</span>`)}</tr>`).join('') || `<tr><td colspan="3" style="padding:14px;text-align:center;color:#a09884">暂无记录</td></tr>`}
        </table></div>
        <div class="sub" style="margin-top:10px"><b>最近交易</b>：${(d.deals || []).length} 笔 ｜ <b>挂单</b>：${(d.orders || []).length} 张</div>`;
      $('grHint').textContent = '';
    } catch (e) { toast('加载档案失败：' + (e.message || e)); }
  }

  $('grRefresh').onclick = () => { if (curUser) openPlayer(curUser); };
  $('grDo').onclick = async () => {
    if (!curUser) return;
    const body = {
      userId: curUser,
      xianyu: +$('grXianyu').value || 0,
      lingqi: +$('grLingqi').value || 0,
      stamina: +$('grStamina').value || 0,
    };
    if (!body.xianyu && !body.lingqi && !body.stamina) return toast('请至少填一项');
    if (!confirm(`确认对 ${curUser} 执行：仙玉 ${body.xianyu >= 0 ? '+' : ''}${body.xianyu}、灵气 ${body.lingqi >= 0 ? '+' : ''}${body.lingqi}、体力 ${body.stamina >= 0 ? '+' : ''}${body.stamina}？`)) return;
    try {
      const d = await api('/api/shanhai/admin/grant', { method: 'POST', body: JSON.stringify(body) });
      if (!d.ok) throw new Error(d.error || '失败');
      toast('已执行，档案已更新');
      $('grXianyu').value = ''; $('grLingqi').value = ''; $('grStamina').value = '';
      await openPlayer(curUser);
    } catch (e) { toast('失败：' + (e.message || e)); }
  };
  $('grClearBag').onclick = async () => {
    if (!curUser || !confirm('清空该玩家背包？（不可撤销，装备不受影响）')) return;
    const d = await api('/api/shanhai/admin/equip-action', { method: 'POST', body: JSON.stringify({ userId: curUser, action: 'clear-bag' }) });
    toast(d.ok ? '背包已清空' : ('失败：' + (d.error || '')));
    if (d.ok) openPlayer(curUser);
  };
  $('grUnequip').onclick = async () => {
    if (!curUser || !confirm('卸下该玩家全部装备？（装备会进背包，若背包已满可能丢失）')) return;
    const d = await api('/api/shanhai/admin/equip-action', { method: 'POST', body: JSON.stringify({ userId: curUser, action: 'unequip-all' }) });
    toast(d.ok ? '已卸下' : ('失败：' + (d.error || '')));
    if (d.ok) openPlayer(curUser);
  };

  // 初始化
  loadSwitch();
  loadMarket();
  loadLedger();
  searchPlayers();

  return { refresh: () => { loadSwitch(); loadMarket(); loadLedger(); } };
}
