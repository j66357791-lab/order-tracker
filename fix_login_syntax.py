lp = r'C:\Users\某某\Desktop\接单后台\public\login.html'
with open(lp, 'r', encoding='utf-8') as f:
    l = f.read()

# 修复语法错误：把错误的 } catch(e){} 替换成正确的 try-catch
old = """(async () => {
  const r = await fetch('/api/setup/state');
  const j = await r.json();
  if (j.needsSetup) { $('setupBox').classList.remove('hidden'); $('mainBox').classList.add('hidden'); $('subTip').textContent = '检测到系统未初始化'; }
  } catch(e){}
  if (localStorage.getItem('jdy_token')) {"""

new = """(async () => {
  try {
    const r = await fetch('/api/setup/state');
    const j = await r.json();
    if (j.needsSetup) { $('setupBox').classList.remove('hidden'); $('mainBox').classList.add('hidden'); $('subTip').textContent = '检测到系统未初始化'; }
  } catch(e) {}
  if (localStorage.getItem('jdy_token')) {"""

if old in l:
    l = l.replace(old, new)
    print("语法错误已修复")
else:
    print("未找到原文")

with open(lp, 'w', encoding='utf-8') as f:
    f.write(l)
