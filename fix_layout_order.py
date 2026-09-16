css = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\css\style.css'
with open(css, 'r', encoding='utf-8') as f:
    w = f.read()

# 调整布局顺序：关卡名 → 第一关 → 盆栽山 → 星星
old = '''/* 出战主视觉（居中布局） */
.stage-visual { display: flex; flex-direction: column; align-items: center; padding: 10px 0; }
.stage-title-bar { position: relative; display: flex; align-items: center; justify-content: center; margin-bottom: 5px; }
.stage-title-bar img { width: 220px; display: block; }
.stage-title-bar span { position: absolute; font: 900 17px "STKaiti", serif; color: #f0e8d0; letter-spacing: 4px; white-space: nowrap; }
.stage-main { position: relative; display: flex; align-items: center; justify-content: center; gap: 15px; margin: 10px 0; }
.stage-img { width: 180px; max-height: 200px; object-fit: contain; background: transparent; }
.stage-arrow { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,.7); border: 1px solid rgba(160,140,100,.4); color: #7a8a7a; font-size: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; z-index: 2; }
.stage-level-badge { background: rgba(42,90,74,.9); color: #f0e8d0; font: 11px "PingFang SC", sans-serif; padding: 3px 14px; border-radius: 10px; margin: 5px 0; letter-spacing: 2px; }
.stage-stars { display: flex; gap: 5px; justify-content: center; margin: 5px 0; }
.stage-stars img { width: 20px; height: 20px; }
.stage-stars img:nth-child(2), .stage-stars img:nth-child(3) { opacity: .25; }
.stage-sub { font-size: 12px; color: #7a8a7a; }'''

new = '''/* 出战主视觉（居中布局） */
.stage-visual { display: flex; flex-direction: column; align-items: center; padding: 10px 0; }
.stage-title-bar { position: relative; display: flex; align-items: center; justify-content: center; }
.stage-title-bar img { width: 220px; display: block; }
.stage-title-bar span { position: absolute; font: 900 17px "STKaiti", serif; color: #f0e8d0; letter-spacing: 4px; white-space: nowrap; }
.stage-level-badge { background: rgba(42,90,74,.9); color: #f0e8d0; font: 11px "PingFang SC", sans-serif; padding: 3px 14px; border-radius: 10px; margin: 8px 0 0; letter-spacing: 2px; }
.stage-main { position: relative; display: flex; align-items: center; justify-content: center; gap: 15px; margin: 10px 0; }
.stage-img { width: 180px; max-height: 200px; object-fit: contain; background: transparent; }
.stage-arrow { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,.7); border: 1px solid rgba(160,140,100,.4); color: #7a8a7a; font-size: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; z-index: 2; }
.stage-stars { display: flex; gap: 5px; justify-content: center; margin: 10px 0 5px; }
.stage-stars img { width: 20px; height: 20px; }
.stage-stars img:nth-child(2), .stage-stars img:nth-child(3) { opacity: .25; }
.stage-sub { font-size: 12px; color: #7a8a7a; }'''

if old in w:
    w = w.replace(old, new)
    print("布局已调整")
else:
    print("未找到原CSS")

with open(css, 'w', encoding='utf-8') as f:
    f.write(w)
