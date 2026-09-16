wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 1. 翻翻乐横幅（当前是合并的，改成分开的）
old1 = '''        <!-- 限时活动：游戏中心 -->
        <div class="act-panel" id="atGame">
          <div class="act-card" style="margin:0;padding:0;overflow:hidden;border:none;border-radius:12px">
            <img src="/assets/game-banner.jpg" style="width:100%;display:block;cursor:pointer" onclick="location.href='/game.html'">
          </div>
        </div>'''

new1 = '''        <!-- 限时活动：魔法翻翻乐 -->
        <div class="act-panel" id="atGame">
          <div class="act-card" style="margin:0;padding:0;overflow:hidden;border:none;border-radius:12px;margin-bottom:10px">
            <img src="/assets/banner-fanfanle.jpg" style="width:100%;display:block;cursor:pointer" onclick="location.href='/game.html'">
          </div>
        </div>'''

w = w.replace(old1, new1)

# 2. 山海斩妖录横幅
old2 = '''        <!-- 限时活动：山海斩妖录（割草） -->
        <div class="act-panel" id="atGame2">
          <div class="act-card" style="margin:0;text-align:center;background:linear-gradient(135deg,#1A3A32,#2C5A48);color:#fff;border:none">
            <div style="font-size:48px;margin-bottom:8px">⚔️</div>
            <h3 style="color:#8AF0CE">山海斩妖录</h3>
            <div style="font-size:12px;opacity:.9;margin:8px 0 16px">山海经异兽围剿 · 御火割草<br>15波斩山臊王 · 冲击斩妖榜</div>
            <button class="act-btn act-btn-gold" onclick="location.href='/games/shanhai/index.html'" style="background:#3EC9A0;color:#0E2420;font-weight:700">⚔️ 入局斩妖</button>
          </div>
        </div>'''

new2 = '''        <!-- 限时活动：山海斩妖录 -->
        <div class="act-panel" id="atGame2">
          <div class="act-card" style="margin:0;padding:0;overflow:hidden;border:none;border-radius:12px">
            <img src="/assets/banner-shanhai.jpg" style="width:100%;display:block;cursor:pointer" onclick="location.href='/games/shanhai/index.html'">
          </div>
        </div>'''

w = w.replace(old2, new2)

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("两个横幅已替换")
