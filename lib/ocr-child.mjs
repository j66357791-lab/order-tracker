// lib/ocr-child.mjs — OCR 子进程（隔离运行，崩了不影响主服务）
// 由 lib/ocr.js 用 child_process.fork 拉起：读一张图 → 输出 JSON → 退出。
// 单独进程的意义：tesseract.js 的 wasm 内存若爆了，死的是这个子进程，主站照常服务。
// 用法（父进程调用）：fork(此文件, [], { execArgv: ['--max-old-space-size=160'] })
//   父 → 子：stdin 收 JSON { data: base64, langs: [...], cachePath }
//   子 → 父：stdout 一行 JSON { ok, text, confidence, reason }
let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', async () => {
  const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
  try {
    const req = JSON.parse(input || '{}');
    const buf = Buffer.from(req.data || '', 'base64');
    let tesseract;
    try { tesseract = await import('tesseract.js'); }
    catch (e) { return out({ ok: false, reason: 'OCR 组件未安装（npm i tesseract.js）' }); }
    const { createWorker } = tesseract.default || tesseract;
    const langs = Array.isArray(req.langs) && req.langs.length ? req.langs : ['eng'];
    const w = await createWorker(langs, 1, { cachePath: req.cachePath || '/tmp/tessdata', logger: () => {} });
    const r = await w.recognize(buf);
    const text = (r && r.data && r.data.text) || '';
    const confidence = (r && r.data && typeof r.data.confidence === 'number') ? r.data.confidence : 0;
    try { await w.terminate(); } catch (e) {}
    out({ ok: true, text, confidence: Math.round(confidence) });
  } catch (e) {
    out({ ok: false, reason: (e && e.message) || '识别失败' });
  }
});
