# 视图通 · 训练识图小模型
#   python ml/train.py --data ml/data/shapes.jsonl --epochs 40
# 每轮结束在验证集上算各类的 IoU（重叠率），线类平均 IoU 最高的权重存为 best.pt
import argparse
import json
import math
import os
import sys
import time

import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dataset import DrawingSeg, load_rows  # noqa: E402
from model import LineUNet, NUM_CLASSES, count_params  # noqa: E402
from render import CLASSES  # noqa: E402

# 背景占了绝大多数像素，给小权重；虚线、点画线断断续续、像素少，给大权重
CLASS_WEIGHTS = [0.3, 1.0, 2.0, 2.0, 1.0]


def dice_loss(logits, y, eps=1.0):
    p = logits.float().softmax(1)
    oh = F.one_hot(y, NUM_CLASSES).permute(0, 3, 1, 2).float()
    inter = (p * oh).sum((0, 2, 3)); den = p.sum((0, 2, 3)) + oh.sum((0, 2, 3))
    return 1 - ((2 * inter + eps) / (den + eps))[1:].mean()


@torch.no_grad()
def evaluate(model, loader, device, amp_dtype):
    model.eval()
    inter = torch.zeros(NUM_CLASSES, device=device); union = torch.zeros(NUM_CLASSES, device=device)
    for x, y in loader:
        x, y = x.to(device, non_blocking=True), y.to(device, non_blocking=True)
        with torch.autocast(device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
            pred = model(x).argmax(1)
        for k in range(NUM_CLASSES):
            a, b = pred == k, y == k
            inter[k] += (a & b).sum(); union[k] += (a | b).sum()
    model.train()
    return (inter / union.clamp(min=1)).tolist()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', nargs='+', default=['ml/data/shapes.jsonl'], help='训练数据，可以给多个文件')
    ap.add_argument('--val', type=int, default=300, help='最后多少个样本留作验证集（没给 --val-data 时）')
    ap.add_argument('--val-data', default='', help='单独的验证集文件（用另一个种子生成）')
    ap.add_argument('--eval', default='', help='只评估：给一个模型文件（如 best.pt），在 --data 上算各类 IoU，不训练')
    ap.add_argument('--epochs', type=int, default=40)
    ap.add_argument('--bs', type=int, default=12)
    ap.add_argument('--crop', type=int, default=512)
    ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--width', type=int, default=16, help='网络宽度（16 约 1.9M 参数，24 约 4.3M）')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 4) - 2))
    ap.add_argument('--steps', type=int, default=0, help='每轮最多训练多少步（0 = 跑完整个训练集）')
    ap.add_argument('--out', default='ml/runs/line-unet')
    ap.add_argument('--resume', default='', help='接着练中断的那次（参数必须和当时一样）')
    ap.add_argument('--init', default='', help='从练好的模型（如 best.pt）出发重新练一轮：只拿它的参数，学习率从头安排')
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    amp_dtype = torch.bfloat16 if device.type == 'cuda' and torch.cuda.is_bf16_supported() else None
    torch.backends.cudnn.benchmark = True
    print(f'设备：{torch.cuda.get_device_name(0) if device.type == "cuda" else "CPU（会很慢，只适合检查流程）"}')

    rows = [r for f in a.data for r in load_rows(f)]
    if a.eval:   # 测试集只在最后评估一次，不要拿它挑参数
        ck = torch.load(a.eval, map_location=device)
        model = LineUNet(width=ck.get('width', 16)).to(device).to(memory_format=torch.channels_last)
        model.load_state_dict(ck['model'])
        dl = DataLoader(DrawingSeg(rows, crop=a.crop, fixed=True), batch_size=a.bs, num_workers=a.workers)
        ious = evaluate(model, dl, device, amp_dtype)
        print(json.dumps({'data': ' '.join(a.data), 'n': len(rows), 'iou': dict(zip(CLASSES, [round(v, 4) for v in ious])), 'line_miou': round(sum(ious[1:4]) / 3, 4)}, ensure_ascii=False))
        return
    if a.val_data:
        va_rows = load_rows(a.val_data)
        vk = {json.dumps(r['views'], sort_keys=True) for r in va_rows}
        tr_rows = [r for r in rows if json.dumps(r['views'], sort_keys=True) not in vk]
        if len(tr_rows) < len(rows):
            print(f'训练集里有 {len(rows) - len(tr_rows)} 个形体和验证集重复，已去掉')
    else:
        tr_rows, va_rows = rows[:-a.val], rows[-a.val:]
    print(f'训练 {len(tr_rows)} 个形体（每轮现场重新渲染），验证 {len(va_rows)} 个')
    train_ds = DrawingSeg(tr_rows, crop=a.crop)
    val_ds = DrawingSeg(va_rows, crop=a.crop, fixed=True)
    val_dl = DataLoader(val_ds, batch_size=a.bs, num_workers=a.workers, pin_memory=device.type == 'cuda')

    model = LineUNet(width=a.width).to(device).to(memory_format=torch.channels_last)
    print(f'模型参数 {count_params(model) / 1e6:.2f} M')
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    steps_per_epoch = a.steps or math.ceil(len(train_ds) / a.bs)
    total = steps_per_epoch * a.epochs
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=total, pct_start=0.1)
    weights = torch.tensor(CLASS_WEIGHTS, device=device)
    start, best = 0, -1.0
    if a.init and not a.resume:
        model.load_state_dict(torch.load(a.init, map_location=device)['model'])
        print(f'从 {a.init} 的参数出发')
    if a.resume:
        ck = torch.load(a.resume, map_location=device)
        model.load_state_dict(ck['model']); opt.load_state_dict(ck['opt']); sched.load_state_dict(ck['sched'])
        start, best = ck['epoch'] + 1, ck.get('best', -1.0)
        print(f'从第 {start} 轮继续')

    log = open(os.path.join(a.out, 'log.jsonl'), 'a', encoding='utf-8')
    for epoch in range(start, a.epochs):
        train_ds.set_epoch(epoch)
        # 不用常驻的数据进程：每轮重新创建，才能拿到新的 epoch（新的随机渲染）
        dl = DataLoader(train_ds, batch_size=a.bs, shuffle=True, num_workers=a.workers, pin_memory=device.type == 'cuda', drop_last=True)
        t0, seen, run_loss = time.time(), 0, 0.0
        for step, (x, y) in enumerate(dl):
            if step >= steps_per_epoch:
                break
            x = x.to(device, non_blocking=True).to(memory_format=torch.channels_last); y = y.to(device, non_blocking=True)
            with torch.autocast(device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
                logits = model(x)
                loss = F.cross_entropy(logits.float(), y, weight=weights) + dice_loss(logits, y)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step()
            run_loss += loss.item(); seen += 1
            if step % 50 == 0:
                print(f'  第 {epoch + 1} 轮 {step}/{steps_per_epoch}  loss {run_loss / seen:.4f}  {(time.time() - t0) / seen:.2f} 秒/步', flush=True)
        ious = evaluate(model, val_dl, device, amp_dtype)
        line_miou = sum(ious[1:4]) / 3
        rec = {'epoch': epoch + 1, 'loss': run_loss / max(1, seen), 'iou': dict(zip(CLASSES, [round(v, 4) for v in ious])), 'line_miou': round(line_miou, 4), 'sec': round(time.time() - t0)}
        print(json.dumps(rec, ensure_ascii=False), flush=True)
        log.write(json.dumps(rec, ensure_ascii=False) + '\n'); log.flush()
        ck = {'model': model.state_dict(), 'opt': opt.state_dict(), 'sched': sched.state_dict(), 'epoch': epoch, 'best': max(best, line_miou), 'width': a.width}
        torch.save(ck, os.path.join(a.out, 'last.pt'))
        if line_miou > best:
            best = line_miou
            torch.save({'model': model.state_dict(), 'width': a.width, 'epoch': epoch + 1, 'iou': ious}, os.path.join(a.out, 'best.pt'))
            print(f'  ↑ 新的最好结果，线类平均 IoU {best:.4f}，已存 best.pt')


if __name__ == '__main__':
    main()
