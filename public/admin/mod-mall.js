// admin/mod-mall.js — 用户端配置面板（方案二第二步迁入，来源 admin_packages.html）
// 套餐上架 / 文案馆作品管理 / 用户咨询跟进
import { api, esc, toast, cnTime } from './app.js';

export function mount(root) {
  root.innerHTML = `
  <div class="content-head">
    <div><h1 class="serif">用户端配置</h1><div class="sub">商城套餐 / 文案馆作品 / 用户咨询——改动用户端即时生效</div></div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="mlRefresh">刷新数据</button>
  </div>

  <div class="inline" style="margin-bottom:16px">
    <button class="btn-main" id="mlTabPkg">套餐配置</button>
    <button class="btn-ghost" id="mlTabGal">作品管理</button>
    <button class="btn-ghost" id="mlTabLead">用户咨询</button>
  </div>

  <div id="mlBoxPkg">
    <div class="card">
      <div class="inline"><div class="sub" style="margin:0">上架中的套餐在用户端商城按排序展示</div><div class="spacer" style="flex:1"></div>
      <button class="btn-main" id="mlPkgNew">+ 新增套餐</button></div>
      <div id="mlPkgList" style="margin-top:12px"><div class="empty">加载中…</div></div>
    </div>
  </div>

  <div id="mlBoxGal" style="display:none">
    <div class="card">
      <div class="inline"><div class="sub" style="margin:0">文案馆作品（用户端「作品·能做什么」与首页展示）</div><div class="spacer" style="flex:1"></div>
      <button class="btn-main" id="mlGalNew">+ 新增作品</button></div>
      <div id="mlGalList" style="margin-top:12px"><div class="empty">加载中…</div></div>
    </div>
  </div>

  <div id="mlBoxLead" style="display:none">
    <div class="card">
      <div class="sub">用户从商城/宣传页提交的咨询，跟进后标记即可</div>
      <div id="mlLeadList"><div class="empty">加载中…</div></div>
    </div>
  </div>

  <!-- 套餐编辑弹窗 -->
  <div class="mask" id="mlPkgMask"><div class="modal">
    <h3 class="serif" id="mlPkgTitle">新增套餐</h3>
    <div class="f-row"><label>套餐名</label><input id="mlFName"></div>
    <div class="f-row"><label>一句话卖点</label><input id="mlFTag"></div>
    <div class="inline"><div class="f-row" style="flex:1"><label>现价 ¥</label><input id="mlFPrice" type="number"></div>
    <div class="f-row" style="flex:1"><label>划线原价 ¥（可空）</label><input id="mlFOrig" type="number"></div></div>
    <div class="inline"><div class="f-row" style="flex:1"><label>角标（如：最受欢迎）</label><input id="mlFBadge"></div>
    <div class="f-row" style="flex:1"><label>排序（小的在前）</label><input id="mlFOrder" type="number" value="99"></div></div>
    <div class="f-row"><label>包含内容（每行一条）</label><textarea id="mlFItems" rows="4"></textarea></div>
    <div class="f-row"><label><input type="checkbox" id="mlFActive" checked style="width:auto"> 上架中</label></div>
    <div class="err" id="mlPkgErr"></div>
    <div class="inline"><button class="btn-main" id="mlPkgSave" style="flex:1">保存</button><button class="btn-ghost" id="mlPkgCancel">取消</button></div>
  </div></div>

  <!-- 作品编辑弹窗 -->
  <div class="mask" id="mlGalMask"><div class="modal">
    <h3 class="serif" id="mlGalTitle">新增作品</h3>
    <div class="inline"><img id="mlGPrev" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:10px;background:var(--paper2)">
    <div style="flex:1;min-width:0">
      <div class="f-row"><label>标题</label><input id="mlGTitle"></div>
      <div class="f-row"><label>分类</label><select id="mlGCat"><option>文案</option><option>演示</option><option>数据</option><option>视频</option></select></div>
    </div></div>
    <div class="f-row"><label>图片地址（如 /assets/portal/gallery1.jpg）</label><input id="mlGImg"></div>
    <div class="inline"><div class="f-row" style="flex:1"><label>副题</label><input id="mlGSub"></div>
    <div class="f-row" style="flex:1"><label>标签</label><input id="mlGTag"></div></div>
    <div class="inline"><div class="f-row" style="flex:1"><label>排序</label><input id="mlGOrder" type="number" value="99"></div>
    <div class="f-row" style="flex:1"><label><input type="checkbox" id="mlGActive" checked style="width:auto"> 显示中</label></div></div>
    <div class="err" id="mlGalErr"></div>
    <div class="inline"><button class="btn-main" id="mlGalSave" style="flex:1">保存</button><button class="btn-ghost" id="mlGalCancel">取消</button><button class="btn-ghost" id="mlGalDel" style="display:none;color:var(--red)">删除</button></div>
  </div></div>`;

  const $ = id => root.querySelector('#' + id);

  // —— 内部小页签 ——
  function showTab(t) {
    $('mlTabPkg').className = t === 'pkg' ? 'btn-main' : 'btn-ghost';
    $('mlTabGal').className = t === 'gal' ? 'btn-main' : 'btn-ghost';
    $('mlTabLead').className = t === 'lead' ? 'btn-main' : 'btn-ghost';
    $('mlBoxPkg').style.display = t === 'pkg' ? '' : 'none';
    $('mlBoxGal').style.display = t === 'gal' ? '' : 'none';
    $('mlBoxLead').style.display = t === 'lead' ? '' : 'none';
    if (t === 'lead') loadLeads();
    if (t === 'gal') loadGal();
    if (t === 'pkg') loadPkgs();
  }
  $('mlTabPkg').onclick = () => showTab('pkg');
  $('mlTabGal').onclick = () => showTab('gal');
  $('mlTabLead').onclick = () => showTab('lead');

  // —— 套餐 ——
  async function loadPkgs() {
    const j = await api('/api/admin/packages').catch(() => null);
    if (!j || !j.ok) { $('mlPkgList').innerHTML = '<div class="empty">' + esc((j && j.error) || '加载失败') + '</div>'; return; }
    if (!j.packages.length) { $('mlPkgList').innerHTML = '<div class="empty">还没有套餐，点上方新增（用户端会自动内置3个种子套餐）</div>'; return; }
    $('mlPkgList').innerHTML = j.packages.map(p => `<div class="card">
      <div class="inline" style="justify-content:flex-start"><b class="serif" style="font-size:16px">${esc(p.name)}</b>
        <span class="num" style="color:var(--green);font-weight:600">¥${esc(p.price)}</span>
        ${p.originalPrice ? `<s style="color:var(--ink2);font-size:12px">¥${esc(p.originalPrice)}</s>` : ''}
        <span class="tag ${p.active ? 't1' : 't0'}">${p.active ? '上架中' : '已下架'}</span>
        <span style="flex:1"></span>
        <button class="btn-ghost" style="padding:4px 12px;font-size:12px" onclick="mlTogglePkg('${p._id}',${!p.active})">${p.active ? '下架' : '上架'}</button>
        <button class="btn-ghost" style="padding:4px 12px;font-size:12px" onclick="mlEditPkg('${p._id}')">编辑</button></div>
      <div style="font-size:12.5px;color:var(--ink2);margin-top:6px">${(p.items || []).map(i => '· ' + esc(i)).join('　')}</div>
    </div>`).join('');
  }
  window.mlEditPkg = (id) => {
    $('mlPkgMask').classList.add('on');
    $('mlPkgErr').textContent = '';
    if (!id) { $('mlPkgTitle').textContent = '新增套餐'; ['mlFName', 'mlFTag', 'mlFPrice', 'mlFOrig', 'mlFBadge', 'mlFItems'].forEach(i => $(i).value = ''); $('mlFOrder').value = 99; $('mlFActive').checked = true; return; }
    api('/api/admin/packages').then(j => {
      const p = j.packages.find(x => x._id === id); if (!p) return;
      $('mlPkgTitle').textContent = '编辑 · ' + p.name;
      $('mlFName').value = p.name || ''; $('mlFTag').value = p.tagline || '';
      $('mlFPrice').value = p.price || 0; $('mlFOrig').value = p.originalPrice || ''; $('mlFBadge').value = p.badge || '';
      $('mlFItems').value = (p.items || []).join('\n'); $('mlFOrder').value = p.order || 0; $('mlFActive').checked = !!p.active;
    });
  };
  $('mlPkgNew').onclick = () => window.mlEditPkg('');
  $('mlPkgCancel').onclick = () => $('mlPkgMask').classList.remove('on');
  $('mlPkgSave').onclick = async () => {
    const body = { name: $('mlFName').value.trim(), tagline: $('mlFTag').value.trim(), price: Number($('mlFPrice').value) || 0, originalPrice: Number($('mlFOrig').value) || 0, badge: $('mlFBadge').value.trim(), items: $('mlFItems').value.split('\n').map(s => s.trim()).filter(Boolean), order: Number($('mlFOrder').value) || 0, active: $('mlFActive').checked };
    if (!body.name) { $('mlPkgErr').textContent = '套餐名必填'; return; }
    const id = $('mlPkgErr').dataset.id || '';
    $('mlPkgErr').textContent = '';
    const j = await api(id ? '/api/admin/packages/' + id : '/api/admin/packages', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }).catch(() => null);
    if (j && j.ok) { $('mlPkgMask').classList.remove('on'); toast('已保存 ✓ 用户端即时生效'); loadPkgs(); } else $('mlPkgErr').textContent = (j && j.error) || '保存失败';
  };
  window.mlTogglePkg = async (id, active) => {
    const j = await api('/api/admin/packages/' + id, { method: 'PUT', body: JSON.stringify({ active }) }).catch(() => null);
    if (j && j.ok) loadPkgs(); else toast((j && j.error) || '操作失败');
  };
  // 编辑时把 id 存到 err 节点（省一个隐藏变量位）
  const _origEdit = window.mlEditPkg;
  window.mlEditPkg = (id) => { $('mlPkgErr').dataset.id = id || ''; _origEdit(id); };

  // —— 文案馆作品 ——
  async function loadGal() {
    const j = await api('/api/admin/gallery').catch(() => null);
    if (!j || !j.ok) { $('mlGalList').innerHTML = '<div class="empty">' + esc((j && j.error) || '加载失败') + '</div>'; return; }
    if (!j.gallery.length) { $('mlGalList').innerHTML = '<div class="empty">还没有作品，点上方新增</div>'; return; }
    $('mlGalList').innerHTML = j.gallery.map(g => `<div class="card">
      <div class="inline" style="justify-content:flex-start;align-items:flex-start">
        <img src="${esc(g.img)}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:10px;flex-shrink:0;background:var(--paper2)" onerror="this.style.opacity=.2">
        <div style="flex:1;min-width:0">
          <b class="serif">${esc(g.title)}</b> <span class="tag t-admin">${esc(g.cat || '文案')}</span> <span class="tag ${g.active ? 't1' : 't0'}">${g.active ? '显示中' : '已隐藏'}</span>
          <div style="font-size:12.5px;color:var(--ink2);margin-top:4px">${esc(g.sub || '')}${g.tag ? ' · ' + esc(g.tag) : ''} · 排序 ${esc(g.order)}</div>
        </div>
        <span style="display:flex;gap:8px;flex-shrink:0">
          <button class="btn-ghost" style="padding:4px 12px;font-size:12px" onclick="mlToggleGal('${g._id}',${!g.active})">${g.active ? '隐藏' : '显示'}</button>
          <button class="btn-ghost" style="padding:4px 12px;font-size:12px" onclick="mlEditGal('${g._id}')">编辑</button>
        </span>
      </div>
    </div>`).join('');
  }
  window.mlEditGal = (id) => {
    $('mlGalMask').classList.add('on');
    $('mlGalErr').textContent = ''; $('mlGalErr').dataset.id = id || '';
    $('mlGalDel').style.display = id ? '' : 'none';
    if (!id) {
      $('mlGalTitle').textContent = '新增作品';
      ['mlGTitle', 'mlGSub', 'mlGTag', 'mlGImg'].forEach(i => $(i).value = '');
      $('mlGCat').value = '文案'; $('mlGOrder').value = 99; $('mlGActive').checked = true;
      $('mlGPrev').removeAttribute('src'); return;
    }
    api('/api/admin/gallery').then(j => {
      const g = (j && j.gallery || []).find(x => x._id === id); if (!g) return;
      $('mlGalTitle').textContent = '编辑 · ' + g.title;
      $('mlGCat').value = g.cat || '文案'; $('mlGTitle').value = g.title || ''; $('mlGSub').value = g.sub || '';
      $('mlGTag').value = g.tag || ''; $('mlGImg').value = g.img || '';
      $('mlGOrder').value = g.order || 0; $('mlGActive').checked = !!g.active;
      $('mlGPrev').src = g.img || '';
    });
  };
  $('mlGalNew').onclick = () => window.mlEditGal('');
  $('mlGalCancel').onclick = () => $('mlGalMask').classList.remove('on');
  $('mlGalSave').onclick = async () => {
    const body = { cat: $('mlGCat').value, title: $('mlGTitle').value.trim(), sub: $('mlGSub').value.trim(), tag: $('mlGTag').value.trim(), img: $('mlGImg').value.trim(), order: Number($('mlGOrder').value) || 0, active: $('mlGActive').checked };
    if (!body.title) { $('mlGalErr').textContent = '标题必填'; return; }
    if (!body.img) { $('mlGalErr').textContent = '图片地址必填'; return; }
    const id = $('mlGalErr').dataset.id || '';
    const j = await api(id ? '/api/admin/gallery/' + id : '/api/admin/gallery', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }).catch(() => null);
    if (j && j.ok) { $('mlGalMask').classList.remove('on'); toast('已保存 ✓ 用户端即时生效'); loadGal(); } else $('mlGalErr').textContent = (j && j.error) || '保存失败';
  };
  window.mlToggleGal = async (id, active) => {
    const j = await api('/api/admin/gallery/' + id, { method: 'PUT', body: JSON.stringify({ active }) }).catch(() => null);
    if (j && j.ok) loadGal(); else toast((j && j.error) || '操作失败');
  };
  $('mlGalDel').onclick = async () => {
    const id = $('mlGalErr').dataset.id; if (!id) return;
    if (!confirm('确定删除这条作品？用户端首页会立即移除。')) return;
    const j = await api('/api/admin/gallery/' + id, { method: 'DELETE' }).catch(() => null);
    if (j && j.ok) { $('mlGalMask').classList.remove('on'); toast('已删除'); loadGal(); } else toast((j && j.error) || '删除失败');
  };
  $('mlGImg').addEventListener('input', () => { $('mlGPrev').src = $('mlGImg').value.trim(); });

  // —— 用户咨询 ——
  async function loadLeads() {
    const j = await api('/api/admin/leads').catch(() => null);
    if (!j || !j.ok) { $('mlLeadList').innerHTML = '<div class="empty">加载失败</div>'; return; }
    $('mlLeadList').innerHTML = j.leads.length ? j.leads.map(l => `<div class="lead" style="padding:14px 0;border-bottom:1px dashed var(--line)">
      <b>${esc(l.displayName)}</b> · ${esc(l.phone || '无电话')} · 咨询「${esc(l.packageName || '-')}」
      ${l.status === '待跟进' ? `<button class="btn-main" style="margin-left:8px;padding:4px 14px;font-size:12px" onclick="mlMarkLead('${l._id}')">标记已跟进</button>` : '<span class="tag t1" style="margin-left:8px">已跟进</span>'}
      <div style="color:var(--ink2);font-size:12.5px;margin-top:3px">${esc(l.note || '无备注')} · ${cnTime(l.createdAt)}</div></div>`).join('')
      : '<div class="empty">还没有用户咨询</div>';
  }
  window.mlMarkLead = async (id) => {
    const j = await api('/api/admin/leads/' + id, { method: 'PUT', body: JSON.stringify({ status: '已跟进' }) }).catch(() => null);
    if (j && j.ok) loadLeads();
  };

  loadPkgs();
  return { refresh: () => { loadPkgs(); } };
}
