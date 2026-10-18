# 视图通 · 把训练好的模型导出成 ONNX（之后放进 App，用 onnxruntime-web 在手机上跑）
#   python ml/export_onnx.py --ckpt ml/runs/line-unet/best.pt --out ml/runs/line-unet/line-unet.onnx
import argparse
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import LineUNet  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', default='ml/runs/line-unet/best.pt')
    ap.add_argument('--out', default='ml/runs/line-unet/line-unet.onnx')
    a = ap.parse_args()
    ck = torch.load(a.ckpt, map_location='cpu')
    model = LineUNet(width=ck.get('width', 16)).eval()
    model.load_state_dict(ck['model'])

    class Core(torch.nn.Module):   # 导出时不带补边：输入的高、宽要先补成 16 的倍数
        def __init__(self, m):
            super().__init__(); self.m = m

        def forward(self, x):
            return self.m.core(x)
    core = Core(model).eval()
    x = torch.rand(1, 3, 512, 640)
    torch.onnx.export(core, x, a.out, input_names=['image'], output_names=['logits'], opset_version=17,
                      dynamic_axes={'image': {0: 'n', 2: 'h', 3: 'w'}, 'logits': {0: 'n', 2: 'h', 3: 'w'}}, dynamo=False)
    # 用 onnxruntime 跑一遍，和 PyTorch 的结果对一下
    import onnxruntime as ort
    sess = ort.InferenceSession(a.out, providers=['CPUExecutionProvider'])
    y = torch.rand(1, 3, 400, 704)
    ref = core(y).detach().numpy()
    got = sess.run(None, {'image': y.numpy()})[0]
    diff = float(np.abs(ref - got).max())
    same = float((ref.argmax(1) == got.argmax(1)).mean())
    print('注意：输入图像的高、宽要先补边到 16 的倍数（补边后输出再裁回原尺寸）')
    print(f'已导出 {a.out}（{os.path.getsize(a.out) / 1e6:.1f} MB），与 PyTorch 输出最大差 {diff:.2e}，分类一致 {same * 100:.2f}%')


if __name__ == '__main__':
    main()
