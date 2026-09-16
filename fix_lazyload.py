wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 给两张横幅加懒加载
w = w.replace('<img src="/assets/banner-fanfanle.jpg"', '<img loading="lazy" src="/assets/banner-fanfanle.jpg"')
w = w.replace('<img src="/assets/banner-shanhai.jpg"', '<img loading="lazy" src="/assets/banner-shanhai.jpg"')

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("懒加载已添加")
