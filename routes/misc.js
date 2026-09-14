// routes/misc.js — 验证码/合同/实名/系统消息
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId } from 'mongodb';
import crypto from 'crypto';

export default function mount(ctx) {

  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket, rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT, unfreezeRedpackets } = ctx;

app.get('/api/captcha', (req, res) => {
  const a = rnd(8) + 2, b = rnd(8) + 1;
  const op = Math.random() < 0.5 ? '+' : '-';
  const ans = op === '+' ? a + b : a - b;
  const id = crypto.randomBytes(12).toString('hex');
  captchaStore.set(id, { ans, exp: Date.now() + 5 * 60 * 1000 });
  if (captchaStore.size > 500) for (const [k, v] of captchaStore) if (v.exp < Date.now()) captchaStore.delete(k);
  const noise = Array.from({ length: 3 }, () => `<path d="M${rnd(120)} ${rnd(44)} Q ${rnd(160)} ${rnd(60)} ${120 + rnd(80)} ${rnd(50)}" stroke="#94a3b8${rnd(9)}" fill="none" stroke-width="1.5" opacity=".5"/>`).join('');
  const dots = Array.from({ length: 26 }, () => `<circle cx="${rnd(200)}" cy="${rnd(56)}" r="${rnd(2) + 1}" fill="#cbd5e1" opacity=".7"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="56" viewBox="0 0 200 56"><rect width="200" height="56" rx="10" fill="#f1f5f9"/>${noise}${dots}
    <text x="100" y="36" text-anchor="middle" font-size="26" font-weight="700" font-family="Georgia,serif" fill="#1f2937" letter-spacing="4" transform="rotate(${rnd(7) - 3} 100 30)">${a} ${op} ${b} = ?</text></svg>`;
  res.json({ ok: true, id, svg });
});
// 临时：清空所有聊天记录（管理员调用一次即可删除）
app.post('/api/admin/clear-chats', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const r1 = await db.collection('messages').deleteMany({});
    const r2 = await db.collection('chats').deleteMany({});
    res.json({ ok: true, messages: r1.deletedCount, chats: r2.deletedCount });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


app.get('/api/contract/text', (req, res) => res.json({ ok: true, title: CONTRACT_TITLE, version: CONTRACT_VERSION, text: CONTRACT_TEXT }));
app.get('/api/contract', auth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('contracts').find({ userId: req.user.id }).sort({ signedAt: -1 }).limit(20).toArray();
    res.json({
      ok: true, title: CONTRACT_TITLE, version: CONTRACT_VERSION, text: CONTRACT_TEXT,
      signed: rows.some(r => r.version === CONTRACT_VERSION),
      realname: req.user.realname || null,
      contracts: rows.map(r => ({ _id: r._id.toString(), name: r.name, version: r.version, signedAt: r.signedAt })),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/contract/sign', auth, async (req, res) => {
  try {
    const db = await getDb();
    let name = String(req.body?.name || '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ ok: false, error: '请输入签署姓名' });
    if (name !== (req.body?.nameConfirm || '').trim()) return res.status(400).json({ ok: false, error: '两次输入的姓名不一致' });
    // 已实名则强制与实名一致（自动关联）
    if (req.user.realname?.name) {
      if (name !== req.user.realname.name) return res.status(400).json({ ok: false, error: '已实名认证，签署姓名必须与实名姓名一致（' + req.user.realname.name + '）' });
    }
    const exist = await db.collection('contracts').findOne({ userId: req.user.id, version: CONTRACT_VERSION });
    if (exist) return res.json({ ok: true, already: true });
    await db.collection('contracts').insertOne({ userId: req.user.id, name, uid: req.user.uid, displayName: req.user.displayName, version: CONTRACT_VERSION, title: CONTRACT_TITLE, signedAt: new Date() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 实名认证（姓名+身份证18位位数校验，只存掩码与哈希） ----------

app.put('/api/me/realname', auth, async (req, res) => {
  try {
    const db = await getDb();
    const name = String(req.body?.name || '').trim().slice(0, 30);
    const idCard = String(req.body?.idCard || '').trim().toUpperCase();
    if (!/^[\u4e00-\u9fa5·]{2,30}$/.test(name)) return res.status(400).json({ ok: false, error: '请输入真实中文姓名' });
    if (!/^\d{17}[\dX]$/.test(idCard)) return res.status(400).json({ ok: false, error: '身份证号应为18位（最后一位可为X）' });
    const idHash = sha256hex(idCard);
    const dup = await db.collection('users').findOne({ 'realname.idHash': idHash, _id: { $ne: new ObjectId(req.user.id) } });
    if (dup) return res.status(400).json({ ok: false, error: '该身份证号已被其他账号认证' });
    const idMask = idCard.slice(0, 3) + '***********' + idCard.slice(-4);
    const realname = { name, idMask, idHash, verifiedAt: new Date() };
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $set: { realname } });
    // 自动关联合同：已签合同签署姓名同步为实名姓名
    await db.collection('contracts').updateMany({ userId: req.user.id }, { $set: { name, linkedRealname: true } });
    res.json({ ok: true, realname: { name, idMask, verifiedAt: realname.verifiedAt } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 站内信（管理员群发/定向，写手查看） ----------
app.post('/api/notify', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const title = String(req.body?.title || '').trim().slice(0, 60);
    const content = String(req.body?.content || '').trim().slice(0, 3000);
    const target = String(req.body?.target || 'all');
    if (!title || !content) return res.status(400).json({ ok: false, error: '标题和内容不能为空' });
    let targets = [];
    if (target === 'all') targets = (await db.collection('users').find({ role: 'writer' }).project({ _id: 1 }).toArray()).map(u => u._id.toString());
    else {
      if (!ObjectId.isValid(target)) return res.status(400).json({ ok: false, error: '目标用户无效' });
      targets = [target];
    }
    if (!targets.length) return res.status(400).json({ ok: false, error: '没有可发送的用户' });
    await db.collection('announcements').insertOne({ title, content, from: '系统', targets, readBy: [], createdAt: new Date() });
    targets.forEach(t => notify(t, 'announce', { title }));
    res.json({ ok: true, count: targets.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/notify', auth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('announcements').find({ targets: req.user.id }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json({
      ok: true, rows: rows.map(r => ({ _id: r._id.toString(), title: r.title, content: r.content, createdAt: r.createdAt, read: (r.readBy || []).includes(req.user.id) })),
      unread: rows.filter(r => !(r.readBy || []).includes(req.user.id)).length,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/notify/:id/read', auth, async (req, res) => {
  try {
    const db = await getDb();
    await db.collection('announcements').updateOne({ _id: new ObjectId(req.params.id) }, { $addToSet: { readBy: req.user.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/notify/admin', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('announcements').find().sort({ createdAt: -1 }).limit(50).toArray();
    res.json({ ok: true, rows: rows.map(r => ({ _id: r._id.toString(), title: r.title, content: r.content, createdAt: r.createdAt, targets: (r.targets || []).length, reads: (r.readBy || []).length })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 好友申请（需对方确认） ----------
app.get('/api/friends/requests', auth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('friend_requests').find({
      $or: [{ to: req.user.id, status: '待确认' }, { from: req.user.id, status: '待确认' }],
    }).sort({ createdAt: -1 }).limit(50).toArray();
    const ids = rows.flatMap(r => [r.from, r.to]).filter(x => ObjectId.isValid(x));
    const users = ids.length ? await db.collection('users').find({ _id: { $in: ids.map(x => new ObjectId(x)) } }).project({ displayName: 1, uid: 1, level: 1 }).toArray() : [];
    const um = Object.fromEntries(users.map(u => [u._id.toString(), u]));
    res.json({
      ok: true,
      incoming: rows.filter(r => r.to === req.user.id).map(r => ({ _id: r._id.toString(), from: r.from, name: um[r.from]?.displayName || '写手', uid: um[r.from]?.uid || null, createdAt: r.createdAt })),
      outgoing: rows.filter(r => r.from === req.user.id).map(r => ({ _id: r._id.toString(), to: r.to, name: um[r.to]?.displayName || '写手', uid: um[r.to]?.uid || null, createdAt: r.createdAt })),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/friends/requests/:id/accept', auth, async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.collection('friend_requests').findOne({ _id: new ObjectId(req.params.id) });
    if (!r || r.to !== req.user.id || r.status !== '待确认') return res.status(400).json({ ok: false, error: '申请不存在或已处理' });
    await db.collection('friend_requests').updateOne({ _id: r._id }, { $set: { status: '已同意', handledAt: new Date() } });
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $addToSet: { friends: r.from } });
    await db.collection('users').updateOne({ _id: new ObjectId(r.from) }, { $addToSet: { friends: req.user.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/friends/requests/:id/reject', auth, async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.collection('friend_requests').findOne({ _id: new ObjectId(req.params.id) });
    if (!r || (r.to !== req.user.id && r.from !== req.user.id) || r.status !== '待确认') return res.status(400).json({ ok: false, error: '申请不存在或已处理' });
    await db.collection('friend_requests').updateOne({ _id: r._id }, { $set: { status: r.to === req.user.id ? '已拒绝' : '已撤回', handledAt: new Date() } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
}

// —— 合同（注册接口共读） ——
export const CONTRACT_VERSION = 'V1.1';

export const CONTRACT_TITLE = '兼职写手合作签约协议';

export const CONTRACT_TEXT = `甲方：平台运营方（下称"平台"）
乙方：兼职写手（下称"写手"，即本平台注册账号持有人）

一、合作性质
1. 本协议为兼职合作协议，不构成劳动雇佣关系，写手自主安排工作时间与地点，平台不要求坐班考勤约束（平台排班与打卡仅为接单协作需要）。
2. 写手自愿在平台注册并通过接单获得报酬，双方按"多劳多得、按单结算"原则合作。

二、接单与交付规范
1. 写手应保证所提交作品为本人原创，可以适当使用AI工具辅助处理（资料检索、润色、排版等），但不得以AI直接生成内容未经加工就冒充人工原创交付，不得抄袭、洗稿，不得一稿多投。
2. 作品需符合派单卡标注的要求（主题、字数、格式、交付时间等），不合格作品甲方可驳回并要求修改或重做。
3. 接单后因个人原因无法完成的，应及时与管理员沟通释放订单；无故拖延、失联造成的损失由写手承担。
4. 严禁泄露甲方客户信息、订单信息及平台内部数据；严禁绕开平台私自与客户交易。

三、报酬与结算
1. 报酬按单计价，以派单卡标注金额为准；审核通过后进入待打款，由管理员按约定周期打款至写手绑定的收款方式。
2. 写手应保证绑定的收款账号真实有效，且收款人与实名认证信息一致，因账号错误导致的损失由写手自行承担。
3. 写手达到平台等级条件的，可享受平台额外激励奖励，具体规则以平台页面公示为准。

四、实名与隐私
1. 写手接单前应完成实名认证（姓名+身份证号，平台仅作位数校验与唯一性识别，不对接第三方数据库）。
2. 平台仅收集开展合作所必需的信息（账号、昵称、实名信息、收款方式等），并妥善保管，不用于合作以外用途。
3. 写手对合作过程中知悉的客户与业务信息负有保密义务，协议终止后仍持续有效。

五、违规与解除
1. 写手出现抄袭、泄密、私单、恶意刷单、冒名实名等行为的，平台有权视情节采取驳回订单、取消激励、暂停接单、封禁账号等措施，未结合格报酬仍按规定结算。
2. 任何一方可提前告知对方终止合作；已产生的合格订单报酬不受影响。

六、其他
1. 本协议自写手在平台完成电子签署（点击签署并确认姓名）之日起生效，长期有效；实名认证信息与本协议自动关联，须为同一人。
2. 写手签署本协议即视为已完整阅读并同意以上全部条款。
3. 本协议的修改与解释权归平台所有，重大变更将以平台公告或弹窗方式通知。`;

