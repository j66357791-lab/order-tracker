"""批量给 4 个 HTML 页面注入 PWA 标签"""
import os

base = r"C:\Users\某某\Desktop\接单后台\public"
files = ["login.html", "index.html", "dispatch.html", "writer.html"]

head_inject = '''  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#07c160">
  <link rel="icon" type="image/png" href="/icon-192.png">
  <link rel="apple-touch-icon" href="/icon-192.png">
'''

body_inject = '''  <script>
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/service-worker.js").catch(function () {});
    });
  }
  </script>
'''

for fname in files:
    path = os.path.join(base, fname)
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    # 检查是否已经注入过
    if 'rel="manifest"' in content:
        print(f"{fname}: 已注入，跳过")
        continue

    # 在 </head> 前注入
    if "</head>" in content:
        content = content.replace("</head>", head_inject + "</head>", 1)
    else:
        print(f"{fname}: 未找到 </head>，跳过")
        continue

    # 在 </body> 前注入
    if "</body>" in content:
        content = content.replace("</body>", body_inject + "</body>", 1)
    else:
        print(f"{fname}: 未找到 </body>，跳过")
        continue

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"{fname}: 注入完成")

print("全部完成")
