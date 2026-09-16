# 1. 翻翻乐 game.html - 退出/返回按钮加参数
game_html = r'C:\Users\某某\Desktop\接单后台\public\game.html'
with open(game_html, 'r', encoding='utf-8') as f:
    w = f.read()

w = w.replace("location.href='/writer.html'", "location.href='/writer.html?tab=game'")
w = w.replace("location.href='/writer.html'", "location.href='/writer.html?tab=game'")

with open(game_html, 'w', encoding='utf-8') as f:
    f.write(w)
print("翻翻乐返回已改")

# 2. 山海斩妖录 index.html - 返回网站按钮加参数
sh_html = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\index.html'
with open(sh_html, 'r', encoding='utf-8') as f:
    w = f.read()

w = w.replace("location.href='/writer.html'", "location.href='/writer.html?tab=game'")

with open(sh_html, 'w', encoding='utf-8') as f:
    f.write(w)
print("斩妖录返回已改")

# 3. writer.html - 加载时检查URL参数，自动切到游戏tab
wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 在初始化代码里加URL参数处理
old_init = "// 初始化活动中心"
new_init = """// URL参数：?tab=game 直接切游戏tab
(function(){
  const p = new URLSearchParams(location.search);
  if(p.get('tab')==='game'){
    setTimeout(()=>{
      document.querySelectorAll('.act-tab').forEach(t=>t.classList.remove('on'));
      document.querySelectorAll('.act-panel').forEach(p=>p.classList.remove('on'));
      const t = document.querySelector('[data-at="atGame"]');
      if(t){ t.classList.add('on'); document.getElementById('atGame').classList.add('on'); }
      // 滚到游戏位置
      document.getElementById('atGame')?.scrollIntoView({behavior:'smooth'});
    }, 500);
  }
})();

// 初始化活动中心"""

if old_init in w:
    w = w.replace(old_init, new_init)
    print("writer.html URL参数处理已加")
else:
    print("未找到初始化代码，找别的位置加")
    # 在DOMContentLoaded前面加
    if "DOMContentLoaded" in w:
        w = w.replace("DOMContentLoaded", """(function(){
  const p = new URLSearchParams(location.search);
  if(p.get('tab')==='game'){
    setTimeout(()=>{
      document.querySelectorAll('.act-tab').forEach(t=>t.classList.remove('on'));
      document.querySelectorAll('.act-panel').forEach(p=>p.classList.remove('on'));
      const t = document.querySelector('[data-at="atGame"]');
      if(t){ t.classList.add('on'); document.getElementById('atGame').classList.add('on'); }
      document.getElementById('atGame')?.scrollIntoView({behavior:'smooth'});
    }, 500);
  }
})();
DOMContentLoaded""")
        print("writer.html URL参数处理已加(DOMContentLoaded前)")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("完成")
