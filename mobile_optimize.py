"""批量优化四个HTML页面的移动端适配"""
import os
import re

base = r"C:\Users\某某\Desktop\接单后台\public"
files = ["login.html", "index.html", "dispatch.html", "writer.html"]

# 要注入的移动端优化CSS（追加到</style>前）
MOBILE_CSS = """
  /* ===== 移动端App体验优化 ===== */
  html,body{overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
  input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}
  body{position:fixed;inset:0;width:100%;height:100%;overflow:hidden}
  @supports(padding:max(0px)){
    .safe-top{padding-top:max(0px,env(safe-area-inset-top))}
    .safe-bottom{padding-bottom:max(0px,env(safe-area-inset-bottom))}
  }
"""

for fname in files:
    path = os.path.join(base, fname)
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    original = content

    # 1. 优化viewport：加 user-scalable=no 和 viewport-fit=cover
    old_vp = re.search(r'<meta name="viewport" content="([^"]*)">', content)
    if old_vp:
        vp_content = old_vp.group(1)
        new_vp = vp_content
        if "viewport-fit" not in new_vp:
            new_vp += ", viewport-fit=cover"
        if "user-scalable" not in new_vp:
            new_vp += ", user-scalable=no"
        if "maximum-scale" not in new_vp:
            new_vp += ", maximum-scale=1.0"
        content = content.replace(old_vp.group(0), f'<meta name="viewport" content="{new_vp}">')

    # 2. 注入移动端CSS（在第一个</style>前）
    if "overscroll-behavior" not in content:
        content = content.replace("</style>", MOBILE_CSS + "\n</style>", 1)

    # 3. 各页面特定优化
    if fname == "writer.html":
        # topbar 加 safe-area-top
        content = content.replace(
            ".topbar{background:linear-gradient(135deg,#1f2937,#111827);color:#fff;display:flex;align-items:center;gap:10px;padding:12px 16px;flex-shrink:0;box-shadow:0 1px 4px rgba(0,0,0,.15)}",
            ".topbar{background:linear-gradient(135deg,#1f2937,#111827);color:#fff;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;flex-shrink:0;box-shadow:0 1px 4px rgba(0,0,0,.15)}"
        )
        # tabbar 已经有 safe-area-bottom，确认一下
        if "safe-area-inset-bottom" not in content.split(".tabbar")[1].split("}")[0]:
            content = content.replace(".tabbar{", ".tabbar{padding-bottom:env(safe-area-inset-bottom);")

    if fname == "index.html":
        # index.html 是滚动页面，body 不能 fixed，改成允许内部滚动但禁止橡皮筋
        content = content.replace(
            "body{position:fixed;inset:0;width:100%;height:100%;overflow:hidden}",
            "body{position:fixed;inset:0;width:100%;height:100%;overflow-y:auto;-webkit-overflow-scrolling:touch}"
        )
        # header 加 safe-area-top
        if "safe-area-inset-top" not in content:
            content = content.replace(
                "header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px}",
                "header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;padding-top:env(safe-area-inset-top)}"
            )

    if fname == "login.html":
        # 登录页 body 是 flex 居中，需要允许滚动但禁止橡皮筋
        content = content.replace(
            "body{position:fixed;inset:0;width:100%;height:100%;overflow:hidden}",
            "body{position:fixed;inset:0;width:100%;height:100%;overflow-y:auto;-webkit-overflow-scrolling:touch}"
        )

    if content != original:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"{fname}: 已优化")
    else:
        print(f"{fname}: 无需修改")

print("完成")
