wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 找到第500-507行（索引499-506）替换
for i, line in enumerate(lines):
    if 'id="atGame"' in line and 'act-panel' in line:
        # 找到这个panel的开始，替换到结束
        start = i - 1  # <!-- 限时活动：魔法翻翻乐 -->
        end = i + 7    # </div> 结束
        new_block = '''        <!-- 限时活动：游戏中心 -->
        <div class="act-panel" id="atGame">
          <div class="act-card" style="margin:0;padding:0;overflow:hidden;border:none;border-radius:12px">
            <img src="/assets/game-banner.jpg" style="width:100%;display:block;cursor:pointer" onclick="location.href='/game.html'">
          </div>
        </div>
'''
        lines[start:end+1] = [new_block]
        print(f"替换了第{start+1}行到第{end+1}行")
        break

with open(wp, 'w', encoding='utf-8') as f:
    f.writelines(lines)
print("done")
