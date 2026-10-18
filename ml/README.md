# 视图通 · 训练自己的识图小模型

目标：用一个几百万参数的小模型代替大模型“看图”。它逐像素判断照片上的墨迹是**实线、虚线、点画线、标注（尺寸、文字）还是背景**，之后照常交给 App 里的算法量线（cv.js）去量坐标。
在手机上一秒内出结果，不联网、不花钱。

训练数据全部由程序生成：几何引擎从随机组合体精确算出三视图，再画成“手机拍的照片”，同时画出每个像素的标准答案。
**不需要人工标注，也不用任何大模型的回答当答案。**

## 文件

| 文件 | 作用 |
|---|---|
| `gen_dataset.mjs` | 随机组合体生成器（切割块、支架、轴承座、回转体四类），输出三视图图线、识图 JSON、部件清单 |
| `gen.py` | 多进程调用上面的生成器，合并成 `ml/data/shapes.jsonl` |
| `render.py` | 把三视图画成照片（国标线型、尺寸标注、视图名称、纸张、光照、透视、模糊、JPEG 压缩），同时画出像素标签 |
| `dataset.py` | 训练时每次取样都现场重新渲染，等于数据无限多 |
| `model.py` | 轻量 U-Net（宽度 16 时约 1.9M 参数） |
| `train.py` | 训练；每轮在验证集上算各类 IoU，线类平均最好的存成 `best.pt` |
| `predict.py` | 拿真实照片测试，输出上色的识别结果 |
| `export_onnx.py` | 导出 ONNX，之后放进 App |

## 在你的电脑上（Windows，RTX 5070 Ti Laptop）

在项目根目录打开 PowerShell：

```powershell
# 1. Python 3.11 或 3.12（64 位），建一个独立环境
python -m venv .venv
.venv\Scripts\activate

# 2. PyTorch：RTX 50 系显卡要 CUDA 12.8 或更新的版本（以 pytorch.org 首页的安装命令为准）
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install -r ml/requirements.txt
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
#    应该打印 True 和显卡名字；打印 False 先更新 NVIDIA 显卡驱动

# 3. 生成数据（项目根目录先 npm install 过；9955HX 上两万个大约几分钟）
#    训练集、验证集、测试集用不同的种子分开生成，后两个用 --exclude 去掉和前面完全相同的形体
python ml/gen.py --count 20000 --jobs 12 --seed 1 --out ml/data/shapes.jsonl
python ml/gen.py --count 500 --jobs 4 --seed 7 --out ml/data/val.jsonl --exclude ml/data/shapes.jsonl
python ml/gen.py --count 500 --jobs 4 --seed 9 --out ml/data/test.jsonl --exclude ml/data/shapes.jsonl ml/data/val.jsonl

# 4. 看看渲染出来的照片和标签对不对（结果在 ml/preview）
python ml/render.py --preview 8

# 5. 训练（插电源；中途可以 Ctrl+C，之后加 --resume ml/runs/line-unet/last.pt 接着练）
python ml/train.py --epochs 40 --bs 12 --workers 12 --val-data ml/data/val.jsonl

#    全部练完、参数都定了以后，才在测试集上评估一次
python ml/train.py --eval ml/runs/line-unet/best.pt --data ml/data/test.jsonl

# 6. 拿真实照片测试（结果在 ml/predict）
python ml/predict.py 你的照片.jpg

# 7. 导出给 App 用
python ml/export_onnx.py
```

训练时显卡不太累，瓶颈在 CPU 现场渲染照片，所以 `--workers` 尽量开大（16 核的 9955HX 开 12～14）。
看 `ml/runs/line-unet/log.jsonl` 里每轮的 `line_miou`（实线、虚线、点画线三类的平均重叠率），越接近 1 越好。

## 训练记录

| 日期 | 设置 | 验证集线类平均 IoU | 备注 |
|---|---|---|---|
| 2026-10-18 | `--width 24 --bs 12 --crop 640 --epochs 45`，两万个形体 | 0.940 | RTX 5070 Ti Laptop，每轮约 8.7 分钟；中途因 CPU 过热断电一次，`--resume` 接着练 |

## 防止数据泄露

- **训练集、验证集、测试集**：三份用不同的种子生成，生成时按三视图去重（`--exclude`），同一个形体不会同时出现在两份里。
- **验证集**用来挑模型、调参数（`best.pt` 就是按它选的）；**测试集**只在最后评估一次。看了测试集的结果再回去改参数，测试集就变成了第二个验证集，要换一批新的（换个种子重新生成）。
- **没见过的形体类型**：`--kinds seat` 只生成轴承座类。可以训练集不要某一类、测试集只要这一类，看模型能不能举一反三。
- **真实照片**：只放进测试集，不拿来训练；拿哪张照片调过程序，它就不再算测试题。

## 下一步

1. **真实照片测试集**：拍 30～50 张不同课本、不同光线的题目，用 `predict.py` 看效果。合成数据和真实照片总有差距，哪类错得多，就回到 `render.py` 加对应的干扰（比如手写字、透出背面的字、阴影）。
2. **接进 App**：用 onnxruntime-web 在 WebView 里跑模型，识别结果交给 cv.js 量线，大模型只在小模型拿不准时兜底。
3. **建模小模型**：数据里的 `text`（量好的图线文本）和 `parts`（部件清单）就是“图线 → 部件清单”的训练对，用来微调一个小语言模型；再用 App 的反算打分做强化学习。

## 注意

训练数据由程序生成。不要把 Claude 等大模型服务的回答收集起来当训练数据，这类用途可能违反服务条款。
