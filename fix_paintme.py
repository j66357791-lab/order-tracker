wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 把 paintMeExtras 改成 async
w = w.replace("function paintMeExtras() {", "async function paintMeExtras() {")

# paintMe 里调用 paintMeExtras() 改成不阻塞
w = w.replace("paintMeExtras();", "paintMeExtras().catch(()=>{});")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("修复完成")
