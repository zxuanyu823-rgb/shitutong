# 视图通 · 识图小模型：轻量 U-Net，逐像素判断是实线、虚线、点画线、标注还是背景
# 线只有几个像素宽，所以输出保持原始分辨率（编码器下采样 4 次，解码器逐级放大并接上同尺寸的特征）
import torch
import torch.nn as nn
import torch.nn.functional as F

NUM_CLASSES = 5


class Block(nn.Module):
    def __init__(self, cin, cout):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
            nn.Conv2d(cout, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
        )

    def forward(self, x):
        return self.net(x)


class LineUNet(nn.Module):
    def __init__(self, width=16, num_classes=NUM_CLASSES):
        super().__init__()
        c = [width, width * 2, width * 4, width * 8, width * 16]
        self.enc = nn.ModuleList([Block(3, c[0])] + [Block(c[i], c[i + 1]) for i in range(4)])
        self.up = nn.ModuleList([nn.ConvTranspose2d(c[i + 1], c[i], 2, stride=2) for i in range(4)])
        self.dec = nn.ModuleList([Block(c[i] * 2, c[i]) for i in range(4)])
        self.head = nn.Conv2d(c[0], num_classes, 1)

    def forward(self, x):
        # 输入边长不是 16 的倍数时先补边，输出再裁回原尺寸
        h, w = x.shape[-2:]
        ph, pw = (16 - h % 16) % 16, (16 - w % 16) % 16
        if ph or pw:
            return self.core(F.pad(x, (0, pw, 0, ph), mode='replicate'))[..., :h, :w]
        return self.core(x)

    def core(self, x):
        # 边长必须是 16 的倍数（导出 ONNX 用这个，补边由调用方做）
        feats = []
        for i, blk in enumerate(self.enc):
            x = blk(x if i == 0 else F.max_pool2d(x, 2))
            feats.append(x)
        x = feats[-1]
        for i in range(3, -1, -1):
            x = self.dec[i](torch.cat([self.up[i](x), feats[i]], 1))
        return self.head(x)


def count_params(m):
    return sum(p.numel() for p in m.parameters())


if __name__ == '__main__':
    m = LineUNet()
    print(f'参数量 {count_params(m) / 1e6:.2f} M')
    print(m(torch.zeros(1, 3, 250, 333)).shape)
