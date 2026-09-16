css = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\css\style.css'
with open(css, 'r', encoding='utf-8') as f:
    w = f.read()

# 修改关卡名位置 - 放在山的中上部
old_name = '.stage-name { position: absolute; top: 20px; left: 50%; transform: translateX(-50%); font: 900 22px "STKaiti", serif; color: #F0E8D0; text-shadow: 0 2px 8px #000; letter-spacing: 4px; white-space: nowrap; }'
new_name = '.stage-name { position: absolute; top: 120px; left: 50%; transform: translateX(-50%); font: 900 24px "STKaiti", serif; color: #2A4A3E; text-shadow: 0 1px 4px rgba(255,255,255,.6); letter-spacing: 6px; white-space: nowrap; }'

w = w.replace(old_name, new_name)

# 修改副标题位置
old_sub = '.stage-sub { position: absolute; top: 55px; left: 50%; transform: translateX(-50%); font: 11px/1 sans-serif; color: #D4B87A; white-space: nowrap; }'
new_sub = '.stage-sub { position: absolute; top: 155px; left: 50%; transform: translateX(-50%); font: 11px/1 sans-serif; color: #6A8076; white-space: nowrap; }'

w = w.replace(old_sub, new_sub)

# 修改星星位置 - 放在山脚下
old_stars = '.stage-stars { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); font-size: 16px; color: #D4B87A; text-shadow: 0 1px 4px #000; }'
new_stars = '.stage-stars { position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%); font-size: 18px; color: #D4A84A; text-shadow: 0 1px 4px rgba(0,0,0,.2); }'

w = w.replace(old_stars, new_stars)

# 调整大山图片大小
old_mountain = '.stage-mountain img { width: 220px; max-height: 320px; object-fit: contain; filter: drop-shadow(0 10px 30px rgba(0,0,0,.5)); }'
new_mountain = '.stage-mountain img { width: 260px; max-height: 380px; object-fit: contain; filter: drop-shadow(0 10px 30px rgba(0,0,0,.3)); }'

w = w.replace(old_mountain, new_mountain)

with open(css, 'w', encoding='utf-8') as f:
    f.write(w)
print("CSS位置已调整")
