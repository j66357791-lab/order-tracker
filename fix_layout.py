css = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\css\style.css'
with open(css, 'r', encoding='utf-8') as f:
    w = f.read()

# 修复出战页面居中布局
old = '''/* 出战主视觉（盆景山） */
.stage-visual { text-align: center; padding: 20px 0; }
.stage-title { font: 900 26px "STKaiti", serif; color: #3a5a4a; letter-spacing: 4px; margin-bottom: 10px; text-shadow: 0 1px 2px rgba(255,255,255,.6); }
.stage-main { position: relative; display: flex; align-items: center; justify-content: center; gap: 10px; margin: 10px 0; }
.stage-img { width: 200px; max-height: 240px; object-fit: contain; filter: drop-shadow(0 8px 20px rgba(0,0,0,.15)); }
.stage-arrow { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,.6); border: 1px solid rgba(160,140,100,.4); color: #7a8a7a; font-size: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all .2s; flex-shrink: 0; }
.stage-arrow:active { background: rgba(212,184,122,.3); }
.stage-stars { font-size: 18px; color: #d4a84a; margin: 8px 0 4px; }
.stage-sub { font-size: 12px; color: #7a8a7a; }'''

new = '''/* 出战主视觉（居中布局） */
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

if old in w:
    w = w.replace(old, new)
    print("布局已修复")
else:
    print("未找到原CSS，追加新的")
    # 追加
    w += new

with open(css, 'w', encoding='utf-8') as f:
    f.write(w)
