wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

old = """// URL参数：?tab=game 直接切游戏tab
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

new = """// URL参数：?tab=game 直接切游戏tab
(function(){
  const p = new URLSearchParams(location.search);
  if(p.get('tab')==='game'){
    window.addEventListener('load', () => {
      setTimeout(() => {
        const t = document.querySelector('.act-tab[data-at="atGame"]');
        if(t) t.click();
      }, 1000);
    });
  }
})();"""

if old in w:
    w = w.replace(old, new)
    print("URL参数处理已修复")
else:
    print("未找到原代码")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
