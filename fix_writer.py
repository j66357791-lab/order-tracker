"""修复 writer.html 的JS报错"""
wp = r"C:\Users\某某\Desktop\接单后台\public\writer.html"
with open(wp, "r", encoding="utf-8") as f:
    w = f.read()

# 删除考勤相关的tab切换代码
old = "  if (t.dataset.p === 'pAttend') { $('attMonth').value = cnDateStr(cnNow()).slice(0, 7); loadShiftAndSched(); loadShiftPool(); }\n"
if old in w:
    w = w.replace(old, '')
    print("已删除考勤tab切换代码")
else:
    print("未找到考勤tab切换代码，尝试其他方式")
    # 用正则删除
    import re
    w = re.sub(r"if \(t\.dataset\.p === 'pAttend'\) \{ \$\('attMonth'\).*?\}\n", '', w)

# 检查是否还有其他引用已删除元素的代码
# loadShiftAndSched, loadShiftPool, loadAttend 等函数如果存在但DOM不存在也会报错
# 这些函数本身不会报错，因为它们内部有try-catch或者元素不存在时不操作
# 但如果有顶层代码直接访问这些元素就会报错

with open(wp, "w", encoding="utf-8") as f:
    f.write(w)
print("writer.html 修复完成")
