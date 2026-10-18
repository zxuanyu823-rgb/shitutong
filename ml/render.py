# 视图通 · 把生成器给出的三视图画成“手机拍的题目照片”，同时画出逐像素标签
#   0 背景  1 可见轮廓（粗实线）  2 不可见轮廓（虚线）  3 中心线（点画线）  4 标注（尺寸线、箭头、数字、文字）
# 预览：python ml/render.py --data ml/data/shapes.jsonl --preview 8
import argparse, json, math, os, random
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

CLASSES = ['背景', '实线', '虚线', '点画线', '标注']
PALETTE = np.array([[0, 0, 0], [40, 180, 60], [230, 120, 20], [60, 110, 230], [200, 60, 200]], np.uint8)

FONT_CANDIDATES = [
    'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simsun.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/System/Library/Fonts/PingFang.ttc',
]
_font_path = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)


def font(size):
    try:
        return ImageFont.truetype(_font_path, size) if _font_path else ImageFont.load_default()
    except Exception:
        return ImageFont.load_default()


def chain(segs):
    """首尾相接的同类线段串成折线（圆弧由很多小段组成，虚线节奏要连贯）"""
    key = lambda p: (round(p[0], 2), round(p[1], 2))
    by = {}
    for i, (a, b) in enumerate(segs):
        for p in (a, b):
            by.setdefault(key(p), []).append(i)
    used, out = [False] * len(segs), []
    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        pts = [segs[i][0], segs[i][1]]
        for end in (1, 0):
            while True:
                tip = pts[-1] if end else pts[0]
                cand = [j for j in by.get(key(tip), []) if not used[j]]
                if len(cand) != 1 or len(by[key(tip)]) > 2:
                    break
                j = cand[0]; used[j] = True
                a, b = segs[j]
                nxt = b if key(a) == key(tip) else a
                if end: pts.append(nxt)
                else: pts.insert(0, nxt)
        out.append(pts)
    return out


def draw_pattern(img, mask, pts, color, cls, width, pattern):
    """沿折线画虚线 / 点画线；pattern 为 [画, 空, 画, 空...]（像素），按长度微调让两端都以“画”结束"""
    P = np.asarray(pts, np.float64)
    seg = np.hypot(*(P[1:] - P[:-1]).T)
    total = seg.sum()
    if total < 1:
        return
    per = sum(pattern)
    last = per - pattern[0]
    n = max(1, round((total + last) / per))
    k = total / (n * per - last) if n > 1 else 1.0
    pat = [x * k for x in pattern] if n > 1 else [total + 1, 0]
    cum = np.concatenate([[0], np.cumsum(seg)])

    def at(t):
        i = min(max(np.searchsorted(cum, t) - 1, 0), len(seg) - 1)
        f = 0 if seg[i] == 0 else (t - cum[i]) / seg[i]
        return P[i] + (P[i + 1] - P[i]) * f

    t, idx = 0.0, 0
    while t < total - 1e-6:
        L = pat[idx % len(pat)]
        if idx % 2 == 0 and L > 0:
            t1 = min(total, t + L)
            ts = [t] + [c for c in cum if t < c < t1] + [t1]
            q = np.array([at(x) for x in ts])
            pl = [np.round(q * 4).astype(np.int32)]
            cv2.polylines(img, pl, False, color, width, cv2.LINE_AA, shift=2)
            cv2.polylines(mask, pl, False, cls, max(1, width + 1), cv2.LINE_8, shift=2)
        t += L
        idx += 1


def layout(dims, s, gap, margin):
    L, W, H = dims['x'], dims['y'], dims['z']
    oxf, oyf = margin, margin + H * s
    oyt = oyf + gap + W * s
    oxl = margin + L * s + gap + W * s
    size = (int(margin * 2 + (L + W) * s + gap), int(margin * 2 + (H + W) * s + gap))
    tr = {
        'front': lambda u, v: (oxf + u * s, oyf - v * s),
        'top': lambda u, v: (oxf + u * s, oyt - v * s),
        'left': lambda u, v: (oxl + u * s, oyf - v * s),
    }
    boxes = {'front': (oxf, oyf - H * s, oxf + L * s, oyf), 'top': (oxf, oyt - W * s, oxf + L * s, oyt), 'left': (oxl - W * s, oyf - H * s, oxl, oyf)}
    return size, tr, boxes


def arrow(img, mask, p, q, color, w, head):
    cv2.line(img, tuple(map(int, p)), tuple(map(int, q)), color, w, cv2.LINE_AA)
    cv2.line(mask, tuple(map(int, p)), tuple(map(int, q)), 4, w + 1)
    for a, b in ((p, q), (q, p)):
        d = np.array(b, float) - np.array(a, float); L = np.hypot(*d) or 1; d /= L
        n = np.array([-d[1], d[0]])
        tip = np.array(a, float)
        tri = np.array([tip, tip + d * head + n * head * 0.3, tip + d * head - n * head * 0.3], np.int32)
        cv2.fillPoly(img, [tri], color, cv2.LINE_AA); cv2.fillPoly(mask, [tri], 4)


