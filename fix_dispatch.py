p = r'C:\Users\某某\Desktop\接单后台\public\dispatch.html'
with open(p, 'r', encoding='utf-8') as f:
    c = f.read()

old1 = "$('adContent') && $('adContent').oninput = renderAdPreview;"
new1 = "if($('adContent'))$('adContent').oninput = renderAdPreview;"
if old1 in c:
    c = c.replace(old1, new1)
    print("修复1: adContent oninput")

old2 = "$('btnSaveAd') && ($('btnSaveAd').onclick = async () => {"
new2 = "if($('btnSaveAd'))$('btnSaveAd').onclick = async () => {"
if old2 in c:
    c = c.replace(old2, new2)
    print("修复2: btnSaveAd onclick")

with open(p, 'w', encoding='utf-8') as f:
    f.write(c)
print("完成")
