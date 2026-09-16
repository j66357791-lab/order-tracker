from PIL import Image
import os

src = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\assets\cover_new.jpg'
dst = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\assets\cover_new_compressed.jpg'

img = Image.open(src)
print(f'原始尺寸: {img.size}')
print(f'原始大小: {round(os.path.getsize(src)/1024, 1)} KB')

# 缩小到70%，质量降到75%
new_w = int(img.size[0] * 0.7)
new_h = int(img.size[1] * 0.7)
img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
img.save(dst, quality=75, optimize=True)
print(f'压缩后尺寸: {img.size}')
print(f'压缩后大小: {round(os.path.getsize(dst)/1024, 1)} KB')
