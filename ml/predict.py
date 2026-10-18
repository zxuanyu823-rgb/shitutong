# 视图通 · 用训练好的模型看一张真实照片，输出上色的识别结果
#   python ml/predict.py --ckpt ml/runs/line-unet/best.pt 照片1.jpg 照片2.jpg
# 绿 = 实线，橙 = 虚线，蓝 = 点画线，紫 = 标注（尺寸、文字）
import argparse
import os
import sys

import cv2
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import LineUNet  # noqa: E402
from render import CLASSES, colorize  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('images', nargs='+')
    ap.add_argument('--ckpt', default='ml/runs/line-unet/best.pt')
    ap.add_argument('--size', type=int, default=1400, help='长边缩放到多少像素（App 里量线用的照片约 1400～2400）')
    ap.add_argument('--out', default='ml/predict')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    ck = torch.load(a.ckpt, map_location=device)
    model = LineUNet(width=ck.get('width', 16)).to(device).eval()
    model.load_state_dict(ck['model'])
    for path in a.images:
        img = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)   # 支持中文路径
        if img is None:
            print('读不出来：', path); continue
        k = a.size / max(img.shape[:2])
        if k < 1:
            img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        x = torch.from_numpy(np.ascontiguousarray(img[:, :, ::-1])).permute(2, 0, 1).float()[None].to(device) / 255
        with torch.no_grad():
            pred = model(x).argmax(1)[0].cpu().numpy().astype(np.uint8)
        name = os.path.splitext(os.path.basename(path))[0]
        cv2.imencode('.jpg', colorize(img, pred))[1].tofile(os.path.join(a.out, name + '_识别.jpg'))
        cv2.imencode('.png', pred)[1].tofile(os.path.join(a.out, name + '_类别.png'))
        frac = np.bincount(pred.ravel(), minlength=len(CLASSES)) / pred.size
        print(name, '  '.join(f'{c} {f * 100:.2f}%' for c, f in zip(CLASSES, frac)))


if __name__ == '__main__':
    main()
