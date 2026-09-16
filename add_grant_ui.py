dp = r'C:\Users\某某\Desktop\接单后台\public\dispatch.html'
with open(dp, 'r', encoding='utf-8') as f:
    d = f.read()

# 在活动数据面板加道具管理
old_act_panel_end = """        <button class="btn btn-r" onclick="cleanupGames()" style="margin-top:10px">🧹 清理卡住的对局（退还钥匙）</button>
      </div>"""

new_act_panel_end = """        <button class="btn btn-r" onclick="cleanupGames()" style="margin-top:10px">🧹 清理卡住的对局（退还钥匙）</button>
      </div>
      <div class="card">
        <h3>🎁 道具发放/收回</h3>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <input id="grantUserId" placeholder="用户ID" style="flex:1;min-width:120px">
          <select id="grantItem" style="width:100px">
            <option value="keys">钥匙</option>
            <option value="balls">魔法球</option>
            <option value="frags">碎片</option>
            <option value="revives">复活石</option>
            <option value="bagS">福袋小</option>
            <option value="bagM">福袋中</option>
            <option value="bagL">福袋大</option>
          </select>
          <input id="grantAmount" type="number" placeholder="数量" style="width:70px">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-g" onclick="grantItem(true)">发放</button>
          <button class="btn btn-r" onclick="grantItem(false)">收回</button>
        </div>
      </div>"""

d = d.replace(old_act_panel_end, new_act_panel_end)

# 加JS函数
old_load_func = """async function loadActivityStats() {"""
new_load_func = """async function grantItem(isGrant) {
  const uid = $('grantUserId').value.trim();
  const item = $('grantItem').value;
  const amt = Number($('grantAmount').value) || 0;
  if (!uid) { alert('请输入用户ID'); return; }
  if (amt <= 0) { alert('请输入数量'); return; }
  const realAmt = isGrant ? amt : -amt;
  try {
    const j = await authFetch('/api/admin/game-grant', { method: 'POST', body: JSON.stringify({ userId: uid, item, amount: realAmt }) });
    alert('操作成功！当前道具：' + JSON.stringify(j.profile));
  } catch(e) { alert(e.message); }
}
async function loadActivityStats() {"""

d = d.replace(old_load_func, new_load_func)

with open(dp, 'w', encoding='utf-8') as f:
    f.write(d)
print("管理员道具面板已添加")
