gp = r'C:\Users\某某\Desktop\接单后台\public\game.html'
with open(gp, 'r', encoding='utf-8') as f:
    g = f.read()

# 替换ICO里的图床为本地路径
g = g.replace(
  "frag:'https://sfile.chatglm.cn/workspace/image/f3/f38f92807e.png'",
  "frag:'/assets/game/icon_frag.png'"
)
g = g.replace(
  "ball:'https://sfile.chatglm.cn/workspace/image/68/68bcfbdaff.png'",
  "ball:'/assets/game/icon_ball.png'"
)
g = g.replace(
  "revive:'https://sfile.chatglm.cn/workspace/image/21/2164971677.png'",
  "revive:'/assets/game/icon_revive.png'"
)

# 替换卡片图片
g = g.replace(
  "src=\"https://sfile.chatglm.cn/workspace/image/c6/c63553777d.png\"",
  "src=\"/assets/game/card_back.png\""
)
g = g.replace(
  "src=\"https://sfile.chatglm.cn/workspace/image/be/be58a11886.png\"",
  "src=\"/assets/game/card_escape.png\""
)
g = g.replace(
  "src=\"https://sfile.chatglm.cn/workspace/image/cf/cd8c50c5.png\"",
  "src=\"/assets/game/card_front.png\""
)
# 逃跑弹窗里的大图
g = g.replace(
  "src=\"https://sfile.chatglm.cn/workspace/image/be/be58a11886.png\"",
  "src=\"/assets/game/card_escape.png\""
)

# 合成弹窗里的魔法球
g = g.replace(
  "src=\"https://sfile.chatglm.cn/workspace/image/68/68bcfbdaff.png\"",
  "src=\"/assets/game/icon_ball.png\""
)

# 任务专区里的碎片图
g = g.replace(
  "src=\"https://sfile.chatglm.cn/workspace/image/f3/f38f92807e.png\"",
  "src=\"/assets/game/icon_frag.png\""
)

with open(gp, 'w', encoding='utf-8') as f:
    f.write(g)
print("图片路径已全部改成本地")
