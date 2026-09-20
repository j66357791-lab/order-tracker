// mod-recharge.js — 【v25.0】充值管理：平台收款配置 + 截图审核 + OCR 自检
import { api, esc, toast, cnTime } from './app.js';

export function mount(root) {
  const $ = id => root.querySelector('#' + id);
  root.innerHTML = `
  <div class="card">
    <h2 class="serif">充值通道配置</h2>
    <div class="sub">写手端「充值」页展示的官方收款信息；自动到账额度用于控制机器审核放行范围，超出的一律转人工二审。</div>
    <div class="grid3" style="margin-top:12px">
      <div><label class="lab">支付宝收款账号</label><input id="rcAcc" placeholder="如 13800000000 或 name@qq.com"></div>
      <div><label class="lab">收款人姓名（转账页显示）</label><input id="rcName" placeholder="如 张三"></div>
      <div><label class="lab">通道开关</label>
        <select id="rcEnabled"><option value="1">开放充值</option><option value="0">暂停充值</option></select>
      </div>
      <div><label class="lab">机器识别（OCR）</label>
        <select id="rcOcr"><option value="1">开启（小额自动到账）</option><option value="0">关闭（全部转人工审核）</option></select>
      </div>
      <div><label class="lab">订单号核验（免 OCR）</label>
        <select id="rcOrderNo"><option value="1">开启（填订单号即秒到账）</option><option value="0">关闭</option></select>
      </div>
      <div><label class="lab">自动到账单笔上限（元）</label><input id="rcAutoMax" type="number" min="0" step="1"></div>
      <div><label class="lab">自动到账单日笔数上限</label><input id="rcDailyCount" type="number" min="0" step="1"></div>
      <div><label class="lab">自动到账单日金额上限（元）</label><input id="rcDailyAmount" type="number" min="0" step="1"></div>
      <div><label class="lab">单笔最低（元）</label><input id="rcMin" type="number" min="0" step="1"></div>
      <div><label class="lab">单笔最高（元）</label><input id="rcMax" type="number" min="0" step="1"></div>
      <div><label class="lab">收款二维码</label><input type="file" id="rcQr" accept="image/*"></div>
    </div>
    <div style="margin-top:10px"><label class="lab">转账提示文案（写手端展示）</label><input id="rcTip" placeholder="如：转账备注写手昵称，截图需含金额与收款人"></div>
    <div class="inline" style="margin-top:12px">
      <button class="btn-main" id="rcSave">保存配置</button>
      <button class="btn-ghost" id="rcViewQr">查看当前二维码</button>
      <span class="sub" id="rcOcrState" style="margin-left:auto"></span>
    </div>
  </div>

  <div class="card">
    <h2 class="serif">充值审核</h2>
    <div class="sub">机器识别一致的小额已自动到账；下表是<b>需要人工二审</b>或已处理的单据。截图、申报金额、识别金额、识别原文全部留档。</div>
    <div class="inline" style="margin:10px 0">
      <button class="btn-ghost on" data-st="pending" id="rcT-pending">待审核</button>
      <button class="btn-ghost" data-st="paid">已到账</button>
      <button class="btn-ghost" data-st="rejected">已驳回</button>
      <button class="btn-ghost" data-st="all">全部</button>
      <button class="btn-ghost" id="rcReload" style="margin-left:auto">刷新</button>
    </div>
    <div class="grid3" id="rcStats"><div class="empty">加载中…</div></div>
    <div id="rcOrders" style="margin-top:12px"><div class="empty">加载中…</div></div>
  </div>

  <div class="card">
    <h2 class="serif">OCR 自检</h2>
    <div class="sub">传一张支付宝截图试识别，用于核对"识别不准"到底是图的问题还是引擎的问题。</div>
    <div class="inline" style="margin-top:10px">
      <input type="file" id="rcTestFile" accept="image/*">
      <input id="rcTestAmount" type="number" placeholder="申报金额（可选）" style="max-width:140px">
      <button class="btn-main" id="rcTestGo">识别测试</button>
    </div>
    <div id="rcTestOut" style="margin-top:10px"></div>
  </div>`;

  let curSt = 'pending', CFG = null;
  const ST = { auto_paid: ['机器已到账', 'ok'], paid: ['人工已到账', 'ok'], pending: ['待人工审核', 'warn'], rejected: ['已驳回', 'bad'] };

  async function loadCfg() {
    try {
      const r = await api('/api/admin/recharge/config');
      CFG = r.config;
      $('rcAcc').value = CFG.alipayAccount || '';
      $('rcName').value = CFG.alipayName || '';
      $('rcEnabled').value = CFG.enabled ? '1' : '0';
      $('rcOcr').value = CFG.ocrEnabled === false ? '0' : '1';
      $('rcOrderNo').value = CFG.orderNoVerify === false ? '0' : '1';
      $('rcAutoMax').value = CFG.autoMax; $('rcDailyCount').value = CFG.autoDailyCount;
      $('rcDailyAmount').value = CFG.autoDailyAmount; $('rcMin').value = CFG.minAmount; $('rcMax').value = CFG.maxAmount;
      $('rcTip').value = CFG.tip || '';
      const o = r.ocr || {};
      $('rcOcrState').innerHTML = !o.enabled
        ? '<span style="color:#c9a227">机器识别已关闭：充值单全部转人工审核</span>'
        : (o.available === true
          ? '<span style="color:var(--green2)">OCR 引擎就绪' + (o.circuitOpen ? '（熔断中，本单转人工）' : '') + '</span>'
          : '<span class="sub">OCR 已开启，首次识别时加载引擎（' + esc(o.reason || '未测试') + '）</span>');
    } catch (e) { toast(e.message); }
  }
  $('rcSave').onclick = async () => {
    try {
      await api('/api/admin/recharge/config', { method: 'POST', body: JSON.stringify({
        alipayAccount: $('rcAcc').value.trim(), alipayName: $('rcName').value.trim(),
        enabled: $('rcEnabled').value === '1',
        ocrEnabled: $('rcOcr').value === '1',
        orderNoVerify: $('rcOrderNo').value === '1',
        autoMax: Number($('rcAutoMax').value), autoDailyCount: Number($('rcDailyCount').value),
        autoDailyAmount: Number($('rcDailyAmount').value), minAmount: Number($('rcMin').value), maxAmount: Number($('rcMax').value),
        tip: $('rcTip').value.trim(),
      }) });
      toast('配置已保存'); loadCfg();
    } catch (e) { toast(e.message); }
  };
  $('rcViewQr').onclick = () => {
    if (!CFG || !CFG.qrFileId) return toast('还没上传二维码');
    window.open('/api/recharge/qr?t=' + Date.now());
  };
  $('rcQr').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try {
      const r = await fetch('/api/admin/recharge/qr', { method: 'POST', headers: { Authorization: 'Bearer ' + (localStorage.getItem('jdy_token') || '') }, body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '上传失败');
      toast('二维码已更新'); CFG.qrFileId = j.qrFileId;
    } catch (err) { toast(err.message); }
  };

  async function loadOrders() {
    try {
      const r = await api('/api/admin/recharge/orders?status=' + curSt);
      const s = r.stats || {};
      $('rcStats').innerHTML = `
        <div class="stat"><i>待人工审核</i><b>${s.pending || 0}</b></div>
        <div class="stat"><i>机器自动到账</i><b>${s.autoPaid || 0}</b></div>
        <div class="stat"><i>累计充值金额</i><b>¥${(r.total && r.total.total || 0).toFixed(2)}</b></div>`;
      const rows = r.rows || [];
      $('rcOrders').innerHTML = rows.length ? `<table><tr><th>单号/时间</th><th>写手</th><th>申报</th><th>机器识别</th><th>订单号</th><th>截图</th><th>状态</th><th>操作</th></tr>` + rows.map(o => {
        const st = ST[o.status] || [o.status, ''];
        const t = o.createdAt ? cnTime(o.createdAt) : '';
        const vm = o.verifyMethod === 'ocr' ? '截图识别' : (o.verifyMethod === 'orderNo' ? '订单号' : '');
        return `<tr>
          <td><code>${esc(o.no || '')}</code><div class="sub">${esc(t)}</div></td>
          <td>${esc(o.username || '')}</td>
          <td class="num">¥${(o.amount || 0).toFixed(2)}</td>
          <td class="num">${o.ocrAmount != null ? '¥' + o.ocrAmount.toFixed(2) : '<span class="sub">未识别</span>'}
            <div class="sub">${o.ocrOk ? '置信 ' + (o.ocrConfidence || 0) + (o.amountMatched ? ' · 一致' : ' · 不一致') : esc((o.reason || '').slice(0, 26))}</div></td>
          <td><code style="font-size:11px">${o.orderNo ? esc(String(o.orderNo).slice(-10)) : '<span class="sub">未填</span>'}</code></td>
          <td>${o.shotFileId ? `<button class="btn-ghost" style="padding:3px 9px" data-shot="${esc(o.shotFileId)}">查看截图</button>` : '<span class="sub">无</span>'}</td>
          <td><b class="${st[1]}">${st[0]}</b>${vm ? '<div class="sub">核验：' + vm + '</div>' : ''}${o.reason ? '<div class="sub">' + esc(o.reason) + '</div>' : ''}${o.reviewNote ? '<div class="sub">备注：' + esc(o.reviewNote) + '</div>' : ''}</td>
          <td>${(o.status === 'pending' || o.status === 'auto_paid')
            ? `<button class="btn-main" style="padding:4px 10px" data-ok="${esc(String(o._id))}">到账</button>
               <button class="btn-danger" style="padding:4px 10px;margin-top:4px" data-no="${esc(String(o._id))}">驳回</button>`
            : '<span class="sub">—</span>'}</td>
        </tr>`;
      }).join('') + '</table>' : '<div class="empty">没有符合条件的单据</div>';
    } catch (e) { $('rcOrders').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  root.querySelectorAll('[data-st]').forEach(b => b.onclick = () => {
    curSt = b.dataset.st;
    root.querySelectorAll('[data-st]').forEach(x => x.classList.toggle('on', x === b));
    loadOrders();
  });
  $('rcReload').onclick = () => { loadCfg(); loadOrders(); };
  $('rcOrders').addEventListener('click', async e => {
    // 【v25.2 修复】截图必须带登录头取：<a href> 直开图片会返回"未登录"
    const sh = e.target.closest('[data-shot]');
    if (sh) {
      const old = document.getElementById('rcShotMask');
      if (old) old.remove();
      const mask = document.createElement('div');
      mask.id = 'rcShotMask';
      mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out';
      mask.innerHTML = '<div style="color:#fff;font:14px sans-serif">截图加载中…</div>';
      mask.onclick = () => mask.remove();
      document.body.appendChild(mask);
      try {
        const r = await fetch('/api/recharge/shot/' + sh.dataset.shot, { headers: { Authorization: 'Bearer ' + (localStorage.getItem('jdy_token') || '') } });
        if (!r.ok) throw new Error(r.status === 401 ? '登录已过期，请重新登录后台' : '加载失败（' + r.status + '）');
        const url = URL.createObjectURL(await r.blob());
        mask.innerHTML = `<img src="${url}" style="max-width:92vw;max-height:88vh;border-radius:10px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.5)" alt="充值截图">`;
      } catch (err) {
        mask.innerHTML = '<div style="color:#ffb4a2;font:14px sans-serif">' + esc(err.message) + '</div>';
      }
      return;
    }
    const ok = e.target.closest('[data-ok]'), no = e.target.closest('[data-no]');
    if (ok) {
      const amt = prompt('确认到账金额（元，默认按申报金额）：', '');
      if (amt === null) return;
      const body = { action: 'approve' };
      if (amt.trim()) body.amount = Number(amt);
      try { const r = await api('/api/admin/recharge/' + ok.dataset.ok + '/review', { method: 'POST', body: JSON.stringify(body) }); toast('已到账 ¥' + r.amount + '（写手余额 ¥' + r.balance + '）'); loadOrders(); }
      catch (err) { toast(err.message); }
    }
    if (no) {
      const note = prompt('驳回原因（会展示给写手）：', '截图未识别到有效金额，请重新上传');
      if (note === null) return;
      try { await api('/api/admin/recharge/' + no.dataset.no + '/review', { method: 'POST', body: JSON.stringify({ action: 'reject', note }) }); toast('已驳回'); loadOrders(); }
      catch (err) { toast(err.message); }
    }
  });
  $('rcTestGo').onclick = async () => {
    const f = $('rcTestFile').files && $('rcTestFile').files[0];
    if (!f) return toast('请选择图片');
    $('rcTestOut').innerHTML = '<div class="sub">识别中，请稍候…</div>';
    const fd = new FormData(); fd.append('file', f); fd.append('amount', $('rcTestAmount').value || '');
    try {
      const r = await fetch('/api/admin/recharge/ocr-test', { method: 'POST', headers: { Authorization: 'Bearer ' + (localStorage.getItem('jdy_token') || '') }, body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '识别失败');
      $('rcTestOut').innerHTML = `<div class="sub">引擎状态：${esc(JSON.stringify(j.state))}</div>
        <div class="kv"><span class="k">识别结果</span><span class="v">${j.ocr.ok ? '成功（置信 ' + j.ocr.confidence + '）' : '失败：' + esc(j.ocr.reason || '')}</span></div>
        <div class="kv"><span class="k">判定金额</span><span class="v">${j.picked.amount != null ? '¥' + j.picked.amount : '未识别到'}</span></div>
        <div class="kv"><span class="k">候选金额</span><span class="v">${(j.candidates || []).map(c => '¥' + c.amount).join('、') || '—'}</span></div>
        <div class="sub" style="white-space:pre-wrap;max-height:240px;overflow:auto;background:var(--grey-bg);border-radius:8px;padding:8px;margin-top:8px">${esc((j.ocr.text || '').slice(0, 1500))}</div>`;
    } catch (e) { $('rcTestOut').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  };

  loadCfg(); loadOrders();
  return { refresh: () => { loadCfg(); loadOrders(); } };
}
