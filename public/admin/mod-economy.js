// admin/mod-economy.js — 经济总屏（2026-09-28 · 方向三）
// 一屏看清：灵气/仙玉存量、主站钱包进出、交易所水位与成交、提现分布、大额异动与负余额告警。
// 设计要点：全部数字来自服务端聚合（/api/game/admin/economy），前端只做展示；
// 60 秒自动刷新，页面切后台即暂停（省流量也不打扰）。
import { api, esc, cnTime } from './app.js';

const fmt = n => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const ACTION_NAMES = {
  lingqi_mine: '灵气矿脉领取', duiduile_claim: '堆堆乐领取', duiduile_play: '堆堆乐游玩',
  ex_deposit: '转入交易所', ex_withdraw: '转出交易所', exchange_deal: '交易所成交',
  exchange_publish: '挂单', exchange_cancel: '撤单',
};

function bars(rows, key, color, unit) {
  const max = Math.max(...rows.map(r => Math.abs(r[key])), 1);
  return '<div style="display:flex;align-items:flex-end;gap:6px;height:110px;padding:6px 2px 0">' +
    rows.map(r => {
      const h = Math.max(2, Math.round(Math.abs(r[key]) / max * 96));
      return '<div style="flex:1;text-align:center" title="' + esc(r.day + ' · ' + fmt(r[key]) + unit) + '">'
        + '<div style="font-size:10px;color:var(--ink2);margin-bottom:2px">' + fmt(r[key]) + '</div>'
        + '<div style="height:' + h + 'px;background:' + color + ';border-radius:4px 4px 0 0;margin:0 auto;width:70%"></div>'
        + '<div style="font-size:10px;color:var(--ink2);margin-top:3px">' + esc(r.day.slice(5)) + '</div></div>';
    }).join('') + '</div>';
}

