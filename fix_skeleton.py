wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 1. 给聊天图片加骨架屏动画
old_css = '.imgmsg{max-width:220px;max-height:220px;border-radius:10px;display:block;cursor:zoom-in;background:#f8fafc}'
new_css = '.imgmsg{max-width:220px;max-height:220px;border-radius:10px;display:block;cursor:zoom-in;background:linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 50%,#f0f0f0 75%);background-size:200% 100%;animation:skeleton 1.5s infinite}'

if old_css in w:
    w = w.replace(old_css, new_css)
    print("聊天图片骨架屏已加")
else:
    print("未找到聊天图片CSS")

# 加骨架屏动画关键帧（如果还没有）
if '@keyframes skeleton' not in w:
    # 在.media查询前面加
    w = w.replace(
        '@media(max-width:640px){.imgmsg{max-width:150px;max-height:150px}}',
        '@keyframes skeleton{0%{background-position:200% 0}100%{background-position:-200% 0}}\n  @media(max-width:640px){.imgmsg{max-width:150px;max-height:150px}}'
    )
    print("骨架屏动画关键帧已加")

# 2. 给游戏横幅加骨架屏效果（用背景渐变代替白屏）
# 横幅图片容器
old_banner1 = '<div class="act-card" style="margin:0;padding:0;overflow:hidden;border:none;border-radius:12px;margin-bottom:10px">\n            <img loading="lazy" src="/assets/banner-fanfanle.jpg"'
new_banner1 = '<div class="act-card" style="margin:0;padding:0;overflow:hidden;border:none;border-radius:12px;margin-bottom:10px;background:linear-gradient(90deg,#2d1b4e 25%,#3d2b5e 50%,#2d1b4e 75%);background-size:200% 100%;animation:skeleton 1.5s infinite;min-height:90px">\n            <img loading="lazy" src="/assets/banner-fanfanle.jpg"'

if old_banner1 in w:
    w = w.replace(old_banner1, new_banner1)
    print("翻翻乐横幅骨架屏已加")
else:
    print("未找到翻翻乐横幅")

old_banner2 = '<div class="act-card" style="margin:0;padding:0;overflow:hidden;border:none;border-radius:12px">\n            <img loading="lazy" src="/assets/banner-shanhai.jpg"'
new_banner2 = '<div class="act-card" style="margin:0;padding:0;overflow:hidden;border:none;border-radius:12px;background:linear-gradient(90deg,#1a3a2e 25%,#2a4a3e 50%,#1a3a2e 75%);background-size:200% 100%;animation:skeleton 1.5s infinite;min-height:90px">\n            <img loading="lazy" src="/assets/banner-shanhai.jpg"'

if old_banner2 in w:
    w = w.replace(old_banner2, new_banner2)
    print("斩妖录横幅骨架屏已加")
else:
    print("未找到斩妖录横幅")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("完成")
