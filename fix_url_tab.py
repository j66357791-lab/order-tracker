wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

old = "if (!TOKEN || !USER) location.href = '/login.html';\nlet ME = null;"
new = """if (!TOKEN || !USER) location.href = '/login.html';
let ME = null;

// URL参数：?tab=game 直接切游戏tab
(function(){
  const p = new URLSearchParams(location.search);
  if(p.get('tab')==='game'){
    setTimeout(()=>{
      document.querySelectorAll('.act-tab').forEach(t=>t.classList.remove('on'));
      document.querySelectorAll('.act-panel').forEach(p=>p.classList.remove('on'));
      const t = document.querySelector('[data-at="atGame"]');
      if(t){ t.classList.add('on'); document.getElementById('atGame').classList.add('on'); }
      document.getElementById('atGame')?.scrollIntoView({behavior:'smooth'});
    }, 800);
  }
})();"""

if old in w:
    w = w.replace(old, new)
    print("URL参数处理已加")
else:
    print("未找到原代码，换个方式")
    # 找 if (!TOKEN
    lines = w.split('\n')
    for i, line in enumerate(lines):
        if 'if (!TOKEN || !USER)' in line:
            insert_pos = i + 2  # 在let ME = null;后面
            new_lines = """
// URL参数：?tab=game 直接切游戏tab
(function(){
  const p = new URLSearchParams(location.search);
  if(p.get('tab')==='game'){
    setTimeout(()=>{
      document.querySelectorAll('.act-tab').forEach(t=>t.classList.remove('on'));
      document.querySelectorAll('.act-panel').forEach(p=>p.classList.remove('on'));
      const t = document.querySelector('[data-at="atGame"]');
      if(t){ t.classList.add('on'); document.getElementById('atGame').classList.add('on'); }
      document.getElementById('atGame')?.scrollIntoView({behavior:'smooth'});
    }, 800);
  }
})();
""".strip()
            lines.insert(insert_pos, new_lines)
            w = '\n'.join(lines)
            print(f"在第{insert_pos}行插入URL参数处理")
            break

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