export function mount(root) {
  root.innerHTML = `
  <div class="content-head">
    <div>
      <h1 class="serif">经济总屏</h1>
      <div class="sub">灵气 / 仙玉 / 主站钱包 / 交易所 一屏总览 · 每 60 秒自动刷新（切后台暂停）</div>
    </div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="ecoReload">立即刷新</button>
  </div>

  <div id="ecoAlert" style="display:none;margin-bottom:14px"></div>

  <div class="grid4 stats-grid" style="margin-bottom:14px">
    <div class="stat"><b id="ecoLingqi">--</b><span>灵气存量（可用）</span></div>
    <div class="stat"><b id="ecoLingqiF">--</b><span>灵气冻结（占领/挂单）</span></div>
    <div class="stat"><b id="ecoXianyu">--</b><span>仙玉存量</span></div>
    <div class="stat"><b id="ecoPlayers">--</b><span>游戏玩家数</span></div>
  </div>

  <div class="grid4 stats-grid" style="margin-bottom:14px">
    <div class="stat"><b id="ecoExBal">--</b><span>交易所玩家余额 ¥</span></div>
    <div class="stat"><b id="ecoExFrozen">--</b><span>交易所玩家冻结 ¥</span></div>
    <div class="stat"><b id="ecoBot">--</b><span>做市机器人余额 ¥</span></div>
    <div class="stat"><b id="ecoFund">--</b><span>做市灵气额度（可用/冻结）</span></div>
  </div>

  <div class="card">
    <h2 class="serif">交易所成交额 · 近 7 天</h2>
    <div class="sub">柱高为当日成交总额（¥），悬停看笔数；手续费是平台唯一净收入</div>
    <div id="ecoDeals">加载中…</div>
    <div class="sub" id="ecoDealsSum" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <h2 class="serif">主站钱包进出 · 近 7 天</h2>
    <div class="sub">流入（充值/激励/转入退款等）与流出（提现/转入交易所等），悬停看明细</div>
    <div id="ecoWallet">加载中…</div>
  </div>

  <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
    <div class="card">
      <h2 class="serif">提现分布（全部状态）</h2>
      <div class="sub">正常应只有少量"待打款/待确认"挂在中间态，大量堆积要警惕</div>
      <div id="ecoWithdraw" style="font-size:13px">加载中…</div>
    </div>
    <div class="card">
      <h2 class="serif">灵气/交易所事件 · 近 7 天</h2>
      <div class="sub">按动作汇总的笔数与数量，看产出与流通节奏</div>
      <div id="ecoEvents" style="font-size:12px;max-height:220px;overflow:auto">加载中…</div>
    </div>
  </div>

  <div class="card">
    <h2 class="serif">大额异动 · 近 24 小时（前 20 条）</h2>
    <div class="sub">单笔金额 ≥ 阈值的钱包流水；都是你认识的操作才正常</div>
    <div id="ecoBigMoves" style="font-size:12px">加载中…</div>
  </div>`;

  const $ = id => root.querySelector('#' + id);

  function statCard(id, val) { const el = $(id); if (el) el.textContent = val; }

  function renderAlerts(a) {
    const box = $('ecoAlert');
    const items = [];
    if (a.negLingqi > 0) items.push(a.negLingqi + ' 个玩家灵气为负');
    if (a.negXianyu > 0) items.push(a.negXianyu + ' 个玩家仙玉为负');
    if (a.negExw > 0) items.push(a.negExw + ' 个交易所钱包余额为负');
    if (a.fundNegative) items.push('做市灵气额度为负');
    if (!items.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.style.cssText += 'background:#fdecec;border:1px solid #f5b5b5;border-radius:12px;padding:12px 16px;color:#a03030;font-size:13px';
    box.innerHTML = '⚠ 账目告警：' + esc(items.join('；')) + ' —— 负余额说明有账没对平，优先排查';
  }

  function render() {
    return api('/api/game/admin/economy').then(j => {
      const d = j;
      statCard('ecoLingqi', fmt(d.profiles.lingqi));
      statCard('ecoLingqiF', fmt(d.profiles.lingqiFrozen));
      statCard('ecoXianyu', fmt(d.profiles.xianyu));
      statCard('ecoPlayers', fmt(d.profiles.players));
      statCard('ecoExBal', fmt(d.exchange.playerBalance));
      statCard('ecoExFrozen', fmt(d.exchange.playerFrozen));
      statCard('ecoBot', fmt(d.exchange.bot.balance));
      statCard('ecoFund', fmt(d.exchange.fund.lingqi) + ' / ' + fmt(d.exchange.fund.lingqiFrozen));
      renderAlerts(d.alerts);

      $('ecoDeals').innerHTML = d.deals7d.length
        ? bars(d.deals7d, 'total', 'linear-gradient(180deg,#54b4e8,#2f7fa8)', '¥')
        : '<div class="empty">近 7 天没有成交</div>';
      const t7 = d.deals7d.reduce((s, x) => s + x.total, 0), f7 = d.deals7d.reduce((s, x) => s + x.fee, 0);
      const c7 = d.deals7d.reduce((s, x) => s + x.count, 0);
      $('ecoDealsSum').textContent = '7 天合计：' + c7 + ' 笔 · 成交 ¥' + fmt(t7) + ' · 手续费 ¥' + fmt(f7);

      // 主站进出用双色（净流入绿 / 净流出红），与上面单色柱状分开渲染
      const wrows = d.wallet7d.map(x => ({ day: x.day, v: x.net, t: '流入 ¥' + fmt(x.inflow) + ' / 流出 ¥' + fmt(x.outflow) }));
      $('ecoWallet').innerHTML = wrows.length
        ? '<div style="display:flex;align-items:flex-end;gap:6px;height:110px;padding:6px 2px 0">' +
          wrows.map(r => {
            const h = Math.max(2, Math.round(Math.abs(r.v) / Math.max(...wrows.map(x => Math.abs(x.v)), 1) * 96));
            const c = r.v >= 0 ? 'linear-gradient(180deg,#6fd8a0,#3a9a70)' : 'linear-gradient(180deg,#f0a0a0,#c06060)';
            return '<div style="flex:1;text-align:center" title="' + esc(r.day + ' · ' + r.t + ' · 净 ' + fmt(r.v)) + '">'
              + '<div style="font-size:10px;color:var(--ink2);margin-bottom:2px">' + fmt(r.v) + '</div>'
              + '<div style="height:' + h + 'px;background:' + c + ';border-radius:4px 4px 0 0;margin:0 auto;width:70%"></div>'
              + '<div style="font-size:10px;color:var(--ink2);margin-top:3px">' + esc(r.day.slice(5)) + '</div></div>';
          }).join('') + '</div>'
        : '<div class="empty">近 7 天没有钱包流水</div>';

      $('ecoWithdraw').innerHTML = d.withdrawByStatus.length
        ? '<table style="width:100%;border-collapse:collapse">' + d.withdrawByStatus.map(x =>
          '<tr><td style="padding:4px 6px;border-bottom:1px dashed var(--line)">' + esc(x.status) + '</td>'
          + '<td style="padding:4px 6px;border-bottom:1px dashed var(--line);text-align:right">' + x.count + ' 笔</td>'
          + '<td style="padding:4px 6px;border-bottom:1px dashed var(--line);text-align:right">¥' + fmt(x.sum) + '</td></tr>').join('') + '</table>'
        : '<div class="empty">还没有提现记录</div>';

      $('ecoEvents').innerHTML = d.logEvents7d.length
        ? '<table style="width:100%;border-collapse:collapse">' + d.logEvents7d.map(x =>
          '<tr><td style="padding:3px 6px;border-bottom:1px dashed var(--line)">' + esc(x.day.slice(5)) + '</td>'
          + '<td style="padding:3px 6px;border-bottom:1px dashed var(--line)">' + esc(ACTION_NAMES[x.action] || x.action) + '</td>'
          + '<td style="padding:3px 6px;border-bottom:1px dashed var(--line);text-align:right">' + x.count + ' 笔</td>'
          + '<td style="padding:3px 6px;border-bottom:1px dashed var(--line);text-align:right">'
          + (x.gain ? '灵气 ' + fmt(x.gain) : '') + (x.gain && x.amount ? ' / ' : '') + (x.amount ? '¥' + fmt(x.amount) : '') + '</td></tr>').join('') + '</table>'
        : '<div class="empty">近 7 天没有相关事件</div>';

      $('ecoBigMoves').innerHTML = d.bigMoves.length
        ? '<table style="width:100%;border-collapse:collapse">' + d.bigMoves.map(x =>
          '<tr><td style="padding:3px 6px;border-bottom:1px dashed var(--line)">' + esc(cnTime(x.createdAt)) + '</td>'
          + '<td style="padding:3px 6px;border-bottom:1px dashed var(--line)">' + esc(String(x.userId || '').slice(-6)) + '</td>'
          + '<td style="padding:3px 6px;border-bottom:1px dashed var(--line)">' + esc(x.kind) + '</td>'
          + '<td style="padding:3px 6px;border-bottom:1px dashed var(--line);text-align:right;font-weight:700;color:' + (x.amount >= 0 ? '#2f7a4f' : '#a03030') + '">' + (x.amount >= 0 ? '+' : '') + fmt(x.amount) + '</td>'
          + '<td style="padding:3px 6px;border-bottom:1px dashed var(--line);color:var(--ink2)">' + esc(String(x.note || '').slice(0, 30)) + '</td></tr>').join('') + '</table>'
        : '<div class="empty">24 小时内没有 ≥ ¥' + d.alerts.bigMoveMin + ' 的流水</div>';
    });
  }

  async function load() {
    try { await render(); }
    catch (e) { $('ecoBigMoves').innerHTML = '<div class="empty">载入失败：' + esc(e && e.message ? e.message : '网络异常') + '</div>'; }
  }

  $('ecoReload').onclick = load;
  // 60 秒自动刷新：切后台即暂停（与全站"页面隐藏即停"的约定一致）
  setInterval(() => { if (!document.hidden) load(); }, 60000);

  load();
  return { refresh: load };
}
