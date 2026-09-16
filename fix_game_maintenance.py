gp = r'C:\Users\某某\Desktop\接单后台\public\game.html'
with open(gp, 'r', encoding='utf-8') as f:
    g = f.read()

# 在refresh函数里检查维护状态
old_refresh = """async function refresh(){ STATE = await api('/api/game/state'); render(); }"""
new_refresh = """async function refresh(){
  STATE = await api('/api/game/state');
  if (STATE.maintenance) {
    $('pageHome').classList.add('hidden');
    $('pageGame').classList.add('hidden');
    $('pageShop').classList.add('hidden');
    document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-align:center;padding:20px"><div style="font-size:64px;margin-bottom:20px">🔧</div><h2>活动维护中</h2><p style="opacity:.8;margin-top:10px">活动正在升级优化，稍后再来玩吧~</p><button class="btn" style="margin-top:20px;background:#fff;color:#667eea" onclick="location.href=\'/writer.html\'">返回</button></div>';
    return;
  }
  render();
}"""

g = g.replace(old_refresh, new_refresh)

with open(gp, 'w', encoding='utf-8') as f:
    f.write(g)
print("game.html维护提示已添加")
