sp = r'C:\Users\某某\Desktop\接单后台\server.js'
with open(sp, 'r', encoding='utf-8') as f:
    s = f.read()

# 加列出所有用户API
list_users_api = '''
// 【2026-09-12】管理员：列出所有用户
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const users = await db.collection('users').find({}, { projection: { password: 0 } }).limit(50).toArray();
    res.json({ ok: true, users });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
'''

find_user_line = "// 【2026-09-12】管理员：根据手机号查用户ID"
s = s.replace(find_user_line, list_users_api + "\n" + find_user_line)

with open(sp, 'w', encoding='utf-8') as f:
    f.write(s)
print("列出用户API已添加")
