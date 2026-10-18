# 视图通 · 多进程生成训练数据（调用 node ml/gen_dataset.mjs），最后合并成一个文件
#   python ml/gen.py --count 20000 --jobs 8
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument('--count', type=int, default=20000)
ap.add_argument('--jobs', type=int, default=max(1, (os.cpu_count() or 4) // 2))
ap.add_argument('--out', default='ml/data/shapes.jsonl')
ap.add_argument('--seed', type=int, default=1, help='换一个起始种子就能生成另一批数据（训练集、测试集用不同的种子）')
ap.add_argument('--kinds', default='', help='只生成这几类，逗号分隔：block,bracket,seat,cyl')
ap.add_argument('--exclude', nargs='*', default=[], help='去掉和这些文件里三视图完全相同的形体（生成测试集时填训练集）')
a = ap.parse_args()

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(root)
os.makedirs(os.path.dirname(a.out), exist_ok=True)
per = -(-a.count // a.jobs)
parts, procs = [], []
t0 = time.time()
for j in range(a.jobs):
    n = min(per, a.count - j * per)
    if n <= 0:
        break
    p = f'{a.out}.part{j}'
    parts.append(p)
    cmd = ['node', 'ml/gen_dataset.mjs', '--seed', str(a.seed * 100 + j), '--count', str(n), '--out', p] + (['--kinds', a.kinds] if a.kinds else [])
    procs.append(subprocess.Popen(cmd, stderr=subprocess.DEVNULL if j else None))
for pr in procs:
    pr.wait()
    if pr.returncode:
        sys.exit(f'有生成进程出错（返回 {pr.returncode}）')

# 三视图完全相同的形体只留一个；--exclude 的文件里出现过的也去掉，免得训练集和验证集、测试集里有同一道题
def key(row):
    return hashlib.sha1(json.dumps(row['views'], sort_keys=True).encode()).hexdigest()


seen = set()
for f in a.exclude:
    with open(f, encoding='utf-8') as fh:
        seen.update(key(json.loads(line)) for line in fh if line.strip())
n = dup = 0
with open(a.out, 'w', encoding='utf-8') as out:
    for p in parts:
        with open(p, encoding='utf-8') as fh:
            for line in fh:
                if not line.strip():
                    continue
                k = key(json.loads(line))
                if k in seen:
                    dup += 1
                    continue
                seen.add(k); out.write(line); n += 1
        os.remove(p)
print(f'完成：{n} 个样本 → {a.out}（去掉重复 {dup} 个，{os.path.getsize(a.out) / 1e6:.0f} MB，用时 {time.time() - t0:.0f} 秒）')
