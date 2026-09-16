wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 修改 closeAdPopup 函数：关闭时先播放飞入动画
old_close = """function closeAdPopup(dontRemind) {
  const mask = document.getElementById('adPopup');
  if (!mask) return;
  if (dontRemind && document.getElementById('adDontRemind').checked) {
    localStorage.setItem('adDismissDate', new Date().toISOString().slice(0,10));
  }
  mask.classList.remove('on');
}"""
new_close = """function closeAdPopup(dontRemind) {
  const mask = document.getElementById('adPopup');
  if (!mask) return;
  if (dontRemind && document.getElementById('adDontRemind').checked) {
    localStorage.setItem('adDismissDate', new Date().toISOString().slice(0,10));
  }
  // 播放飞入动画
  mask.style.animation = 'popOut .35s ease forwards';
  setTimeout(() => {
    mask.classList.remove('on');
    mask.style.animation = '';
  }, 350);
}"""
if old_close in w:
    w = w.replace(old_close, new_close)
    print("closeAdPopup已修改")
else:
    print("未找到closeAdPopup，尝试其他方式")
    # 用正则
    import re
    w = re.sub(r'function closeAdPopup\(dontRemind\)\s*\{[^}]+\}', new_close, w)

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("完成")
