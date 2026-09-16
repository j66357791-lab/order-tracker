wp = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\index.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 把加载进度条放到封面页上，删除单独的加载页
old = '''  <!-- ② 加载 -->
  <div class="screen" id="scrLoad">
    <div class="home-bg dim"></div>
    <div class="load-body">
      <div class="load-ring">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="52" class="ring-bg"/>
          <circle cx="60" cy="60" r="52" class="ring-fg" id="ringFg"/>
        </svg>
        <div class="load-pct" id="loadPct">0%</div>
      </div>
      <div class="load-tip" id="loadTip">山河入梦…</div>
      <div class="load-name" id="loadName"></div>
    </div>
  </div>'''

new = '''  <!-- 加载进度条已移到封面页上 -->'''

if old in w:
    w = w.replace(old, new)
    print("加载页已删除")
else:
    print("未找到加载页代码")

# 在封面页的tapEnter前面加加载进度条
old2 = '''    <div class="cover-foot">
      <div class="tap-hint" id="tapEnter">— 轻触进入 —</div>'''

new2 = '''    <!-- 加载进度条（叠加在封面上） -->
    <div id="loadBar" style="position:absolute;bottom:120px;left:50%;transform:translateX(-50%);width:70%;text-align:center">
      <div style="font-size:13px;color:#ffd76a;margin-bottom:8px;letter-spacing:2px" id="loadTip">山河入梦…</div>
      <div style="height:4px;background:rgba(255,255,255,.2);border-radius:99px;overflow:hidden">
        <div id="loadFill" style="height:100%;width:0%;background:linear-gradient(90deg,#ffd76a,#ff9a3c);transition:width .3s;border-radius:99px"></div>
      </div>
      <div style="font-size:12px;color:rgba(255,255,255,.7);margin-top:6px" id="loadPct">0%</div>
    </div>
    <div class="cover-foot">
      <div class="tap-hint" id="tapEnter" style="display:none">— 轻触进入 —</div>'''

if old2 in w:
    w = w.replace(old2, new2)
    print("加载进度条已加到封面")
else:
    print("未找到封面foot代码")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
