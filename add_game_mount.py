sp = r'C:\Users\某某\Desktop\接单后台\server.js'
with open(sp, 'r', encoding='utf-8') as f:
    s = f.read()

old = """setTimeout(cleanupOldData, 15 * 1000);                 // 启动后15秒清一次
setInterval(cleanupOldData, 6 * 3600 * 1000);          // 之后每6小时清一次

server.listen(CONFIG.port, () => {"""

new = """setTimeout(cleanupOldData, 15 * 1000);                 // 启动后15秒清一次
setInterval(cleanupOldData, 6 * 3600 * 1000);          // 之后每6小时清一次

// 【2026-09-12】挂载魔法翻翻乐游戏模块
try {
  require('./games')(app, { auth, getDb, cnDayStr });
  console.log('[游戏] 魔法翻翻乐模块已挂载');
} catch(e) { console.error('[游戏] 模块加载失败:', e.message); }

server.listen(CONFIG.port, () => {"""

if old in s:
    s = s.replace(old, new)
    with open(sp, 'w', encoding='utf-8') as f:
        f.write(s)
    print("挂载代码已添加")
else:
    print("未找到原文，尝试其他方式")
    # 找server.listen
    idx = s.find("server.listen(CONFIG.port")
    if idx > -1:
        mount_code = """// 【2026-09-12】挂载魔法翻翻乐游戏模块
try {
  require('./games')(app, { auth, getDb, cnDayStr });
  console.log('[游戏] 魔法翻翻乐模块已挂载');
} catch(e) { console.error('[游戏] 模块加载失败:', e.message); }

"""
        s = s[:idx] + mount_code + s[idx:]
        with open(sp, 'w', encoding='utf-8') as f:
            f.write(s)
        print("挂载代码已添加（方式2）")
