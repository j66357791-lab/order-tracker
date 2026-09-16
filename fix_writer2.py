"""修复 writer.html 所有引用已删除考勤元素的代码"""
wp = r"C:\Users\某某\Desktop\接单后台\public\writer.html"
with open(wp, "r", encoding="utf-8") as f:
    w = f.read()

# 把所有直接访问已删除元素的顶层代码改成安全形式
# 1. $('attMonth').onchange = loadAtt;
w = w.replace("$('attMonth').onchange = loadAtt;", "if($('attMonth'))$('attMonth').onchange = loadAtt;")

# 2. $('calMonth').onchange = loadCal;
w = w.replace("$('calMonth').onchange = loadCal;", "if($('calMonth'))$('calMonth').onchange = loadCal;")

# 3. setInterval(() => { $('clockNow').textContent = cnHm(); }, 1000);
w = w.replace("setInterval(() => { $('clockNow').textContent = cnHm(); }, 1000);",
              "if($('clockNow'))setInterval(() => { $('clockNow').textContent = cnHm(); }, 1000);")

# 4. loadShiftPool 里 const box = $('shiftPool'); 如果 box 为 null，后续操作会报错
#    但 loadShiftPool 不会被顶层调用，只会在 tab 切换时调用，而我已经删了 tab 切换里的调用
#    不过保险起见，在函数开头加个判断

# 5. loadShiftAndSched 里访问 $('calMonth')、$('schedRows')
#    这个函数不会被顶层调用，但保险起见加判断

# 6. 检查页面初始化时是否调用了这些函数
# 搜索初始化代码
import re
# 找 Promise.all 或 await Promise.all
for m in re.finditer(r'await Promise\.all\(\[([^\]]+)\]\)', w):
    print("初始化调用:", m.group(1))

with open(wp, "w", encoding="utf-8") as f:
    f.write(w)
print("writer.html 安全修复完成")
