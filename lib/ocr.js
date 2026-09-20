// lib/ocr.js — 充值截图金额识别（可选 OCR，子进程隔离 + 内存护栏）
// 血泪教训（V25.0 → V25.1 事故）：tesseract.js 的 wasm + 中文语言包在 Render 免费实例（512MB）
// 上会把内存打满导致**整站崩溃循环**。因此本模块现在的设计是：
//   1) 默认完全关闭（OCR_ENABLED !== '1' 时直接返回不可用，充值单转人工审核）
//   2) 开启时也不在**主进程**加载引擎，而是 fork 子进程（限制 JS 堆），
//      子进程崩溃/超时只影响这一单，主站不受影响
//   3) 父进程有内存护栏（RSS 过高直接跳过 OCR）与熔断（连续失败自动停用一小时）
//   4) 金额解析是纯函数、带优先级，可单测，与 OCR 引擎无关
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, 'ocr-child.mjs');
const LOCAL_TESSDATA = path.join(__dirname, 'tessdata');   // 随包发布的语言包目录（有则优先用）

let ocrState = { available: null, reason: '' };
let fails = 0, disabledUntil = 0;   // 熔断：连续失败 2 次停用 1 小时

// ---------------- 金额解析（纯函数，带优先级） ----------------
// 优先级（越小越可信）：
//   1 = ¥/￥ 前缀（支付宝转账页主金额就是这种）
//   2 = 中文"元"结尾
//   3 = 收款/转账/付款/金额/实付 等关键字后面
//   4 = 带 + 号
//   5 = 裸的两位小数（兜底）
// 这样"顶部 ¥0.10 + 一堆优惠券 2元/3元/10元"的截图不会被 10 元带偏。
const RULES = [
  { pri: 1, re: /[¥￥]\s*([0-9][0-9,]*\.?[0-9]{0,2})/g },
  { pri: 2, re: /([0-9][0-9,]*\.?[0-9]{0,2})\s*元/g },
  { pri: 3, re: /(?:收款|转账|付款|支付|金额|实付|到账|成功)\s*[:：]?\s*([0-9][0-9,]*\.?[0-9]{0,2})/g },
  { pri: 4, re: /[+＋]\s*([0-9][0-9,]*\.?[0-9]{0,2})/g },
];
function parseAmounts(text) {
  const t = String(text || '');
  const out = [];
  for (const { pri, re } of RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      const v = Number(String(m[1]).replace(/[,，\s]/g, ''));
      if (Number.isFinite(v) && v > 0 && v < 1e7) out.push({ amount: Math.round(v * 100) / 100, raw: m[0].trim(), pri });
    }
  }
  // 兜底：一条候选都没有时，抓"像金额的裸小数"。
  // 注意 lookbehind 只排除数字/点/冒号（日期 2026-09-20、时间 15:21:04、订单号都是无点或冒号），
  // **不排除负号**——支付宝"账单详情"页的主金额就长这样：-1.00（没有 ¥ 也没有"元"）。
  if (!out.length) {
    const re = /(?<![0-9.:])([0-9]{1,6}\.[0-9]{2})(?![0-9])/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > 0 && v < 1e7) out.push({ amount: v, raw: m[1], pri: 5 });
    }
  }
  const seen = new Set();
  return out.filter(x => (seen.has(x.amount + '@' + x.pri) ? false : (seen.add(x.amount + '@' + x.pri), true)));
}
// 选金额：① 先找与申报金额一致的（任何优先级）② 否则取优先级最高的一组里最大的
function pickAmount(text, declared) {
  const list = parseAmounts(text);
  if (!list.length) return { amount: null, list: [] };
  const d = Number(declared);
  if (Number.isFinite(d) && d > 0) {
    const hit = list.find(x => Math.abs(x.amount - d) < 0.011);
    if (hit) return { amount: hit.amount, list, matched: true, pri: hit.pri };
  }
  const best = Math.min(...list.map(x => x.pri));
  const group = list.filter(x => x.pri === best);
  const max = group.reduce((a, b) => (b.amount > a.amount ? b : a), group[0]);
  return { amount: max.amount, list, matched: false, pri: max.pri };
}

