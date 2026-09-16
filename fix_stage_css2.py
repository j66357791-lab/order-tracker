css = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\css\style.css'
with open(css, 'r', encoding='utf-8') as f:
    w = f.read()

new_css = '''
/* 关卡标题横条 */
.stage-title-bar { position: relative; display: inline-block; margin-bottom: 10px; }
.stage-title-bar img { width: 240px; display: block; }
.stage-title-bar span { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font: 900 18px "STKaiti", serif; color: #f0e8d0; letter-spacing: 4px; white-space: nowrap; }

/* 关卡等级小框 */
.stage-level-badge { display: inline-block; background: rgba(42,90,74,.9); color: #f0e8d0; font: 12px "PingFang SC", sans-serif; padding: 4px 16px; border-radius: 12px; margin: 8px 0; letter-spacing: 2px; }

/* 星星PNG */
.stage-stars { display: flex; gap: 6px; justify-content: center; margin: 8px 0; }
.stage-stars img { width: 24px; height: 24px; }
.stage-stars img:nth-child(2), .stage-stars img:nth-child(3) { opacity: .3; }

/* 主视觉盆景山（透明无框） */
.stage-img { width: 200px; max-height: 220px; object-fit: contain; }
'''

w += new_css

with open(css, 'w', encoding='utf-8') as f:
    f.write(w)
print("CSS已加")
