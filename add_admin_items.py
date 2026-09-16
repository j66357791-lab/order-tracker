# server.js: add admin game item management API
sp = r'C:\Users\某某\Desktop\接单后台\server.js'
with open(sp, 'r', encoding='utf-8') as f:
    s = f.read()

admin_api = '''
// 【2026-09-12】管理员：游戏道具发放/收回/查询
app.post('/api/admin/game-grant', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const { userId, item, amount } = req.body;
    if (!userId || !item || !amount) return res.status(400).json({ ok: false, error: '缺少参数' });
    const validItems = ['keys','balls','frags','revives','bagS','bagM','bagL'];
    if (!validItems.includes(item)) return res.status(400).json({ ok: false, error: '无效道具类型' });
    const update = { $inc: { [item]: Number(amount) }, $set: { updatedAt: new Date() } };
    const p = await db.collection('game_profiles').findOneAndUpdate(
      { userId }, update, { returnDocument: 'after', upsert: true }
    );
    await db.collection('game_logs').insertOne({
      userId, action: 'admin_grant', detail: { item, amount, by: req.user.phone || req.user._id }, createdAt: new Date()
    });
    res.json({ ok: true, profile: p.value });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 【2026-09-12】管理员：查询某用户游戏道具
app.get('/api/admin/game-profile/:userId', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const p = await db.collection('game_profiles').findOne({ userId: req.params.userId });
    res.json({ ok: true, profile: p || null });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
'''

cleanup_line = "// 【2026-09-12】管理员：清理所有进行中的游戏会话"
s = s.replace(cleanup_line, admin_api + "\n" + cleanup_line)

with open(sp, 'w', encoding='utf-8') as f:
    f.write(s)
print("管理员道具API已添加")
