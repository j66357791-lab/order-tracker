css = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\css\style.css'
with open(css, 'r', encoding='utf-8') as f:
    w = f.read()

new_css = '''
/* ===== 水墨风导航栏（5个） ===== */
.home-nav.nav-ink { background: linear-gradient(180deg, rgba(245,240,224,.95), rgba(232,220,200,.98)); border-top: 1px solid rgba(160,140,100,.3); box-shadow: 0 -4px 16px rgba(0,0,0,.1); }
.hn-item { flex: 1; text-align: center; padding: 10px 0 8px; font: 11px/1.4 "PingFang SC", sans-serif; color: #7a8a7a; cursor: pointer; transition: all .2s; position: relative; }
.hn-item i { display: block; font-size: 20px; margin-bottom: 2px; }
.hn-item.center { flex: 1.2; }
.hn-item.center i { font-size: 28px; margin-top: -8px; background: linear-gradient(180deg, #f0c068, #c9963e); border-radius: 50%; width: 50px; height: 50px; line-height: 50px; margin: -15px auto 2px; box-shadow: 0 4px 12px rgba(212,184,122,.4); }
.hn-item.on { color: #2a5a4a; font-weight: 700; }
.hn-item.center.on i { box-shadow: 0 6px 16px rgba(212,184,122,.6); }

/* 出战主视觉（盆景山） */
.stage-visual { text-align: center; padding: 20px 0; }
.stage-title { font: 900 26px "STKaiti", serif; color: #3a5a4a; letter-spacing: 4px; margin-bottom: 10px; text-shadow: 0 1px 2px rgba(255,255,255,.6); }
.stage-main { position: relative; display: flex; align-items: center; justify-content: center; gap: 10px; margin: 10px 0; }
.stage-img { width: 200px; max-height: 240px; object-fit: contain; filter: drop-shadow(0 8px 20px rgba(0,0,0,.15)); }
.stage-arrow { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,.6); border: 1px solid rgba(160,140,100,.4); color: #7a8a7a; font-size: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all .2s; flex-shrink: 0; }
.stage-arrow:active { background: rgba(212,184,122,.3); }
.stage-stars { font-size: 18px; color: #d4a84a; margin: 8px 0 4px; }
.stage-sub { font-size: 12px; color: #7a8a7a; }

/* 顶栏排行榜图标 */
.tb-rank { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,.3); border: 1px solid rgba(160,140,100,.3); display: flex; align-items: center; justify-content: center; font-size: 16px; cursor: pointer; }
'''

w += new_css

with open(css, 'w', encoding='utf-8') as f:
    f.write(w)
print("CSS已加")
