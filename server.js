// server.js — 入口（ES6 模块化架构 v4 · 2026-09-14）
// 职责只剩：装配中间件 → 挂载各业务模块 → 启动 HTTP/WebSocket
// 业务代码全部拆分至 routes/ 与 lib/，游戏在 games.js / shanhai_game.js
import { envReport } from './lib/env.js';   // 必须最先：先加载 .env，后面的模块才能读到配置
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import compression from 'compression';
import { Server } from 'socket.io';
import { ObjectId, GridFSBucket } from 'mongodb';

import { CONFIG, CHANGELOG, assertConfig } from './config.js';
import { getDb } from './lib/db.js';
import {
  JWT_SECRET, signToken, publicUser, selfUser, auth, adminOnly,
  cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr,
  sha256hex, captchaStore, verifyCaptcha, rnd, ymOf, toMin, cnTimeStr,
  cleanReplyTo, nextUid, assignUid, pairKey, makeNotify,
} from './lib/core.js';
import { STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday } from './config.js';

assertConfig();   // 【V17】数据库连接串没配好就直接停下，并打印配置指引

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 【2026-09-17 安全加固】原全局 JSON 上限 120MB、上传 100MB 全进内存、socket 单包 100MB，
// 几个并发大请求即可打爆内存。调整为：通用 JSON 2MB（聊天/公告等业务足够），
// 聊天附件维持文档承诺的 25MB，socket 只传通知消息 1MB 足够。
const FILE_LIMIT = 25 * 1024 * 1024;
const JSON_LIMIT = '2mb';
const app = express();
app.disable('x-powered-by');
// 【2026-09-17 安全加固】部署在 nginx / 宝塔等反向代理后面时，把 TRUST_PROXY 设为 1，
// 否则限流看到的全是代理 IP（127.0.0.1），会把所有人算成同一个人。
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});
app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_LIMIT }));
// 【2026-09-17 性能优化】gzip 压缩响应：HTML/JS/CSS/JSON/SVG 文本类体积通常再省 60~70%，
// 大于 1KB 才压缩（小包压缩反而浪费 CPU）。图片本身已压缩，交给浏览器协商处理。
app.use(compression({ threshold: 1024 }));
// 【2026-09-16】根路径直达用户端落地页
app.get('/', (req, res) => res.redirect('/portal.html'));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '30d',   // 图片等长期缓存（引用带 ?v= 版本化，换图换URL）
  setHeaders: (res, p) => {
    // 【2026-09-15c 缓存根治】html/json/js/css 一律 no-cache（ETag 秒级再验证）
    // ——此前 js/css 30d 缓存 + URL 不变，导致部署新版本后老客户端一直用旧逻辑
    if (/\.(html|json|js|css|webmanifest)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1 * 1024 * 1024,
  pingInterval: 20000, pingTimeout: 25000,
  transports: ['websocket', 'polling'],
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: FILE_LIMIT } });
const notify = makeNotify(io);
let gridBucket = null;
const makeBucket = async () => { const db = await getDb(); gridBucket = gridBucket || new GridFSBucket(db, { bucketName: 'files' }); return gridBucket; };

