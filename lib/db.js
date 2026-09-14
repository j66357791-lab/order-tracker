// lib/db.js — Mongo 连接与索引初始化
import { MongoClient, ObjectId } from 'mongodb';
import { CONFIG } from '../config.js';

export let indexReady = false;
let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    dbPromise = new MongoClient(CONFIG.mongoUri, { serverSelectionTimeoutMS: 15000 })
      .connect()
      .then((c) => c.db(CONFIG.dbName));
  }
  const db = await dbPromise;
  // 首次访问时建索引：按日期查/排序、按状态筛、按完单日查、按编号搜索，各走各的索引
  if (!indexReady) {
    indexReady = true;
    db.collection(CONFIG.collection).createIndexes([
      { key: { date: -1 } },
      { key: { status: 1 } },
      { key: { doneDate: 1 } },
      { key: { orderNo: 1 } },
      { key: { date: -1, _id: -1 } },
    ]).catch(() => {});
    // 派单模块索引
    db.collection('users').createIndexes([{ key: { username: 1 }, unique: true }]).catch(() => {});
    db.collection('invites').createIndexes([{ key: { code: 1 }, unique: true }]).catch(() => {});
    db.collection('messages').createIndexes([
      { key: { conversation: 1, createdAt: -1 } },
      // 聊天信息云端只保留3天，到期自动删除（客户端本地localStorage兜底留存）
      { key: { createdAt: 1 }, expireAfterSeconds: 3 * 24 * 3600 },
    ]).catch(() => {});
    db.collection('cards').createIndexes([{ key: { to: 1, createdAt: -1 } }, { key: { orderId: 1 } }, { key: { createdAt: -1 } }, { key: { to: 1, status: 1 } }]).catch(() => {});
    // 【2026-09-14 需求修正】单单拆红包：一个订单终身一次 → 迁移旧索引(userId+cardId+date)到 (userId+cardId)
    (async () => {
      try {
        const col = db.collection('redpacket_records');
        // 1) 同一订单多笔记录：保留最早一笔，其余作废（不再入账）
        const dupGroups = await col.aggregate([
          { $group: { _id: { userId: '$userId', cardId: '$cardId' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } }
        ]).toArray();
        for (const g of dupGroups) {
          const sorted = await col.find({ _id: { $in: g.ids } }).sort({ createdAt: 1 }).toArray();
          // 保留最早一笔；其余是按天拆包旧 bug 产生的重复脏数据（从未入账），直接删除，
          // 否则 (userId+cardId) 唯一索引建不起来
          await col.deleteMany({ _id: { $in: sorted.slice(1).map(x => x._id) } });
          console.log('[索引] redpacket 迁移：删除重复拆包记录', g.count - 1, '笔（', String(g._id.cardId), '）');
        }
        // 2) 旧唯一索引（含 date）删除 → 新唯一索引（终身一次）
        try { await col.dropIndex('userId_1_cardId_1_date_1'); } catch (e) { /* 旧索引不存在则跳过 */ }
        await col.createIndex({ userId: 1, cardId: 1 }, { unique: true });
        // 3) 查询索引：按用户查冻结/解冻状态
        await col.createIndex({ userId: 1, status: 1 });
        console.log('[索引] redpacket_records 终身一次唯一索引迁移完成');
      } catch (e) { console.warn('[索引] redpacket_records 迁移:', e.message); }
    })();
    // 【2026-09-14 数据库优化】钱包/提现/签到等高频集合补索引（原来全部只有 _id，每次查询全表扫）
    db.collection('wallet_log').createIndexes([{ key: { userId: 1 } }, { key: { userId: 1, month: 1 } }]).catch(() => {});
    db.collection('withdrawals').createIndexes([{ key: { userId: 1, status: 1 } }, { key: { status: 1, createdAt: -1 } }]).catch(() => {});
    db.collection('checkin_records').createIndex({ userId: 1, date: 1 }, { unique: true }).catch(e => console.warn('[索引] checkin_records:', e.message)); // 防并发重复签到
    db.collection('shanhai_profiles').createIndex({ userId: 1 }, { unique: true }).catch(() => {});
    db.collection('schedule_days').createIndexes([{ key: { userId: 1, date: 1 }, unique: true }]).catch(() => {});
    // 启动时清掉历史遗留的假在线标记（真实在线以内存连接表为准）
    db.collection('users').updateMany({ sockOnline: true }, { $set: { sockOnline: false } }).catch(() => {});
    // 存量用户补齐7位数工号ID
    (async () => {
      try {
        const miss = await db.collection('users').find({ uid: { $exists: false } }).project({ _id: 1 }).sort({ createdAt: 1 }).toArray();
        for (const u of miss) await assignUid(db, u._id);
      } catch (e) { console.error('uid补齐失败:', e.message); }
    })();
  }
  return db;
}

export { getDb };
