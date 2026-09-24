// routes/dbadmin.js — 【v24.0】数据库占用查看与可清理项管理（管理员）
// 开发阶段用：看每个集合占了多少空间、哪些历史数据可以清，按钮式清理带确认。
// 只开放白名单集合的清理，且全部带时间下限（days），避免误删线上活跃数据。
export default function mount(ctx) {
  const { app, auth, adminOnly, getDb } = ctx;

  const CLEAN_TARGETS = {
    game_sessions: { label: '翻翻乐已结束对局', filter: days => ({ status: { $in: ['done', 'lost', 'timeout'] }, endedAt: { $lt: new Date(Date.now() - days * 86400000) } }) },
    game_logs: { label: '游戏审计日志', filter: days => ({ createdAt: { $lt: new Date(Date.now() - days * 86400000) } }) },
    // 【2026-09-24 资金安全修复】wallet_log 已从清理白名单移除：
    // 全站余额就是 wallet_log 求和（无独立 balance 字段），删除流水 = 直接蒸发用户余额；
    // 同时提现对账、红包解冻幂等判重都依赖它，清理等于摧毁账本。
  };

  const fmt = n => {
    if (n == null) return '-';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  };

  // 集合占用一览（按存储大小倒序）
  app.get('/api/admin/db/stats', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const cols = await db.listCollections().toArray();
      const out = [];
      for (const c of cols) {
        try {
          const s = await db.command({ collStats: c.name });
          out.push({ name: c.name, count: s.count || 0, size: s.size || 0, storage: s.storageSize || 0, indexSize: s.totalIndexSize || 0 });
        } catch (e) { out.push({ name: c.name, count: null, size: null, storage: null, indexSize: null }); }
      }
      out.sort((a, b) => (b.storage || 0) - (a.storage || 0));
      const total = out.reduce((t, x) => t + (x.storage || 0), 0);
      res.json({ ok: true, collections: out, totalStorage: total, totalText: fmt(total) });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '读取失败' }); }
  });

  // 可清理项预估（只报数量，不删）
  app.get('/api/admin/db/cleanup-candidates', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const days = { game_sessions: 30, game_logs: 90 };
      const out = [];
      for (const [name, def] of Object.entries(CLEAN_TARGETS)) {
        const d = days[name];
        out.push({ target: name, label: def.label, days: d, count: await db.collection(name).countDocuments(def.filter(d)) });
      }
      res.json({ ok: true, candidates: out });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '读取失败' }); }
  });

  // 执行清理（白名单 + 时间下限 + 管理员）
  app.post('/api/admin/db/cleanup', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const target = String(req.body?.target || '');
      // 审计日志最短保留 90 天：game_logs 里有管理员改密/发道具/清理操作等审计记录，
      // 允许 days=1 随手清空等于让同一权限面销毁自己的操作痕迹
      const days = Math.max(target === 'game_logs' ? 90 : 1, Number(req.body?.days) || 0);
      const def = CLEAN_TARGETS[target];
      if (!def) return res.status(400).json({ ok: false, error: '不支持的清理目标（只允许：' + Object.keys(CLEAN_TARGETS).join('、') + '）' });
      const r = await db.collection(target).deleteMany(def.filter(days));
      try {
        await db.collection('game_logs').insertOne({ userId: req.user.id, action: 'db_cleanup', detail: { target, days, deleted: r.deletedCount }, createdAt: new Date() });
      } catch (e2) {}
      res.json({ ok: true, deleted: r.deletedCount });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '清理失败' }); }
  });
}
