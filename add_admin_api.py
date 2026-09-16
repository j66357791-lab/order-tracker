# server.js: add admin activity stats API
sp = r'C:\Users\某某\Desktop\接单后台\server.js'
with open(sp, 'r', encoding='utf-8') as f:
    s = f.read()

admin_api = '''
// 【2026-09-12】管理员：活动数据总览
app.get('/api/admin/activity-stats', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const today = new Date().toISOString().slice(0,10);
    const totalPlayers = await db.collection('game_profiles').countDocuments();
    const playingSessions = await db.collection('game_sessions').countDocuments({ status: { $in: ['playing','wave_done'] } });
    const agg = await db.collection('game_profiles').aggregate([
      { $group: { _id: null, total: { $sum: '$totalGames' }, totalKeys: { $sum: '$keys' }, totalBalls: { $sum: '$balls' } } }
    ]).toArray();
    const todayCheckins = await db.collection('checkin_records').countDocuments({ date: today });
    res.json({
      ok: true,
      game: { totalPlayers, playingSessions, totalGames: agg[0]?.total || 0, totalKeysLeft: agg[0]?.totalKeys || 0, totalBallsLeft: agg[0]?.totalBalls || 0 },
      checkin: { today: todayCheckins },
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 【2026-09-12】管理员：清理所有进行中的游戏会话（退还钥匙）
app.post('/api/admin/game-cleanup', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const sessions = await db.collection('game_sessions').find({ status: { $in: ['playing','wave_done'] } }).toArray();
    for (const s of sessions) {
      await db.collection('game_sessions').updateOne({ _id: s._id }, { $set: { status: 'aborted', endedAt: new Date() } });
      await db.collection('game_profiles').updateOne({ userId: s.userId }, { $inc: { keys: 1 } });
    }
    res.json({ ok: true, cleaned: sessions.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
'''

mount_line = "// 【2026-09-12】挂载魔法翻翻乐游戏模块"
s = s.replace(mount_line, admin_api + "\n" + mount_line)

with open(sp, 'w', encoding='utf-8') as f:
    f.write(s)
print("管理员API已添加")
