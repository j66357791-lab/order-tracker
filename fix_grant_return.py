sp = r'C:\Users\某某\Desktop\接单后台\server.js'
with open(sp, 'r', encoding='utf-8') as f:
    s = f.read()

# 修复findOneAndUpdate返回值
old_grant = """    const p = await db.collection('game_profiles').findOneAndUpdate(
      { userId }, update, { returnDocument: 'after', upsert: true }
    );
    await db.collection('game_logs').insertOne({
      userId, action: 'admin_grant', detail: { item, amount, by: req.user.phone || req.user._id }, createdAt: new Date()
    });
    res.json({ ok: true, profile: p.value });"""

new_grant = """    const p = await db.collection('game_profiles').findOneAndUpdate(
      { userId }, update, { returnDocument: 'after', upsert: true }
    );
    const profile = p.value || p;
    await db.collection('game_logs').insertOne({
      userId, action: 'admin_grant', detail: { item, amount, by: req.user.phone || req.user._id }, createdAt: new Date()
    });
    res.json({ ok: true, profile: profile });"""

s = s.replace(old_grant, new_grant)

with open(sp, 'w', encoding='utf-8') as f:
    f.write(s)
print("已修复")
