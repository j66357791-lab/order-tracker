"""修复动画：用animation而不是transition"""
wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 删掉之前加的有问题的动画CSS
old_css_start = "  /* 公告弹窗动画 */"
old_css_end = "  #convList{transition:width .3s cubic-bezier(.4,0,.2,1)}\n"
idx1 = w.find(old_css_start)
idx2 = w.find(old_css_end)
if idx1 > -1 and idx2 > -1:
    w = w[:idx1] + w[idx2 + len(old_css_end):]
    print("旧动画CSS已删除")

# 新的动画CSS（用@keyframes，兼容display:none切换）
new_anim = """
  /* 弹窗打开动画 */
  @keyframes popIn{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}
  @keyframes popOut{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.2) translate(300px,-400px)}}
  .modal-mask.on{display:flex;animation:popIn .3s ease}
  .checkin-result.on{display:flex;animation:popIn .3s ease}
  /* tab切换动画 */
  @keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
  .panel.on{animation:slideIn .25s ease;will-change:opacity,transform}
  /* 侧边栏tab动画 */
  .act-tab{transition:all .2s cubic-bezier(.4,0,.2,1)}
  /* 聊天列表收起动画 */
  #convList{transition:width .3s cubic-bezier(.4,0,.2,1)}
"""
w = w.replace("</style>", new_anim + "\n</style>", 1)

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("动画CSS已更新")
