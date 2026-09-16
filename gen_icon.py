"""生成 PWA 图标：绿色渐变背景 + 白色信封，512x512 和 192x192"""
from PIL import Image, ImageDraw
import math

def make_icon(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 绿色渐变背景（#6ee7b7 -> #07c160，135度）
    c1 = (110, 231, 183, 255)  # #6ee7b7
    c2 = (7, 193, 96, 255)     # #07c160
    for y in range(size):
        for x in range(size):
            # 135度渐变：左上到右下
            t = (x + y) / (2 * size)
            r = int(c1[0] + (c2[0] - c1[0]) * t)
            g = int(c1[1] + (c2[1] - c1[1]) * t)
            b = int(c1[2] + (c2[2] - c1[2]) * t)
            draw.point((x, y), fill=(r, g, b, 255))

    # 白色信封（居中，占约 50% 宽度）
    ew = int(size * 0.52)
    eh = int(ew * 0.72)
    ex = (size - ew) // 2
    ey = (size - eh) // 2
    white = (255, 255, 255, 255)

    # 信封主体（矩形）
    draw.rectangle([ex, ey, ex + ew, ey + eh], fill=white)
    # 信封封口（三角形，从顶部两角到中心偏下）
    flap = [
        (ex, ey),
        (ex + ew, ey),
        (ex + ew // 2, ey + int(eh * 0.55)),
    ]
    # 用稍深一点的白色/浅灰区分封口
    flap_color = (230, 245, 235, 255)
    draw.polygon(flap, fill=flap_color)
    # 封口边线
    draw.line([(ex, ey), (ex + ew // 2, ey + int(eh * 0.55))], fill=(200, 225, 210), width=max(1, size//128))
    draw.line([(ex + ew, ey), (ex + ew // 2, ey + int(eh * 0.55))], fill=(200, 225, 210), width=max(1, size//128))

    img.save(path, "PNG")
    print(f"已生成 {path} ({size}x{size})")

base = r"C:\Users\某某\Desktop\接单后台\public"
make_icon(512, base + r"\icon-512.png")
make_icon(192, base + r"\icon-192.png")
print("完成")