def text(img, mask, xy, s, size, color):
    """用 PIL 写字（支持中文），同时把字的像素记为“标注”"""
    pil = Image.new('L', (img.shape[1], img.shape[0]), 0)
    ImageDraw.Draw(pil).text(xy, s, fill=255, font=font(size))
    a = np.asarray(pil) > 100
    img[a] = color
    mask[a] = 4


def dimensions(img, mask, boxes, dims, s, rnd, color, w):
    """在视图外侧加几条尺寸标注：尺寸界线、带箭头的尺寸线、数字"""
    fsz = max(12, int(s * rnd.uniform(2.2, 3.4)))
    off = s * rnd.uniform(4, 7)
    for v, (x0, y0, x1, y1) in boxes.items():
        if rnd.random() < 0.35:
            continue
        L = {'front': dims['x'], 'top': dims['x'], 'left': dims['y']}[v]
        Hh = {'front': dims['z'], 'top': dims['y'], 'left': dims['z']}[v]
        if rnd.random() < 0.8:   # 下方水平尺寸
            yy = y1 + off
            for x in (x0, x1):
                cv2.line(img, (int(x), int(y1 + 3)), (int(x), int(yy + 4)), color, w, cv2.LINE_AA); cv2.line(mask, (int(x), int(y1 + 3)), (int(x), int(yy + 4)), 4, w + 1)
            arrow(img, mask, (x0, yy), (x1, yy), color, w, s * 1.6)
            text(img, mask, ((x0 + x1) / 2 - fsz, yy - fsz * 1.25), str(int(round(L))), fsz, color)
        if rnd.random() < 0.6:   # 右侧竖直尺寸
            xx = x1 + off
            for y in (y0, y1):
                cv2.line(img, (int(x1 + 3), int(y)), (int(xx + 4), int(y)), color, w, cv2.LINE_AA); cv2.line(mask, (int(x1 + 3), int(y)), (int(xx + 4), int(y)), 4, w + 1)
            arrow(img, mask, (xx, y0), (xx, y1), color, w, s * 1.6)
            text(img, mask, (xx + 4, (y0 + y1) / 2 - fsz / 2), str(int(round(Hh))), fsz, color)


def render(sample, seed=0, long_side=None, augment=True):
    """返回 (照片 BGR uint8, 标签 uint8)"""
    rnd = random.Random(seed)
    dims = sample['dims']
    long_side = long_side or rnd.randint(1000, 1700)
    L, W, H = dims['x'], dims['y'], dims['z']
    s = long_side * rnd.uniform(0.62, 0.85) / max(L + W, H + W) / 1.15
    gap = s * rnd.uniform(10, 18)
    margin = s * rnd.uniform(9, 16)
    (cw, ch), tr, boxes = layout(dims, s, gap, margin)
    paper = np.array([rnd.randint(205, 255)] * 3) - np.array([0, rnd.randint(0, 12), rnd.randint(0, 25)])
    img = np.empty((ch, cw, 3), np.uint8); img[:] = paper.clip(0, 255)
    mask = np.zeros((ch, cw), np.uint8)
    if augment and rnd.random() < 0.25:   # 方格纸
        step = int(s * rnd.uniform(4, 8)); gc = tuple(int(c) for c in (paper - rnd.randint(25, 60)).clip(0, 255))
        for x in range(0, cw, step): cv2.line(img, (x, 0), (x, ch), gc, 1)
        for y in range(0, ch, step): cv2.line(img, (0, y), (cw, y), gc, 1)
    ink = tuple(int(c) for c in rnd.choice([(20, 20, 20), (35, 30, 30), (60, 40, 30), (25, 25, 40)]))
    wv = max(2, int(round(s * rnd.uniform(0.55, 0.9))))
    wt = max(1, int(round(wv * rnd.uniform(0.4, 0.6))))
    dash = [s * rnd.uniform(2.4, 4.5), s * rnd.uniform(0.9, 1.6)]
    cen = [s * rnd.uniform(6, 12), s * rnd.uniform(0.9, 1.6), s * rnd.uniform(0.6, 1.2), s * rnd.uniform(0.9, 1.6)]
    for v in ('front', 'top', 'left'):
        f = tr[v]; vw = sample['views'][v]
        cl = [((f(a, b)), (f(c, d))) for a, b, c, d in vw['center']]
        for pts in chain(cl): draw_pattern(img, mask, pts, ink, 3, wt, cen)
        hid = [((f(a, b)), (f(c, d))) for a, b, c, d, vis in vw['lines'] if not vis]
        for pts in chain(hid): draw_pattern(img, mask, pts, ink, 2, wt, dash)
        for a, b, c, d, vis in vw['lines']:
            if not vis: continue
            p, q = f(a, b), f(c, d)
            P = (int(round(p[0] * 4)), int(round(p[1] * 4))); Q = (int(round(q[0] * 4)), int(round(q[1] * 4)))
            cv2.line(img, P, Q, ink, wv, cv2.LINE_AA, shift=2)
            cv2.line(mask, P, Q, 1, wv + 1, cv2.LINE_8, shift=2)
    if augment:
        if rnd.random() < 0.75: dimensions(img, mask, boxes, dims, s, rnd, ink, wt)
        if rnd.random() < 0.7:
            fsz = max(12, int(s * rnd.uniform(2.4, 3.6)))
            for v, name in (('front', '主视图'), ('top', '俯视图'), ('left', '左视图')):
                x0, y0, x1, y1 = boxes[v]
                # 视图名称写在视图正下方的空隙里（不压到下面的视图）
                if rnd.random() < 0.85: text(img, mask, ((x0 + x1) / 2 - fsz * 1.5, y1 + min(gap * 0.45, fsz * 1.6) - fsz * 0.2), name, fsz, ink)
        if rnd.random() < 0.5: text(img, mask, (margin * 0.6, margin * 0.25), rnd.choice(['读三视图，想象物体形状', '补画第三视图', '例题 3-12', '习题 5-7']), max(14, int(s * 3.2)), ink)
        img, mask = photo_effects(img, mask, rnd)
    return img, mask