// ---------------- 引擎调用（子进程，崩了不影响主站） ----------------
let queue = Promise.resolve();   // 串行化：同一时刻只跑一个识别子进程，避免并发把孩子堆爆
function enabled(allow) {
  if (process.env.OCR_ENABLED === '0') return false;          // 紧急总开关（环境变量优先关）
  if (allow === false) return false;                          // 后台开关关闭
  return true;
}
function memOk() {
  try {
    const rss = process.memoryUsage().rss / 1048576;
    if (rss > 300) { ocrState = { available: false, reason: `主进程内存偏高（${Math.round(rss)}MB），本单转人工审核` }; return false; }
  } catch (e) {}
  return true;
}
function recognizeInChild(buf, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch (e) {} resolve(v); } };
    let child;
    try {
      // 子进程单独限堆（96MB）：OCR 是"能识别就识别，识别不了转人工"，绝不能让主站陪葬
      child = fork(CHILD, [], { execArgv: ['--max-old-space-size=96'], stdio: ['pipe', 'pipe', 'ignore', 'ipc'], env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
    } catch (e) {
      return resolve({ ok: false, reason: '无法启动识别子进程：' + e.message });
    }
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.on('error', e => finish({ ok: false, reason: '识别子进程异常：' + e.message }));
    child.on('exit', () => {
      if (done) return;
      try { finish(JSON.parse(out || '{}')); } catch (e) { finish({ ok: false, reason: '识别结果解析失败' }); }
    });
    try {
      const req = {
        data: Buffer.from(buf).toString('base64'),
        langs: process.env.OCR_HEAVY === '1' ? ['eng', 'chi_sim'] : ['eng'],
        cachePath: process.env.TESS_CACHE || '/tmp/tessdata',
      };
      // 本地语言包存在就用它（免 CDN 下载 → 首次识别也很快）
      try { if (fs.existsSync(path.join(LOCAL_TESSDATA, 'eng.traineddata.gz'))) req.langPath = LOCAL_TESSDATA; } catch (e) {}
      child.stdin.end(JSON.stringify(req));
    } catch (e) { finish({ ok: false, reason: '传给识别子进程失败' }); }
    setTimeout(() => finish({ ok: false, reason: '识别超时（已放弃，转人工审核）' }), timeoutMs);
  });
}

// allow=false（后台关闭 OCR）时直接转人工；串行执行避免并发撑爆实例
async function recognize(buf, timeoutMs = 25000, allow) {
  if (!enabled(allow)) {
    const why = process.env.OCR_ENABLED === '0' ? 'OCR 已被环境变量强制关闭' : '后台已关闭 OCR 自动识别';
    ocrState = { available: false, reason: why + '（当前充值全部转人工审核）' };
    return { ok: false, reason: ocrState.reason, text: '', confidence: 0 };
  }
  if (Date.now() < disabledUntil) {
    return { ok: false, reason: '识别已临时停用（连续失败自动熔断），本单转人工审核', text: '', confidence: 0 };
  }
  if (!memOk()) return { ok: false, reason: ocrState.reason, text: '', confidence: 0 };
  const run = async () => {
    const r = await recognizeInChild(buf, timeoutMs);
    if (r && r.ok) {
      fails = 0;
      ocrState = { available: true, reason: process.env.OCR_HEAVY === '1' ? '中英双语包' : '英文包（数字识别）' };
      return r;
    }
    fails++;
    ocrState = { available: false, reason: (r && r.reason) || '识别失败' };
    if (fails >= 2) { disabledUntil = Date.now() + 3600 * 1000; fails = 0; ocrState.reason += '（已熔断 1 小时）'; }
    return { ok: false, reason: ocrState.reason, text: '', confidence: 0 };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

function status(allow) {
  return {
    ...ocrState,
    lib: 'tesseract.js（子进程隔离）',
    enabled: enabled(allow),
    heavy: process.env.OCR_HEAVY === '1',
    forceOff: process.env.OCR_ENABLED === '0',
    circuitOpen: Date.now() < disabledUntil,
  };
}
// 预热：仅显式开启时可用（V25.1 事故后不再默认预热）
async function warmup() {
  if (!enabled()) return { available: false, reason: 'OCR 未启用（OCR_ENABLED 未设为 1）' };
  return status();
}

export { recognize, parseAmounts, pickAmount, status, warmup };
