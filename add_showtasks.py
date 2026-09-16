gp = r'C:\Users\某某\Desktop\接单后台\public\game.html'
with open(gp, 'r', encoding='utf-8') as f:
    g = f.read()

# 在gameOver函数前面加showTasks
old_backhome = "function backHome(){"
new_backhome = """function showTasks(){
  modal(`<h3>📋 全部任务</h3>
    <div style="display:flex;flex-direction:column;gap:10px;margin:12px 0">
      <div style="display:flex;align-items:center;gap:10px;padding:10px;background:#f8f9fa;border-radius:10px">
        <img src="${ICO.key}" style="width:32px;height:32px">
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600">每日登录</div>
          <div style="font-size:11px;color:#999">每天登录领取 1 把钥匙</div>
        </div>
        <span style="font-size:11px;color:#27c">每日可做</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px;background:#f8f9fa;border-radius:10px;opacity:.5">
        <img src="${ICO.frag}" style="width:32px;height:32px">
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600">完成 1 局游戏</div>
          <div style="font-size:11px;color:#999">完成1局（不论输赢）奖励1碎片</div>
        </div>
        <span style="font-size:11px;color:#999">即将上线</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px;background:#f8f9fa;border-radius:10px;opacity:.5">
        <img src="${ICO.key}" style="width:32px;height:32px">
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600">邀请好友</div>
          <div style="font-size:11px;color:#999">邀请1人注册并完成首局奖励5钥匙</div>
        </div>
        <span style="font-size:11px;color:#999">即将上线</span>
      </div>
    </div>
    <div class="m-btns"><button class="btn" onclick="closeModal()">关闭</button></div>`);
}
function backHome(){"""

g = g.replace(old_backhome, new_backhome)

with open(gp, 'w', encoding='utf-8') as f:
    f.write(g)
print("showTasks弹窗已添加")
