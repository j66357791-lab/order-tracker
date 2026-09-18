// admin/mod-ads.js — 广告管理面板（iframe → 原生面板迁移 · 第 1 批，来源 ads.html）
// 内容：写手端「活动中心」公告的标题 + HTML 正文，带实时预览
// 迁移要点：不再依赖 ?embed=1、不再自己判断 / 跳转，登录守卫与 401 由 app.js 的 api() 统一处理
import { api, esc, toast } from './app.js';

export function mount(root) {
  root.innerHTML = `
  <div class="content-head">
    <div>
      <h1 class="serif">广告管理</h1>
      <div class="sub">广告显示在写手端「活动中心」，正文支持 HTML 标签</div>
    </div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="adsReload">重新载入</button>
  </div>

  <div class="card">
    <h2 class="serif">编辑广告内容</h2>
    <div class="sub">保存后写手端「活动中心」立即生效；留空表示不展示广告</div>
    <div class="f-row"><label>广告标题</label><input id="adsTitle" placeholder="广告标题"></div>
    <div class="f-row"><label>广告内容（支持 HTML）</label><textarea id="adsContent" rows="12" placeholder="广告内容（支持 HTML，例如 &lt;b&gt;加粗&lt;/b&gt; &lt;a href=&quot;...&quot;&gt;链接&lt;/a&gt;）"></textarea></div>
    <div class="err" id="adsErr"></div>
    <button class="btn-main" id="adsSave">保存广告</button>
  </div>

  <div class="card">
    <h2 class="serif">预览</h2>
    <div class="sub">下面就是写手端看到的效果（正文按 HTML 渲染）</div>
    <div id="adsPreview" style="border:1px solid var(--line);border-radius:12px;padding:14px;min-height:110px;background:var(--paper)"></div>
  </div>`;

  const $ = id => root.querySelector('#' + id);

  function renderPreview() {
    const title = $('adsTitle').value.trim();
    const body = $('adsContent').value;
    $('adsPreview').innerHTML =
      (title ? '<h4 style="font-size:16px;margin-bottom:8px">' + esc(title) + '</h4>' : '') +
      (body || '<span style="color:var(--ink2);font-size:13px">（暂无内容）</span>');
  }
  $('adsTitle').oninput = renderPreview;
  $('adsContent').oninput = renderPreview;

  async function load() {
    $('adsErr').textContent = '';
    try {
      const j = await api('/api/ads');
      const ad = (j && j.ad) || {};
      $('adsTitle').value = ad.title || '';
      $('adsContent').value = ad.content || '';
      renderPreview();
    } catch (e) {
      $('adsErr').textContent = '载入失败：' + (e && e.message ? e.message : '网络异常');
    }
  }
  $('adsReload').onclick = load;

  $('adsSave').onclick = async () => {
    $('adsErr').textContent = '';
    $('adsSave').disabled = true;
    const old = $('adsSave').textContent;
    $('adsSave').textContent = '保存中…';
    try {
      await api('/api/ads', {
        method: 'POST',
        body: JSON.stringify({ title: $('adsTitle').value, content: $('adsContent').value }),
      });
      toast('广告已保存 ✅');
    } catch (e) {
      $('adsErr').textContent = '保存失败：' + (e && e.message ? e.message : '网络异常');
    }
    $('adsSave').disabled = false;
    $('adsSave').textContent = old;
  };

  load();
  return { refresh: load };
}
