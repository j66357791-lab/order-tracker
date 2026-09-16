wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 回退到原来的简单tab切换
old_tab = """document.querySelectorAll('.act-tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.act-tab').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.act-panel').forEach(x => x.classList.remove('on'));
  t.classList.add('on');
  document.getElementById(t.dataset.at).classList.add('on');
  // 点游戏tab时检查维护状态
  if (t.dataset.at === 'atGame') {
    fetch('/api/game/state', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('jdy_token') } })
      .then(r => r.json())
      .then(j => {
        if (j.maintenance) {
          document.getElementById('atGame').innerHTML = '<div class="act-card" style="margin:0;text-align:center;padding:40px 20px"><div style="font-size:48px;margin-bottom:12px">🔧</div><h3>活动维护中</h3><div style="font-size:13px;color:var(--sub);margin-top:8px">活动正在升级优化，稍后再来玩吧~</div></div>';
        } else {
          // 恢复原来的内容
          document.getElementById('atGame').innerHTML = '<div class="act-card" style="margin:0;text-align:center;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none"><div style="font-size:48px;margin-bottom:8px">🎴</div><h3 style="color:#fff">魔法翻翻乐</h3><div style="font-size:12px;opacity:.9;margin:8px 0 16px">限时活动 · 9月12日~10月31日<br>翻牌赢钥匙·碎片·现金福袋</div><button class="act-btn act-btn-gold" onclick="location.href=\\'/game.html\\'" style="background:#ffd700;color:#333;font-weight:700">🎮 立即开始</button></div>';
        }
      })
      .catch(() => {});
  }
});"""

new_tab = """document.querySelectorAll('.act-tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.act-tab').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.act-panel').forEach(x => x.classList.remove('on'));
  t.classList.add('on');
  document.getElementById(t.dataset.at).classList.add('on');
  if (t.dataset.at === 'atGame') loadGameEntry();
});"""

if old_tab in w:
    w = w.replace(old_tab, new_tab)
    print("已简化tab切换")
else:
    print("没找到旧代码，直接替换整个块")
    # 找整个块替换
    import re
    pattern = r"document\.querySelectorAll\('\.act-tab'\)\.forEach\(t => t\.onclick = \(\) => \{.*?\}\);"
    w = re.sub(pattern, new_tab, w, flags=re.DOTALL)
    print("已用正则替换")

# 加loadGameEntry函数（简单版，避免引号问题）
load_func = """
async function loadGameEntry() {
  try {
    const r = await fetch('/api/game/state', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('jdy_token') } });
    const j = await r.json();
    const panel = document.getElementById('atGame');
    if (!panel) return;
    if (j.maintenance) {
      panel.innerHTML = '<div style="text-align:center;padding:40px 20px"><div style="font-size:48px">🔧</div><h3>活动维护中</h3><p style="color:#999;font-size:13px;margin-top:8px">活动正在升级优化，稍后再来玩吧</p></div>';
    }
  } catch(e) {}
}
"""

w = w.replace("/* 签到 */", load_func + "\n/* 签到 */")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("已修复")
