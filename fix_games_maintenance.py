gp = r'C:\Users\某某\Desktop\接单后台\games.js'
with open(gp, 'r', encoding='utf-8') as f:
    g = f.read()

# 在state API里加维护状态
old_state = """  app.get('/api/game/state', auth, wrap(async (req, res) => {
    const db = await getDb();
    const p = await getProfile(db, req.user.id);
    const session = await getActiveSession(db, req.user.id);
    const today = nowDay();
    res.json({
      ok: true, activity: { name: ACTIVITY.name, start: ACTIVITY.start, end: ACTIVITY.end, active: inActivity(), composeFragCost: ACTIVITY.composeFragCost },
      bag: { keys: p.keys, balls: p.balls, frags: p.frags, revives: p.revives, bagS: p.bagS, bagM: p.bagM, bagL: p.bagL },
      dailyClaimed: p.lastDailyKey === today,
      session: session ? { wave: session.wave, round: session.round, pot: session.pot, revivesUsed: session.revivesUsed, waveDone: session.status === 'wave_done', table: tablePublic(session.wave, session.round) } : null,
      shop: SHOP.map(s => ({ id: s.id, name: s.name, icon: s.icon, cost: s.cost, desc: s.desc || '', enabled: s.enabled })),
    });
  }));"""

new_state = """  app.get('/api/game/state', auth, wrap(async (req, res) => {
    const db = await getDb();
    // 检查维护状态
    const cfg = await db.collection('config').findOne({ key: 'game_maintenance' });
    const maintenance = cfg ? cfg.value : false;
    if (maintenance) return res.json({ ok: true, maintenance: true, activity: { name: ACTIVITY.name } });
    const p = await getProfile(db, req.user.id);
    const session = await getActiveSession(db, req.user.id);
    const today = nowDay();
    res.json({
      ok: true, maintenance: false,
      activity: { name: ACTIVITY.name, start: ACTIVITY.start, end: ACTIVITY.end, active: inActivity(), composeFragCost: ACTIVITY.composeFragCost },
      bag: { keys: p.keys, balls: p.balls, frags: p.frags, revives: p.revives, bagS: p.bagS, bagM: p.bagM, bagL: p.bagL },
      dailyClaimed: p.lastDailyKey === today,
      session: session ? { wave: session.wave, round: session.round, pot: session.pot, revivesUsed: session.revivesUsed, waveDone: session.status === 'wave_done', table: tablePublic(session.wave, session.round) } : null,
      shop: SHOP.map(s => ({ id: s.id, name: s.name, icon: s.icon, cost: s.cost, desc: s.desc || '', enabled: s.enabled })),
    });
  }));"""

g = g.replace(old_state, new_state)

with open(gp, 'w', encoding='utf-8') as f:
    f.write(g)
print("games.js维护检查已添加")
