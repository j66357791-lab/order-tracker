dp = r'C:\Users\某某\Desktop\接单后台\public\dispatch.html'
with open(dp, 'r', encoding='utf-8') as f:
    d = f.read()

# 改发放面板：加手机号查找
old_grant_ui = """        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
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
        </div>"""

new_grant_ui = """        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <input id="grantPhone" placeholder="输入手机号查找" style="flex:1;min-width:120px">
          <button class="btn btn-ghost" onclick="findUser()">查找</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <input id="grantUserId" placeholder="用户ID（查找后自动填充）" style="flex:1;min-width:120px" readonly>
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
        </div>"""

d = d.replace(old_grant_ui, new_grant_ui)

# 加findUser函数
old_grant_func = """async function grantItem(isGrant) {"""
new_grant_func = """async function findUser() {
  const phone = $('grantPhone').value.trim();
  if (!phone) { alert('请输入手机号'); return; }
  try {
    const j = await authFetch('/api/admin/find-user/' + phone);
    if (j.ok) {
      $('grantUserId').value = j.user._id;
      alert('找到用户：' + (j.user.name || '') + ' (' + j.user.phone + ')');
    }
  } catch(e) { alert(e.message); }
}
async function grantItem(isGrant) {"""

d = d.replace(old_grant_func, new_grant_func)

with open(dp, 'w', encoding='utf-8') as f:
    f.write(d)
print("查找用户UI已添加")
