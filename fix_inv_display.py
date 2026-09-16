gp = r'C:\Users\某某\Desktop\接单后台\public\game.html'
with open(gp, 'r', encoding='utf-8') as f:
    g = f.read()

# 1. 修复道具栏key名：后端是复数，前端用单数
g = g.replace(
  "function invHTML(p){ return [['key','钥匙'],['ball','魔法球'],['frag','碎片'],['revive','复活石'],['bagS','福袋·小'],['bagM','福袋·中'],['bagL','福袋·大']].map(([k,lbl]) =>",
  "function invHTML(p){ return [['keys','钥匙'],['balls','魔法球'],['frags','碎片'],['revives','复活石'],['bagS','福袋·小'],['bagM','福袋·中'],['bagL','福袋·大']].map(([k,lbl]) =>"
)

# 2. 修复doRevive里的道具更新
g = g.replace(
  "if(STATE.bag){ STATE.bag.revives = r.revives; $('invBar').innerHTML = invHTML(STATE.bag); }",
  "if(STATE.bag){ STATE.bag.revives = r.revives; $('invBar').innerHTML = invHTML(STATE.bag); refresh(); }"
)

with open(gp, 'w', encoding='utf-8') as f:
    f.write(g)
print("道具显示bug已修复")
