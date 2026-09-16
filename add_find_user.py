sp = r'C:\Users\某某\Desktop\接单后台\server.js'
with open(sp, 'r', encoding='utf-8') as f:
    s = f.read()

# 在game-grant API前面加查用户API
find_user_api = '''
// 【2026-09-12】管理员：根据手机号查用户ID
app.get('/api/admin/find-user/:phone', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const u = await db.collection('users').findOne({ phone: req.params.phone });
    if (!u) return res.status(404).json({ ok: false, error: '未找到该手机号用户' });
    res.json({ ok: true, user: { _id: u._id, phone: u.phone, name: u.name || '' } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
'''

grant_line = "// 【2026-09-12】管理员：游戏道具发放/收回/查询"
s = s.replace(grant_line, find_user_api + "\n" + grant_line)

with open(sp, 'w', encoding='utf-8') as f:
    f.write(s)
print("查找用户API已添加")
