wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 改loadGameEntry：维护中变灰+水印，不整页替换
old_func = """async function loadGameEntry() {
  try {
    const r = await fetch('/api/game/state', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('jdy_token') } });
    const j = await r.json();
    const panel = document.getElementById('atGame');
    if (!panel) return;
    if (j.maintenance) {
      panel.innerHTML = '<div style="text-align:center;padding:40px 20px"><div style="font-size:48px">🔧</div><h3>活动维护中</h3><p style="color:#999;font-size:13px;margin-top:8px">活动正在升级优化，稍后再来玩吧</p></div>';
    }
  } catch(e) {}
}"""

new_func = """async function loadGameEntry() {
  try {
    const r = await fetch('/api/game/state', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('jdy_token') } });
    const j = await r.json();
    const panel = document.getElementById('atGame');
    if (!panel) return;
    const card = panel.querySelector('.act-card');
    if (!card) return;
    if (j.maintenance) {
      card.style.opacity = '0.5';
      card.style.pointerEvents = 'none';
      if (!card.querySelector('.maint-wm')) {
        const wm = document.createElement('div');
        wm.className = 'maint-wm';
        wm.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:24px;font-weight:900;color:#fff;background:rgba(0,0,0,0.6);padding:8px 20px;border-radius:8px;letter-spacing:2px';
        wm.textContent = '🔧 维护中';
        card.style.position = 'relative';
        card.appendChild(wm);
      }
    } else {
      card.style.opacity = '1';
      card.style.pointerEvents = 'auto';
      const wm = card.querySelector('.maint-wm');
      if (wm) wm.remove();
    }
  } catch(e) {}
}"""

w = w.replace(old_func, new_func)

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("入口维护样式已改")
