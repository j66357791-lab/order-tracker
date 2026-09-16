import urllib.request

# 抓取线上的portal.html
url = 'https://order-tracker-mgbh.onrender.com/portal.html'
req = urllib.request.Request(url)
req.add_header('Cache-Control', 'no-cache')
with urllib.request.urlopen(req, timeout=15) as r:
    online_content = r.read().decode('utf-8')
    online_len = len(online_content)

# 读取本地的portal.html
with open(r'C:\Users\某某\Desktop\接单后台\public\portal.html', 'r', encoding='utf-8') as f:
    local_content = f.read()
    local_len = len(local_content)

print(f'线上portal.html大小: {online_len} 字节')
print(f'本地portal.html大小: {local_len} 字节')
print()

if online_content == local_content:
    print('✅ 内容完全一致 — 线上就是最新版本')
else:
    print('❌ 内容不一致 — 线上是旧版本')
    # 找差异位置
    for i in range(min(online_len, local_len)):
        if online_content[i] != local_content[i]:
            print(f'第一个差异位置: 第{i}个字符')
            print(f'线上: ...{online_content[max(0,i-20):i+20]}...')
            print(f'本地: ...{local_content[max(0,i-20):i+20]}...')
            break
