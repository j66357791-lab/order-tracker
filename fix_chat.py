wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 1. 在 loadChats 函数前加 convSearchQ 全局变量
w = w.replace(
    "async function loadChats() {",
    "let convSearchQ = '';\nasync function loadChats() {"
)

# 2. 搜索框 oninput 里的 renderChats() 改成 loadChats()
w = w.replace("renderChats();", "loadChats();")

# 3. 修复活动中心：去掉公告tab，改成站内信合并
# 删除活动侧边栏里的公告tab
w = w.replace(
    '<div class="act-tab" data-at="atNotice">📢<small>公告</small></div>',
    ''
)
# 删除活动内容区的公告面板
import re
w = re.sub(r'<!-- 公告 -->.*?<div id="adContent">.*?</div>\s*</div>\s*</div>', '', w, flags=re.DOTALL)

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("修复完成")
