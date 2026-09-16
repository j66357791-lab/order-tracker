gp = r'C:\Users\某某\Desktop\接单后台\public\game.html'
with open(gp, 'r', encoding='utf-8') as f:
    g = f.read()

# 在每日任务下面加任务专区
old_daily = """    <div class="task-bar">
      <img src="https://sfile.chatglm.cn/workspace/image/a2/a2108f7259.png" alt="">
      <div class="t-info">
        <div class="t-name">每日任务 · 领取魔法钥匙</div>
        <div class="t-desc">每天可免费领取 1 把魔法钥匙</div>
      </div>
      <button class="btn" id="btnDaily" onclick="claimDaily()">领取</button>
    </div>"""

new_daily = """    <div class="task-bar">
      <img src="https://sfile.chatglm.cn/workspace/image/a2/a2108f7259.png" alt="">
      <div class="t-info">
        <div class="t-name">每日任务 · 领取魔法钥匙</div>
        <div class="t-desc">每天可免费领取 1 把魔法钥匙</div>
      </div>
      <button class="btn" id="btnDaily" onclick="claimDaily()">领取</button>
    </div>
    <!-- 任务专区 -->
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

g = g.replace(old_daily, new_daily)

with open(gp, 'w', encoding='utf-8') as f:
    f.write(g)
print("任务专区已添加")
