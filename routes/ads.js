// routes/ads.js — 广告位管理
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId } from 'mongodb';

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, selfUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket, rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT, unfreezeRedpackets } = ctx;
// ===== 广告/公告管理 =====
const DEFAULT_AD = {
  title: '📢 接单流程与等级规范',
  content: `<div style="line-height:1.8;font-size:13px">
<h4 style="color:#07c160;margin:10px 0 6px">一、接单流程</h4>
<p>1. 在「工作台」查看可接单子，点击卡片查看详细要求</p>
<p>2. 确认能做后点击「接单」，开始计时</p>
<p>3. 完成后在「聊天」里提交成果文件</p>
<p>4. 管理员审核通过后，单子进入「待打款」状态</p>
<p>5. 管理员打款后，单子变为「已完成」，报酬自动入账</p>
<h4 style="color:#3b82f6;margin:12px 0 6px">二、结算规则</h4>
<p>• 审核通过的单子，将在<b>客人签收完成30天左右</b>进行结算</p>
<p>• 提现：「我的 → 钱包 → 提现」，支付宝到账</p>
<p>• 结算后可随时提现，不设门槛</p>
<p>• 恶意退单/虚假提交将扣除对应报酬并记录违约</p>
<h4 style="color:#8b5cf6;margin:12px 0 6px">三、等级规范</h4>
<p>• <b style="color:#f59e0b">LV1 新手</b>：刚注册，可接基础单子</p>
<p>• <b style="color:#3b82f6">LV2 熟练</b>：完单5单以上，解锁高单价单子</p>
<p>• <b style="color:#07c160">LV3 资深</b>：完单20单以上，享优先派单权</p>
<p>• 等级每自然月评定一次，连续两周0完单降级</p>
<h4 style="color:#d97706;margin:12px 0 6px">四、注意事项</h4>
<p>• 所有沟通和文件交付请在平台内进行</p>
<p>• 禁止私下交易，违者封号</p>
<p>• 有问题随时在「聊天」联系管理员</p>
</div>`
};
app.get('/api/ads', async (req, res) => {
  try {
    const db = await getDb();
    let ad = await db.collection('ads').findOne({ _id: 'main' });
    if (!ad || (ad.content && ad.content.indexOf('签收完成30天') === -1)) {
      // 首次部署或广告内容过时，用默认内容覆盖
      ad = { _id: 'main', ...DEFAULT_AD, updatedAt: new Date() };
      await db.collection('ads').replaceOne({ _id: 'main' }, ad, { upsert: true });
    }
    res.json({ ok: true, ad });
  } catch (e) {
    res.json({ ok: true, ad: DEFAULT_AD });
  }
});
app.post('/api/ads', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const { title, content } = req.body;
    await db.collection('ads').updateOne(
      { _id: 'main' },
      { $set: { title: String(title || ''), content: String(content || ''), updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
}
