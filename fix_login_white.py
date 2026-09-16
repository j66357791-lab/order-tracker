lp = r'C:\Users\某某\Desktop\接单后台\public\login.html'
with open(lp, 'r', encoding='utf-8') as f:
    l = f.read()

# 1. mainBox默认显示，不hidden
l = l.replace('<div id="mainBox" class="hidden">', '<div id="mainBox">')

# 2. 如果needsSetup=true，隐藏mainBox显示setupBox
l = l.replace(
    "if (j.needsSetup) { $('setupBox').classList.remove('hidden'); $('subTip').textContent = '检测到系统未初始化'; }\n  else $('mainBox').classList.remove('hidden');",
    "if (j.needsSetup) { $('setupBox').classList.remove('hidden'); $('mainBox').classList.add('hidden'); $('subTip').textContent = '检测到系统未初始化'; }"
)

# 3. 加catch：API失败也显示登录框
l = l.replace(
    "  if (localStorage.getItem('jdy_token')) {",
    "  } catch(e){}\n  if (localStorage.getItem('jdy_token')) {"
)

with open(lp, 'w', encoding='utf-8') as f:
    f.write(l)
print("login.html 已修复：默认显示登录框")
