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
    <h2 class="serif">活动配置热调</h2>
    <div class="sub">立即生效，无需重启；留空 = 不修改；概率表/商铺商品在 games.js 内配置</div>
    <div class="inline"><input id="gmCfgStart" placeholder="活动开始 2026-09-12"><input id="gmCfgEnd" placeholder="活动结束 2026-10-31"></div>
    <div class="inline" style="margin-top:8px"><input id="gmCfgDaily" type="number" placeholder="每日免费钥匙"><input id="gmCfgRevive" type="number" placeholder="每局复活上限"><input id="gmCfgCompose" type="number" placeholder="合成球需碎片"></div>
    <div class="inline" style="margin-top:8px"><input id="gmCfgBagS" placeholder="小福袋(元) 0.30,0.88"><input id="gmCfgBagM" placeholder="中福袋(元) 1.68,8.88"><input id="gmCfgBagL" placeholder="大福袋(元) 18.88,88.88"></div>
    <div style="margin-top:12px"><button class="btn-main" id="gmSaveCfg">保存配置</button></div>
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
    } catch (e) { toast(e.message); }
  }

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
