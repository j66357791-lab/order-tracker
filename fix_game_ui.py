gp = r'C:\Users\某某\Desktop\接单后台\public\game.html'
with open(gp, 'r', encoding='utf-8') as f:
    g = f.read()

# 1. 修复invHTML：加图标映射
old_inv = """function invHTML(p){ return [['keys','钥匙'],['balls','魔法球'],['frags','碎片'],['revives','复活石'],['bagS','福袋·小'],['bagM','福袋·中'],['bagL','福袋·大']].map(([k,lbl]) =>
  `<div class="inv-item"><img src="${ICO[k]}"><div class="num">${p[k]||0}</div><div class="lbl">${lbl}</div></div>`).join(''); }"""

new_inv = """function invHTML(p){ const ICON_MAP = { keys:'key', balls:'ball', frags:'frag', revives:'revive', bagS:'bagS', bagM:'bagM', bagL:'bagL' };
  return [['keys','钥匙'],['balls','魔法球'],['frags','碎片'],['revives','复活石'],['bagS','福袋·小'],['bagM','福袋·中'],['bagL','福袋·大']].map(([k,lbl]) =>
  `<div class="inv-item"><img src="${ICO[ICON_MAP[k]]}"><div class="num">${p[k]||0}</div><div class="lbl">${lbl}</div></div>`).join(''); }"""

g = g.replace(old_inv, new_inv)

# 2. 修复退出按钮：返回写手端而不是登录页
g = g.replace('onclick="logout()"', 'onclick="location.href=\'/writer.html\'"')

# 3. 任务专区移到底部，适配风格
old_task_zone = """    <!-- 任务专区 -->
    <div style="margin:10px 0;padding:12px;background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
      <div style="font-size:14px;font-weight:700;margin-bottom:10px">📋 任务专区</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:center;gap:10px;padding:8px;background:#f8f9fa;border-radius:8px">
          <div style="font-size:20px">🔑</div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">每日登录</div>
            <div style="font-size:11px;color:#999">每天登录领取 1 把钥匙</div>
          </div>
          <span style="font-size:11px;color:#27c">每日</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;padding:8px;background:#f8f9fa;border-radius:8px;opacity:.5">
          <div style="font-size:20px">🎮</div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">完成 1 局游戏</div>
            <div style="font-size:11px;color:#999">完成1局（不论输赢）奖励1碎片</div>
          </div>
          <span style="font-size:11px;color:#999">即将上线</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;padding:8px;background:#f8f9fa;border-radius:8px;opacity:.5">
          <div style="font-size:20px">👥</div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">邀请好友</div>
            <div style="font-size:11px;color:#999">邀请1人注册并完成首局奖励5钥匙</div>
          </div>
          <span style="font-size:11px;color:#999">即将上线</span>
        </div>
      </div>
    </div>"""

new_task_zone = """    <!-- 任务专区 -->
    <div class="task-bar" style="margin-top:10px">
      <img src="https://sfile.chatglm.cn/workspace/image/a2/a2108f7259.png" alt="">
      <div class="t-info">
        <div class="t-name">📋 任务专区</div>
        <div class="t-desc">每日登录领钥匙 · 完成游戏赢碎片 · 邀请好友得奖励</div>
      </div>
      <button class="btn btn-ghost" onclick="showTasks()">查看全部</button>
    </div>"""

g = g.replace(old_task_zone, new_task_zone)

with open(gp, 'w', encoding='utf-8') as f:
    f.write(g)
print("图标+退出+任务区已修复")
