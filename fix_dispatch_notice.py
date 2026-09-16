dp = r'C:\Users\某某\Desktop\接单后台\public\dispatch.html'
with open(dp, 'r', encoding='utf-8') as f:
    d = f.read()

# 删除站内信 JS 块（从 /* 站内信 */ 到下一个注释块）
import re
d = re.sub(r'/\* =+ 站内信 =+ \*/.*?(?=/\* =+|\Z)', '', d, flags=re.DOTALL)

with open(dp, 'w', encoding='utf-8') as f:
    f.write(d)
print("dispatch 站内信JS已删除")
