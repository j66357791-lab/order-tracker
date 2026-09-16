p = r'C:\Users\某某\Desktop\接单后台\public\dispatch.html'
with open(p, 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i in range(len(lines)):
    if i == 856 and lines[i].strip() == '});':
        lines[i] = lines[i].replace('});', '};')
        print('修复第', i+1, '行')
        break

with open(p, 'w', encoding='utf-8') as f:
    f.writelines(lines)
print("完成")
