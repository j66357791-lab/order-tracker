wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 1. 侧边栏加游戏tab
old_tabs = """        <div class="act-tab" data-at="atMonth">🏆<small>月度</small></div>
        """
new_tabs = """        <div class="act-tab" data-at="atMonth">🏆<small>月度</small></div>
        <div class="act-tab" data-at="atGame">🎮<small>游戏</small></div>
"""
w = w.replace(old_tabs, new_tabs)

# 2. 月度面板后面加游戏面板
old_month_end = """        </div>
        
        </div>
      </div>
    </div>
  </section>"""

new_month_end = """        </div>
        <!-- 限时活动：魔法翻翻乐 -->
        <div class="act-panel" id="atGame">
          <div class="act-card" style="margin:0;text-align:center;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none">
            <div style="font-size:48px;margin-bottom:8px">🎴</div>
            <h3 style="color:#fff">魔法翻翻乐</h3>
            <div style="font-size:12px;opacity:.9;margin:8px 0 16px">限时活动 · 9月12日~10月31日<br>翻牌赢钥匙·碎片·现金福袋</div>
            <button class="act-btn act-btn-gold" onclick="location.href='/game.html'" style="background:#ffd700;color:#333;font-weight:700">🎮 立即开始</button>
          </div>
        </div>
        </div>
      </div>
    </div>
  </section>"""

w = w.replace(old_month_end, new_month_end)

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("游戏入口已添加")
