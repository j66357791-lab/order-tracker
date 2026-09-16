dp = r'C:\Users\某某\Desktop\接单后台\public\dispatch.html'
with open(dp, 'r', encoding='utf-8') as f:
    d = f.read()

# 在活动数据面板最上面加维护开关
old_act_title = """      <div class="card">
        <h3>🎮 魔法翻翻乐</h3>"""

new_act_title = """      <div class="card">
        <h3>🔧 活动维护开关</h3>
        <div style="display:flex;align-items:center;gap:10px;margin:10px 0">
          <label style="flex:1">开启维护后，用户端活动显示"维护中"，网站其他功能正常</label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="maintSwitch" onchange="toggleMaintenance()">
            <span id="maintLabel">已关闭</span>
          </label>
        </div>
      </div>
      <div class="card">
        <h3>🎮 魔法翻翻乐</h3>"""

d = d.replace(old_act_title, new_act_title)

# 加JS函数
old_load_stats = """async function loadActivityStats() {"""
new_load_stats = """async function toggleMaintenance() {
  const on = $('maintSwitch').checked;
  try {
    await authFetch('/api/admin/activity-maintenance', { method: 'POST', body: JSON.stringify({ maintenance: on }) });
    $('maintLabel').textContent = on ? '已开启' : '已关闭';
  } catch(e) { alert(e.message); }
}
async function loadMaintenanceStatus() {
  try {
    const j = await authFetch('/api/admin/activity-maintenance');
    $('maintSwitch').checked = j.maintenance;
    $('maintLabel').textContent = j.maintenance ? '已开启' : '已关闭';
  } catch(e) {}
}
async function loadActivityStats() {"""

d = d.replace(old_load_stats, new_load_stats)

# 在loadActivityStats里加加载维护状态
d = d.replace(
  "async function loadActivityStats() {\n  try {",
  "async function loadActivityStats() {\n  loadMaintenanceStatus();\n  try {"
)

with open(dp, 'w', encoding='utf-8') as f:
    f.write(d)
print("管理员维护开关UI已添加")