def photo_effects(img, mask, rnd):
    h, w = mask.shape
    # 透视、旋转、缩放（标签用最近邻同步变换）
    j = rnd.uniform(0, 0.06)
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = src + np.float32([[rnd.uniform(-j, j) * w, rnd.uniform(-j, j) * h] for _ in range(4)])
    ang = math.radians(rnd.uniform(-4, 4)); c, s_ = math.cos(ang), math.sin(ang)
    ctr = np.float32([w / 2, h / 2]); dst = (dst - ctr) @ np.float32([[c, -s_], [s_, c]]).T + ctr
    Mp = cv2.getPerspectiveTransform(src, dst.astype(np.float32))
    bg = tuple(int(x) for x in img[2, 2])
    img = cv2.warpPerspective(img, Mp, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=bg)
    mask = cv2.warpPerspective(mask, Mp, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
    f = img.astype(np.float32)
    # 光照不均、阴影、偏色
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    gx, gy = rnd.uniform(-1, 1), rnd.uniform(-1, 1)
    light = 1 + rnd.uniform(0, 0.35) * ((xx / w - 0.5) * gx + (yy / h - 0.5) * gy)
    if rnd.random() < 0.4:
        cx, cy, r = rnd.uniform(0, w), rnd.uniform(0, h), rnd.uniform(0.3, 0.8) * max(w, h)
        light *= 1 - rnd.uniform(0.15, 0.4) * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r))
    f *= light[..., None]
    f *= np.array([rnd.uniform(0.9, 1.05), rnd.uniform(0.92, 1.05), rnd.uniform(0.9, 1.08)], np.float32)
    # 模糊、噪声、JPEG 压缩
    if rnd.random() < 0.8:
        k = rnd.choice([3, 3, 5]); f = cv2.GaussianBlur(f, (k, k), rnd.uniform(0.3, 1.4))
    f += np.random.default_rng(rnd.randint(0, 2**31)).normal(0, rnd.uniform(1, 9), f.shape).astype(np.float32)
    img = f.clip(0, 255).astype(np.uint8)
    ok, enc = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, rnd.randint(45, 95)])
    img = cv2.imdecode(enc, cv2.IMREAD_COLOR)
    return img, mask


def colorize(img, mask, alpha=0.6):
    over = img.copy()
    m = mask > 0
    over[m] = (img[m] * (1 - alpha) + PALETTE[mask[m]][:, ::-1] * alpha).astype(np.uint8)
    return over


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='预览渲染效果')
    ap.add_argument('--data', default='ml/data/shapes.jsonl')
    ap.add_argument('--preview', type=int, default=6)
    ap.add_argument('--out', default='ml/preview')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    with open(a.data, encoding='utf-8') as fh:
        rows = [json.loads(l) for _, l in zip(range(a.preview), fh)]
    for i, row in enumerate(rows):
        img, mask = render(row, seed=i)
        cv2.imwrite(f'{a.out}/{i:02d}_{row["kind"]}.jpg', img)
        cv2.imwrite(f'{a.out}/{i:02d}_{row["kind"]}_label.jpg', colorize(img, mask))
        print(f'{a.out}/{i:02d}_{row["kind"]}.jpg', img.shape, np.bincount(mask.ravel(), minlength=5))
