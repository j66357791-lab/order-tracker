wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

old_game1 = '''        <!-- 魔法翻翻乐 -->
        <div class="act-panel" id="atGame">
          <div class="act-card" style="margin:0;text-align:center;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none">
            <div style="font-size:48px;margin-bottom:8px">🎴</div>
            <h3 style="color:#fff">魔法翻翻乐</h3>
            <div style="font-size:12px;opacity:.9;margin:8px 0 16px">限时活动 · 9月12日~10月31日<br>翻牌赢钥匙·碎片·现金福袋</div>
            <button class="act-btn act-btn-gold" onclick="location.href='/game.html'" style="background:#ffd700;color:#333;font-weight:700">🎮 立即开始</button>
          </div>
        </div>'''

new_game1 = '''        <!-- 魔法翻翻乐 -->
        <div class="act-panel" id="atGame">
          <div class="act-card" style="margin:0;padding:0;overflow:hidden;border:none;border-radius:12px">
            <img src="/assets/game-banner.jpg" style="width:100%;display:block;cursor:pointer" onclick="location.href='/game.html'">
          </div>
        </div>'''

if old_game1 in w:
    w = w.replace(old_game1, new_game1)
    print("翻翻乐横幅已替换")
else:
    print("未找到原代码")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
