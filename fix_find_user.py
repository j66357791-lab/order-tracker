sp = r'C:\Users\某某\Desktop\接单后台\server.js'
with open(sp, 'r', encoding='utf-8') as f:
    s = f.read()

# 加清空所有钥匙API
reset_keys_api = '''
// 【2026-09-12】管理员：清空所有用户的钥匙
app.post('/api/admin/reset-all-keys', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.collection('game_profiles').updateMany({}, { $set: { keys: 0 } });
    res.json({ ok: true, modified: r.modifiedCount });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
'''

list_users_line = "// 【2026-09-12】管理员：列出所有用户"
s = s.replace(list_users_line, reset_keys_api + "\n" + list_users_line)

# 修复查找用户API：支持uid/username/phone
old_find = """app.get('/api/admin/find-user/:query', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const u = await db.collection('users').findOne({ phone: req.params.query });
    if (!u) return res.status(404).json({ ok: false, error: '未找到该手机号用户' });
    res.json({ ok: true, user: { _id: u._id, phone: u.phone, name: u.name || '' } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});"""

# 先看看原来的代码是什么
import re
m = re.search(r"app\.get\('/api/admin/find-user/[^']+'[^)]+\)", s)
if m:
    old_find_code = m.group(0)
    print("找到find-user API:", old_find_code[:100])
else:
    print("没找到find-user API")
    # 直接替换整个块
    s = s.replace(
        "app.get('/api/admin/find-user/:phone', auth, adminOnly, async (req, res) => {",
        "app.get('/api/admin/find-user/:query', auth, adminOnly, async (req, res) => {"
    )
    s = s.replace(
        "const u = await db.collection('users').findOne({ phone: req.params.phone });",
        "const q = req.params.query; const u = await db.collection('users').findOne({ $or: [{ username: q }, { uid: q }, { phone: q }] });"
    )
    s = s.replace(
        "if (!u) return res.status(404).json({ ok: false, error: '未找到该手机号用户' });",
        "if (!u) return res.status(404).json({ ok: false, error: '未找到该用户' });"
    )
    s = s.replace(
        "res.json({ ok: true, user: { _id: u._id, phone: u.phone, name: u.name || '' } });",
        "res.json({ ok: true, user: { _id: u._id, username: u.username, uid: u.uid, name: u.displayName || '' } });"
    )

with open(sp, 'w', encoding='utf-8') as f:
    f.write(s)
print("已修复")