// ---- 部署自检（关键文件指纹：部署后一查便知是否传全） ----
// 覆盖前端所有页面 + 关键后端文件。missing 数组会直接把「没传上来的文件」列出来。
const DEPLOY_CHECK_FILES = [
  'server.js', 'config.js', 'package.json',
  'public/portal.html', 'public/member.html', 'public/portal-register.html', 'public/login.html',
  'public/index.html', 'public/dispatch.html', 'public/writer.html', 'public/game.html',
  // 【v20.4 修复】管理后台单页化后新增的页面与模块，原先一个都没进核验清单——
  // 漏传 /admin/ 下任何一个文件，整个管理后台（左侧导航、全局搜索、三个面板）都会白屏，
  // 而 /api/deploy-check 仍报"全部在线"。以下 12 项补齐。
  'public/admin.html', 'public/dispatch-overview.html', 'public/withdraw.html', 'public/ads.html',
  'public/admin/app.css', 'public/admin/app.js',
  'public/admin/mod-game.js', 'public/admin/mod-mall.js', 'public/admin/mod-security.js',
  // 【v20.6】iframe → 原生面板迁移：每迁一个就补一个 mod-*.js 进核验清单
  'public/admin/mod-ads.js',
  'public/admin/mod-withdraw.js',
  'public/admin/mod-cards.js',
  'public/admin/mod-orders.js', 'public/admin/ledger.css',
  'public/admin/mod-chat.js', 'public/admin/chat.css',
  'public/admin_packages.html', 'public/admin_game.html', 'public/admin_security.html',
  'public/robots.txt', 'public/service-worker.js', 'public/manifest.json',
  'public/games/shanhai/index.html', 'public/games/shanhai/css/style.css',
  'public/games/shanhai/js/weapons.js', 'public/games/shanhai/js/game.js',
  'public/games/shanhai/js/config.js', 'public/games/shanhai/js/meta.js',
  'public/games/shanhai/js/ui.js', 'public/games/shanhai/js/assets.js',
  'public/games/shanhai/js/audio.js', 'public/games/shanhai/js/entities.js', 'public/games/shanhai/js/effects.js', 'public/games/shanhai/js/pool.js',
  'lib/core.js', 'lib/db.js', 'lib/env.js', 'lib/ratelimit.js', 'lib/ocr.js', 'lib/ocr-child.mjs',
  'routes/portal.js', 'routes/authx.js', 'routes/user.js', 'routes/orders.js',
  'routes/recharge.js', 'public/admin/mod-recharge.js',
  'routes/misc.js', 'routes/ads.js', 'routes/cards.js', 'routes/worktime.js', 'routes/gameadmin.js', 'routes/dbadmin.js',
  // 【终审补充】漏列的三个后端文件：activity.js 承载红包解冻打款链路，games/shanhai 是两个游戏模块
  'routes/activity.js', 'games.js', 'shanhai_game.js',
];
// 【2026-09-17 安全加固】原接口无鉴权公开返回全部文件名/大小/SHA-256 指纹，等于帮攻击者做资产测绘。
// 现拆两级：公开版只回 version/missingCount（部署核验够用）；完整清单仅管理员可见。
app.get('/api/deploy-check', async (req, res) => {
  try {
    const { createHash } = await import('crypto');
    const { readFile } = await import('fs/promises');
    const files = DEPLOY_CHECK_FILES;
    const missing = [];
    for (const f of files) {
      try { await readFile(path.join(__dirname, f)); } catch (e) { missing.push(f); }
    }
    // 【二次复核修正】公开版不再返回 missing 文件名清单（原先仍外泄文件名），只回计数
    res.json({
      ok: true, version: CONFIG.appVersion,
      filesTotal: files.length, missingCount: missing.length,
    });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
app.get('/api/deploy-check/detail', auth, adminOnly, async (req, res) => {
  try {
    const { createHash } = await import('crypto');
    const { readFile } = await import('fs/promises');
    const files = DEPLOY_CHECK_FILES;
    const out = {}, missing = [];
    for (const f of files) {
      try {
        const buf = await readFile(path.join(__dirname, f));
        out[f] = { kb: Math.round(buf.length / 1024), sha8: createHash('sha256').update(buf).digest('hex').slice(0, 8) };
      } catch (e) { out[f] = { MISSING: true }; missing.push(f); }
    }
    res.json({
      ok: true, version: CONFIG.appVersion,
      filesTotal: files.length, missingCount: missing.length, missing, files: out,
    });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// ---- 版本信息（前端进入时自动检查更新） ----
app.get('/api/version', (req, res) => res.json({ ok: true, version: CONFIG.appVersion, changelog: CHANGELOG }));

// ---- PWA / 深链 ----
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public/manifest.json')));
app.get('/.well-known/assetlinks.json', (req, res) => res.sendFile(path.join(__dirname, 'public/.well-known/assetlinks.json')));

// ---- 业务模块（activity 先挂：其导出的 unfreezeRedpackets 供 user/cards 打款链路使用） ----
const activityMod = await import('./routes/activity.js');
const unfreezeRedpackets = activityMod.unfreezeRedpackets;
const contract = await import('./routes/misc.js');
const bcrypt = (await import('bcryptjs')).default;
const jwt = (await import('jsonwebtoken')).default;
const ctx = { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, selfUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket,
  rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday,
  CONTRACT_VERSION: contract.CONTRACT_VERSION, CONTRACT_TITLE: contract.CONTRACT_TITLE, CONTRACT_TEXT: contract.CONTRACT_TEXT,
  unfreezeRedpackets };
try {
  activityMod.default(app, { auth, getDb, cnDayStr, cnMonthStr, notify, ObjectId, CONFIG, normalizeStatus });
  console.log('[活动] 签到/红包/月度路由已挂载（routes/activity.js）');
} catch (e) { console.error('[活动] 模块加载失败:', e.message); }
(await import('./routes/orders.js')).default(ctx);
(await import('./routes/user.js')).default(ctx);
(await import('./routes/ads.js')).default(ctx);
(await import('./routes/misc.js')).default(ctx);
(await import('./routes/authx.js')).default(ctx);
(await import('./routes/cards.js')).default(ctx);
(await import('./routes/worktime.js')).default(ctx);
(await import('./routes/gameadmin.js')).default(ctx);
(await import('./routes/dbadmin.js')).default(ctx);   // 【v24.0】数据库占用与清理
(await import('./routes/portal.js')).default(app, ctx);
// ---- 游戏模块 ----
try {
  (await import('./games.js')).default(app, { auth, getDb, cnDayStr });
  console.log('[游戏] 魔法翻翻乐模块已挂载');
} catch (e) { console.error('[游戏] 翻翻乐加载失败:', e.message); }
try {
  (await import('./shanhai_game.js')).default(app, { auth, getDb });
  console.log('[游戏] 山海斩妖录模块已挂载');
} catch (e) { console.error('[游戏] 山海加载失败:', e.message); }
try {
  (await import('./routes/recharge.js')).default(app, { ...ctx, GridFSBucket });
  console.log('[钱包] 充值（截图识别 + 人工审核）模块已挂载');
} catch (e) { console.error('[钱包] 充值模块加载失败:', e.message); }


// —— uid 补齐迁移（旧账号无 uid 时分配）——
(async () => {
  try {
    const db = await getDb();
    // 【2026-09-17 修复】uid: null 匹配不到"字段不存在"的旧账号，补齐迁移会漏人
    const miss = await db.collection('users').find({ $or: [{ uid: null }, { uid: { $exists: false } }] }).limit(50).toArray();
    for (const u of miss) await assignUid(db, u._id);
  } catch (e) { console.error('uid补齐失败:', e.message); }
})();

// —— 【v24.8】山海挂机收益：给"已解锁条件但还没有计时起点"的老玩家从现在开始计时 ——
// 幂等：只补 idleAt 缺失的档案，重复重启不会重复发奖，也不会补发历史时长
(async () => {
  try {
    const db = await getDb();
    const mod = await import('./shanhai_game.js');
    const fn = (mod.default && mod.default.activateIdle) || mod.activateIdle;
    if (typeof fn !== 'function') return;
    const r = await fn(db);
    console.log(`[山海·挂机] 解锁线：通关第 ${r.unlockStage} 关 ｜ 符合条件 ${r.eligible} 人 ｜ 本次激活 ${r.activated} 人 ｜ 已在计时 ${r.already} 人`);
  } catch (e) { console.error('挂机激活迁移失败:', e.message); }
})();

// ---- 兜底与启动 ----
app.use((req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));
server.listen(CONFIG.port, () => {
  console.log(`订单统计系统V15（ES6模块化）已启动: http://localhost:${CONFIG.port}`);
  console.log(`架构: server.js 入口 + config.js + lib/{db,core,env,ratelimit}.js + routes/ 9 个业务模块 + 2 个游戏模块`);
  // 【v25.1 事故修复】V25.0 这里在启动 5 秒后自动预热 OCR（tesseract.js + 中文语言包），
  // 在 Render 免费实例（512MB）上直接把内存打满 → 进程被杀 → 重启 5 秒后又预热 → 崩溃循环（502/503）。
  // 现在默认**不预热、不加载**：OCR 只在有人真的上传截图时按需初始化，且带超时与失败降级；
  // 需要预热时用环境变量显式开启：OCR_WARMUP=1
  if (process.env.OCR_WARMUP === '1') {
    setTimeout(async () => {
      try {
        const { warmup } = await import('./lib/ocr.js');
        const st = await warmup();
        console.log('[充值] OCR ' + (st.available ? '已就绪' : '不可用（充值将全部转人工审核）：' + st.reason));
      } catch (e) { console.log('[充值] OCR 预热跳过：' + e.message); }
    }, 8000);
  } else {
    console.log('[充值] OCR 预热已关闭（默认）：识别按需初始化，失败自动转人工审核');
  }
  const r = envReport();
  console.log('[自检] JWT_SECRET: ' + (r.JWT_SECRET ? '已配置 ✓' : '未配置 ⚠ 使用随机密钥，重启后需重新登录（建议在 .env 里配置）'));
  console.log('[自检] MONGO_URI : ' + (r.MONGO_URI ? '已配置 ✓' : '未配置（使用 config.js 默认值）'));
  console.log('[自检] TRUST_PROXY: ' + (r.TRUST_PROXY ? '已开启（反代后面部署）' : '关闭（直连部署）'));
});

