// lib/ocr.js — 充值截图金额识别（可插拔 OCR）
// 设计原则：
//   1) OCR 是**可选依赖**（package.json optionalDependencies 里的 tesseract.js）。
//      装不上 / 跑不动 / 超时 → 一律返回 ok:false，让单据落进人工审核队列，绝不卡住用户。
//   2) 只输出"识别到的候选金额 + 原文 + 置信度"，是否自动到账由 routes/recharge.js 判定。
//   3) 纯函数 parseAmounts() 独立可测（不依赖 OCR 引擎）。

let workerPromise = null;
let ocrState = { available: null, reason: '' };   // available: null=未知 true/false

// —— 从 OCR 文本里抽金额（纯函数，可单测）——
// 支持：¥1,234.56 / 1234.56元 / +100.00 / 收款100.00 / 转账 88 / 金额 1,000.00
const PATTERNS = [
  /[¥￥]\s*([0-9][0-9,]*\.?[0-9]{0,2})/g,                       // ¥1,234.56
  /([0-9][0-9,]*\.?[0-9]{0,2})\s*元/g,                          // 1234.56元
  /(?:收款|转账|付款|支付|金额|实付|到账|成功)\s*[:：]?\s*([0-9][0-9,]*\.?[0-9]{0,2})/g,  // 收款 100.00
  /([+＋]\s*[0-9][0-9,]*\.?[0-9]{0,2})/g,                       // +100.00
];
function parseAmounts(text) {
  const t = String(text || '').replace(/[，。；：]/g, m => m);   // 保留中文标点，仅做统一处理
  const found = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      const raw = String(m[1] || '').replace(/[,，\s＋+]/g, '');
      const v = Number(raw);
      if (Number.isFinite(v) && v > 0 && v < 1e7) found.push({ amount: Math.round(v * 100) / 100, raw: m[0].trim() });
    }
  }
  // 没有货币符号时，兜底抓"像金额的独立小数"（xx.xx，两位小数最常见）
  if (!found.length) {
    const re = /(?<![0-9.])([0-9]{1,6}\.[0-9]{2})(?![0-9])/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > 0 && v < 1e7) found.push({ amount: v, raw: m[1] });
    }
  }
  // 去重（同金额只留一条）
  const seen = new Set();
  return found.filter(x => (seen.has(x.amount) ? false : (seen.add(x.amount), true)));
}
// 取"最可能的收款金额"：优先与申报金额一致的；否则取出现的最大值（支付宝到账金额一般是图里最大金额）
function pickAmount(text, declared) {
  const list = parseAmounts(text);
  if (!list.length) return { amount: null, list: [] };
  const d = Number(declared);
  if (Number.isFinite(d) && d > 0) {
    const hit = list.find(x => Math.abs(x.amount - d) < 0.011);
    if (hit) return { amount: hit.amount, list, matched: true };
  }
  const max = list.reduce((a, b) => (b.amount > a.amount ? b : a), list[0]);
  return { amount: max.amount, list, matched: false };
}

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    let tesseract;
    try {
      tesseract = await import('tesseract.js');   // 可选依赖：未安装会 throw
    } catch (e) {
      ocrState = { available: false, reason: 'OCR 组件未安装（npm i tesseract.js）' };
      return null;
    }
    try {
      const { createWorker } = tesseract.default || tesseract;
      const w = await createWorker(['eng', 'chi_sim'], 1, {
        cachePath: process.env.TESS_CACHE || '/tmp/tessdata',
        logger: () => {},
      });
      ocrState = { available: true, reason: '' };
      return w;
    } catch (e) {
      ocrState = { available: false, reason: 'OCR 初始化失败：' + e.message };
      workerPromise = null;
      return null;
    }
  })();
  return workerPromise;
}

// 识别一张图片（Buffer）→ { ok, text, confidence, reason }
async function recognize(buf, timeoutMs = 20000) {
  const w = await getWorker();
  if (!w) return { ok: false, reason: ocrState.reason || 'OCR 不可用', text: '', confidence: 0 };
  try {
    const job = w.recognize(Buffer.from(buf));
    const r = await Promise.race([
      job,
      new Promise((_, rej) => setTimeout(() => rej(new Error('识别超时')), timeoutMs)),
    ]);
    const text = (r && r.data && r.data.text) || '';
    const confidence = (r && r.data && typeof r.data.confidence === 'number') ? r.data.confidence : 0;
    return { ok: true, text, confidence: Math.round(confidence) };
  } catch (e) {
    return { ok: false, reason: e.message || '识别失败', text: '', confidence: 0 };
  }
}

function status() { return { ...ocrState, lib: 'tesseract.js', optional: true }; }

export { recognize, parseAmounts, pickAmount, status };
