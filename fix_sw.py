sw = r'C:\Users\某某\Desktop\接单后台\public\service-worker.js'
with open(sw, 'r', encoding='utf-8') as f:
    w = f.read()

w = w.replace("jiedan-v3-20260911b", "jiedan-v4-20260913")
w = w.replace("'/icon-512.png',", "'/icon-512.png',\n  '/assets/banner-fanfanle.jpg',\n  '/assets/banner-shanhai.jpg',")

with open(sw, 'w', encoding='utf-8') as f:
    f.write(w)
print("SW缓存已更新")
