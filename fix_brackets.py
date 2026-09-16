wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 删除多余的括号
w = w.replace("""  if (t.dataset.at === 'atGame') loadGameEntry();
});
  }
});


async function loadGameEntry() {""", """  if (t.dataset.at === 'atGame') loadGameEntry();
});

async function loadGameEntry() {""")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("已删除多余括号")
