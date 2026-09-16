gp = r'C:\Users\某某\Desktop\接单后台\public\game.html'
with open(gp, 'r', encoding='utf-8') as f:
    g = f.read()

# 修复doGiveup：成功后直接gameOver，不弹中间对话框
old_giveup = """async function doGiveup(){ try{ await api('/api/game/giveup',{method:'POST'}); modal(`<h3>本局结束</h3><p>奖励已逃走，下次一定！</p><div class="m-btns"><button class="btn" onclick="gameOver()">返回大厅</button></div>`); }catch(e){ toast(e.message); } }"""

new_giveup = """async function doGiveup(){ try{ await api('/api/game/giveup',{method:'POST'}); gameOver(); toast('本局已结束，奖励已逃走'); }catch(e){ toast(e.message); } }"""

if old_giveup in g:
    g = g.replace(old_giveup, new_giveup)
    print("doGiveup已修复")
else:
    print("未找到doGiveup原文")

with open(gp, 'w', encoding='utf-8') as f:
    f.write(g)
