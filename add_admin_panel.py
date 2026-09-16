dp = r'C:\Users\某某\Desktop\接单后台\public\dispatch.html'
with open(dp, 'r', encoding='utf-8') as f:
    d = f.read()

# 1. 加tab
d = d.replace(
    '<div class="stab" data-v="vRecon">💰 财务对账',
    '<div class="stab" data-v="vAct">📊 活动数据</div>\n  <div class="stab" data-v="vRecon">💰 财务对账'
)

# 2. 加面板（在vAd后面）
act_panel = '''
  <!-- 活动数据 -->
  <section id="vAct" class="panel scroll">
    <div class="wrap">
      <div class="card">
        <h3>🎮 魔法翻翻乐</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0">
          <div style="background:var(--grey-bg);border-radius:10px;padding:12px;text-align:center">
            <div style="font-size:24px;font-weight:700" id="actPlayers">--</div>
            <div style="font-size:12px;color:var(--sub)">参与人数</div>
          </div>
          <div style="background:var(--grey-bg);border-radius:10px;padding:12px;text-align:center">
            <div style="font-size:24px;font-weight:700" id="actPlaying">--</div>
            <div style="font-size:12px;color:var(--sub)">进行中</div>
          </div>
          <div style="background:var(--grey-bg);border-radius:10px;padding:12px;text-align:center">
            <div style="font-size:24px;font-weight:700" id="actGames">--</div>
            <div style="font-size:12px;color:var(--sub)">总局数</div>
          </div>
          <div style="background:var(--grey-bg);border-radius:10px;padding:12px;text-align:center">
            <div style="font-size:24px;font-weight:700" id="actKeys">--</div>
            <div style="font-size:12px;color:var(--sub)">剩余钥匙</div>
          </div>
        </div>
        <button class="btn btn-r" onclick="cleanupGames()" style="margin-top:10px">🧹 清理卡住的对局（退还钥匙）</button>
      </div>
      <div class="card">
        <h3>📅 今日签到</h3>
        <div style="font-size:14px;margin:8px 0">今日签到人数：<b id="actCheckins">--</b></div>
      </div>
    </div>
  </section>
'''
d = d.replace('  <!-- 财务对账 -->', act_panel + '\n  <!-- 财务对账 -->')

# 3. 加tab切换逻辑
d = d.replace(
    "if (t.dataset.v === 'vAd') loadAdAdmin();",
    "if (t.dataset.v === 'vAd') loadAdAdmin();\n  if (t.dataset.v === 'vAct') loadActivityStats();"
)

# 4. 加加载函数
load_func = '''
async function loadActivityStats() {
  try {
    const j = await authFetch('/api/admin/activity-stats');
    if (!j.ok) return;
    $('actPlayers').textContent = j.game.totalPlayers;
    $('actPlaying').textContent = j.game.playingSessions;
    $('actGames').textContent = j.game.totalGames;
    $('actKeys').textContent = j.game.totalKeysLeft;
    $('actCheckins').textContent = j.checkin.today;
  } catch(e) { console.error(e); }
}
async function cleanupGames() {
  if (!confirm('确定清理所有进行中的游戏会话？每个玩家退还1把钥匙')) return;
  try {
    const j = await authFetch('/api/admin/game-cleanup', { method: 'POST' });
    alert('已清理 ' + j.cleaned + ' 个对局');
    loadActivityStats();
  } catch(e) { alert(e.message); }
}
'''
d = d.replace('/* ================= 实时推送', load_func + '\n/* ================= 实时推送')

with open(dp, 'w', encoding='utf-8') as f:
    f.write(d)
print("管理员活动面板已添加")
