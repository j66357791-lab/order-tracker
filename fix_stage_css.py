css = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\css\style.css'
with open(css, 'r', encoding='utf-8') as f:
    w = f.read()

# 加新的关卡展示样式
new_css = '''
/* ===== 关卡展示（单关卡+左右切换） ===== */
.stage-visual { position: relative; display: flex; align-items: center; justify-content: center; min-height: 380px; margin: 10px 0 20px; }
.stage-mountain { position: relative; text-align: center; }
.stage-mountain img { width: 220px; max-height: 320px; object-fit: contain; filter: drop-shadow(0 10px 30px rgba(0,0,0,.5)); }
.stage-name { position: absolute; top: 20px; left: 50%; transform: translateX(-50%); font: 900 22px "STKaiti", serif; color: #F0E8D0; text-shadow: 0 2px 8px #000; letter-spacing: 4px; white-space: nowrap; }
.stage-sub { position: absolute; top: 55px; left: 50%; transform: translateX(-50%); font: 11px/1 sans-serif; color: #D4B87A; white-space: nowrap; }
.stage-stars { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); font-size: 16px; color: #D4B87A; text-shadow: 0 1px 4px #000; }
.stage-arrow { position: absolute; top: 50%; transform: translateY(-50%); width: 40px; height: 40px; border-radius: 50%; background: rgba(0,0,0,.4); border: 1px solid rgba(212,184,122,.5); color: #D4B87A; font-size: 24px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all .2s; z-index: 2; }
.stage-arrow.left { left: 5px; }
.stage-arrow.right { right: 5px; }
.stage-arrow:active { background: rgba(212,184,122,.3); }
.stage-actions { text-align: center; margin-bottom: 16px; }
.btn-stage-big { background: linear-gradient(180deg, #F0C068, #C9963E); border: 1px solid rgba(255,220,150,.4); border-radius: 30px; padding: 14px 60px; font: bold 17px "PingFang SC", sans-serif; color: #2A1808; cursor: pointer; letter-spacing: 6px; box-shadow: 0 6px 20px rgba(212,184,122,.4), inset 0 1px 0 rgba(255,255,255,.3); }
.btn-stage-big:disabled { filter: grayscale(.6); opacity: .5; }
'''

w += new_css

with open(css, 'w', encoding='utf-8') as f:
    f.write(w)
print("CSS已加")
