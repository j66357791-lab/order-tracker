sp = r'C:\Users\某某\Desktop\接单后台\server.js'
with open(sp, 'r', encoding='utf-8') as f:
    s = f.read()

# 加活动维护开关API
maintenance_api = '''
// 【2026-09-12】活动维护开关
app.get('/api/admin/activity-maintenance', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const cfg = await db.collection('config').findOne({ key: 'game_maintenance' });
    res.json({ ok: true, maintenance: cfg ? cfg.value : false });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/activity-maintenance', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const { maintenance } = req.body;
    await db.collection('config').updateOne({ key: 'game_maintenance' }, { $set: { value: !!maintenance, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true, maintenance: !!maintenance });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
'''

reset_line = "// 【2026-09-12】管理员：清空所有用户的钥匙"
s = s.replace(reset_line, maintenance_api + "\n" + reset_line)

# 游戏state API检查维护状态
# 先找到 /api/game/state 路由
import re
m = re.search(r"app\.get\('/api/game/state'[^)]+\)", s)
if m:
    print("找到game/state路由")
else:
    print("没找到game/state路由，可能在games.js里")

with open(sp, 'w', encoding='utf-8') as f:
    f.write(s)
print("维护开关API已添加")
