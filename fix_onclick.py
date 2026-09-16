"""修复所有顶层onclick绑定null元素的问题"""
wp = r"C:\Users\某某\Desktop\接单后台\public\writer.html"
with open(wp, "r", encoding="utf-8") as f:
    w = f.read()

# 所有顶层 $xxx.onclick = 绑定，加上 if 判断
# 已删除的元素：btnSched, attMonth, calMonth, btnClock, shiftPool, schedRows, attRows, clockNow, shiftState, calGrid
# 但为了安全，给所有顶层绑定都加 if

import re

# 匹配顶层 $('elementId').onclick = ... 的模式
# 转换为 if($('elementId')) $('elementId').onclick = ...
# 注意多行的情况

# 先处理 btnSched
w = w.replace("$('btnSched').onclick = async () => {",
              "if($('btnSched'))$('btnSched').onclick = async () => {")

# 检查其他可能已删除的元素
# btnMail, spBack, btnAddFriend, ctLater, ctSign, btnEditName, btnLogout2, btnSwitch, convToggle, btnChatMenu, btnSend, btnPlus, btnAli
# 这些应该都还在，但保险起见也检查一下

# 让我搜索所有引用已删除元素的代码
deleted_elements = ['btnSched', 'attMonth', 'calMonth', 'btnClock', 'shiftPool', 'schedRows', 'attRows', 'clockNow', 'shiftState', 'calGrid']
for el in deleted_elements:
    # 找所有 $(el) 的使用，如果不是在 if 里，就加上 if
    # 简单处理：把 $(el).onchange, $(el).onclick, $(el).value 等顶层使用都包在 if 里
    pass

# 直接把所有顶层 $(xxx).onclick = 都包在 if 里
# 用正则匹配行首的 $(...).onclick =
lines = w.split('\n')
new_lines = []
for line in lines:
    stripped = line.lstrip()
    # 如果是顶层 onclick 绑定（行首就是 $）
    if re.match(r"^\$\('[^']+'\)\.onclick\s*=", stripped):
        # 提取元素id
        m = re.match(r"^(\$\('[^']+'\))\.onclick\s*=(.*)", stripped)
        if m:
            el = m.group(1)
            rest = m.group(2)
            indent = line[:len(line) - len(stripped)]
            new_lines.append(f"{indent}if({el}){el}.onclick ={rest}")
            continue
    new_lines.append(line)
w = '\n'.join(new_lines)

with open(wp, "w", encoding="utf-8") as f:
    f.write(w)
print("修复完成")
