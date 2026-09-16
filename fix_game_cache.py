wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 1. 在URL参数处理后面加预缓存弹窗逻辑
old = """// URL参数：?tab=game 直接切游戏tab
(function(){
  const p = new URLSearchParams(location.search);
  if(p.get('tab')==='game'){
    window.addEventListener('load', () => {
      setTimeout(() => {
        const t = document.querySelector('.act-tab[data-at="atGame"]');
        if(t) t.click();
      }, 1000);
    });
  }
})();"""

new = """// URL参数：?tab=game 直接切游戏tab
(function(){
  const p = new URLSearchParams(location.search);
  if(p.get('tab')==='game'){
    window.addEventListener('load', () => {
      setTimeout(() => {
        const t = document.querySelector('.act-tab[data-at="atGame"]');
        if(t) t.click();
      }, 1000);
    });
  }
})();

// ===== 游戏资源预缓存弹窗 =====
const GAME_CACHE_KEY = 'game_cache_version';
const GAME_CACHE_VER = 'v1.5-20260913'; // 更新版本号就会触发重新下载

function showGameCacheModal() {
  const modal = document.createElement('div');
  modal.id = 'gameCacheModal';
  modal.style = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:linear-gradient(180deg,#1a3a2e,#0e1f1a);border:1px solid #3ec9a0;border-radius:16px;padding:24px;max-width:340px;width:100%;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">🎮</div>
      <h3 style="color:#ffd76a;font-size:18px;margin-bottom:12px">游戏资源预下载</h3>
      <p style="color:#8AF0CE;font-size:13px;line-height:1.6;margin-bottom:20px">
        为了游戏体验流畅，建议提前下载游戏美术资源。<br>
        下载约 20MB，下载完成后下次打开游戏秒进，不消耗流量。
      </p>
      <div style="margin-bottom:16px">
        <div style="height:6px;background:rgba(255,255,255,.1);border-radius:99px;overflow:hidden">
          <div id="gameCacheProgress" style="height:100%;width:0%;background:linear-gradient(90deg,#3ec9a0,#ffd76a);transition:width .3s;border-radius:99px"></div>
        </div>
        <div id="gameCacheTip" style="font-size:12px;color:rgba(255,255,255,.6);margin-top:8px">准备下载…</div>
      </div>
      <button id="gameCacheConfirm" style="background:linear-gradient(135deg,#3ec9a0,#2ca88a);color:#0e2420;border:none;border-radius:10px;padding:12px 32px;font-size:15px;font-weight:700;cursor:pointer;margin-right:8px">立即下载</button>
      <button id="gameCacheLater" style="background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:10px;padding:12px 24px;font-size:14px;cursor:pointer">稍后再说</button>
    </div>
  `;
  document.body.appendChild(modal);

  const gameAssets = [
    '/games/shanhai/assets/cover_new.jpg',
    '/games/shanhai/assets/sprites/hero.png',
    '/games/shanhai/assets/sprites/zheng.png',
    '/games/shanhai/assets/sprites/bifang.png',
    '/games/shanhai/assets/sprites/manifest.js',
    '/games/shanhai/bg/home_bg.png',
  ];

  let downloaded = 0;
  let paused = false;

  async function downloadNext() {
    if (paused) return;
    if (downloaded >= gameAssets.length) {
      // 下载完成
      localStorage.setItem(GAME_CACHE_KEY, GAME_CACHE_VER);
      document.getElementById('gameCacheTip').textContent = '下载完成！下次游戏秒进 🎉';
      document.getElementById('gameCacheProgress').style.width = '100%';
      setTimeout(() => modal.remove(), 1500);
      return;
    }
    try {
      document.getElementById('gameCacheTip').textContent = `下载中… ${downloaded + 1}/${gameAssets.length}`;
      await fetch(gameAssets[downloaded], { mode: 'no-cors' });
      downloaded++;
      document.getElementById('gameCacheProgress').style.width = Math.round(downloaded / gameAssets.length * 100) + '%';
      setTimeout(downloadNext, 100);
    } catch(e) {
      // 单个失败继续下一个
      downloaded++;
      downloadNext();
    }
  }

  document.getElementById('gameCacheConfirm').onclick = () => {
    paused = false;
    document.getElementById('gameCacheConfirm').style.display = 'none';
    document.getElementById('gameCacheLater').textContent = '后台下载中…';
    downloadNext();
  };

  document.getElementById('gameCacheLater').onclick = () => {
    modal.remove();
  };
}

// 检查是否需要预缓存
(function checkGameCache() {
  window.addEventListener('load', () => {
    setTimeout(() => {
      const cached = localStorage.getItem(GAME_CACHE_KEY);
      if (cached !== GAME_CACHE_VER) {
        // 版本不一致，弹窗提醒
        showGameCacheModal();
      }
    }, 2000);
  });
})();"""

if old in w:
    w = w.replace(old, new)
    print("预缓存弹窗已加")
else:
    print("未找到URL参数代码")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
