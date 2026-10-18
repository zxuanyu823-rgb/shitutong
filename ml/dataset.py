# 视图通 · 训练数据：每次取样都现场渲染一张新的“照片”（随机线宽、纸张、光照、透视……），等于数据无限多
import json
import random
import zlib

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset

from render import render

# 每个后台进程里 OpenCV 只用一个线程：它默认会把所有 CPU 核都占上，
# 十几个进程各开几十个线程互相抢，CPU 满载发烫，画图却不会更快
cv2.setNumThreads(1)


def load_rows(path):
    # 渲染只用得到尺寸和三视图图线，别的字段（建模步骤、部件清单……）不读进内存
    out = []
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            if line.strip():
                r = json.loads(line)
                out.append({'kind': r.get('kind', ''), 'dims': r['dims'], 'views': r['views']})
    return out


def pack(row):
    # 压成字节串：Windows 上每个后台进程都要复制一份数据集，存成 Python 对象两万个形体要占好几 GB，12 个进程内存就爆了
    return zlib.compress(json.dumps({'dims': row['dims'], 'views': row['views']}, separators=(',', ':')).encode(), 1)


class DrawingSeg(Dataset):
    """返回 (图像 3×crop×crop，0~1；标签 crop×crop，0~4)"""

    def __init__(self, rows, crop=512, epoch_seed=0, fixed=False, ink_bias=0.85):
        self.rows = [r if isinstance(r, bytes) else pack(r) for r in rows]
        self.crop, self.fixed, self.ink_bias = crop, fixed, ink_bias
        self.epoch_seed = epoch_seed

    def set_epoch(self, e):
        self.epoch_seed = e

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        # 验证集每次渲染都一样（fixed），训练集每轮都不一样
        seed = i * 7919 + (0 if self.fixed else self.epoch_seed * 1000003)
        img, mask = render(json.loads(zlib.decompress(self.rows[i])), seed=seed)
        rnd = random.Random(seed + 1)
        h, w = mask.shape
        c = self.crop
        if h < c or w < c:   # 图小于裁剪尺寸就补边
            ph, pw = max(0, c - h), max(0, c - w)
            img = np.pad(img, ((0, ph), (0, pw), (0, 0)), mode='edge')
            mask = np.pad(mask, ((0, ph), (0, pw)), constant_values=0)
            h, w = mask.shape
        # 大多数裁剪框以某个有墨迹的像素为中心，少数完全随机（也要学会“空白处什么都没有”）
        ys, xs = np.nonzero(mask)
        if len(ys) and rnd.random() < self.ink_bias:
            k = rnd.randrange(len(ys))
            y0 = min(max(0, ys[k] - rnd.randrange(c)), h - c)
            x0 = min(max(0, xs[k] - rnd.randrange(c)), w - c)
        else:
            y0, x0 = rnd.randrange(h - c + 1), rnd.randrange(w - c + 1)
        img = img[y0:y0 + c, x0:x0 + c, ::-1]          # BGR → RGB
        mask = mask[y0:y0 + c, x0:x0 + c]
        x = torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1).float() / 255.0
        y = torch.from_numpy(np.ascontiguousarray(mask)).long()
        return x, y
