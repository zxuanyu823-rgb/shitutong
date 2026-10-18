# 拍照建模·重建算法离线评测

方法：用题库 13 个模型生成“模拟识图结果”，对每个坐标加入随机读数误差（噪声，按模型尺寸的比例）和各视图独立的比例误差，每种设置随机 3 次；重建后与原模型的三视图逐线比对，吻合度 >97% 记为成功。这是程序对程序的测试，只反映重建算法本身，不代表真实照片的识别准确率。

| 测试条件 | 成功 | 成功率 |
|---|---|---|
| 三视图齐全，无误差 | 36/39 | 92% |
| 三视图齐全，噪声 0.5% + 比例误差 2% | 34/39 | 87% |
| 三视图齐全，噪声 1% + 比例误差 3% | 28/39 | 72% |
| 只给主、俯视图（补画左视图），无误差 | 30/39 | 77% |
| 只给主、俯视图，噪声 0.5% + 比例误差 2% | 27/39 | 69% |

说明：
- 失败最多的是轴承座（支撑板与圆筒相切、肋板与圆筒相交），程序候选覆盖不到，需要大模型修正环节。
- 只给两个视图时，答案往往不唯一。这里只把“与原题第三视图一致”记为成功；其余情况中有一部分是同样符合两个视图的另一种形体（例如带肋支架的肋板斜面在主、俯视图中看不出来），不是错误。

## 三视图齐全
### 噪声 0 比例误差 0
L-block           seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 99ms
L-block           seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 29ms
L-block           seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 39ms
slope-block       seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 47ms
slope-block       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 13ms
slope-block       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 32ms
slot-block        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 36ms
slot-block        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 28ms
slot-block        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 16ms
back-notch        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 446ms
back-notch        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 423ms
back-notch        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 377ms
hole-plate        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 45ms
hole-plate        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 36ms
hole-plate        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 37ms
counterbore       seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 76ms
counterbore       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 97ms
counterbore       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 98ms
dovetail          seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 12ms
dovetail          seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 12ms
dovetail          seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 9ms
v-block           seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 11ms
v-block           seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 11ms
v-block           seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 17ms
corner-cut        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 166ms
corner-cut        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 182ms
corner-cut        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 199ms
rib-bracket       seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 2 处] 2530ms
rib-bracket       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 2 处] 2301ms
rib-bracket       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 2 处] 2562ms
round-bracket     seed1 输入吻合  98.4%  真值吻合  98.4%  ✓  [外形 + 圆孔] 179ms
round-bracket     seed2 输入吻合  98.4%  真值吻合  98.4%  ✓  [外形 + 圆孔] 159ms
round-bracket     seed3 输入吻合  98.4%  真值吻合  98.4%  ✓  [外形 + 圆孔] 182ms
bearing-seat      seed1 输入吻合  73.5%  真值吻合  73.5%  ✗  [挖切 3 处] 11379ms
bearing-seat      seed2 输入吻合  73.5%  真值吻合  73.5%  ✗  [挖切 3 处] 11842ms
bearing-seat      seed3 输入吻合  73.5%  真值吻合  73.5%  ✗  [挖切 3 处] 12645ms
slotted-cylinder  seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 114ms
slotted-cylinder  seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 89ms
slotted-cylinder  seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 77ms

噪声 0 比例误差 0 缺视图 无：成功 36/39
### 噪声 0.005 比例误差 0.02
L-block           seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 49ms
L-block           seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 16ms
L-block           seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 24ms
slope-block       seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 27ms
slope-block       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 22ms
slope-block       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 23ms
slot-block        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 39ms
slot-block        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 13ms
slot-block        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 21ms
back-notch        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 469ms
back-notch        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 402ms
back-notch        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 393ms
hole-plate        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 63ms
hole-plate        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 54ms
hole-plate        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 52ms
counterbore       seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 91ms
counterbore       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 97ms
counterbore       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 83ms
dovetail          seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 12ms
dovetail          seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 11ms
dovetail          seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 15ms
v-block           seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 13ms
v-block           seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 13ms
v-block           seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 8ms
corner-cut        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 378ms
corner-cut        seed2 输入吻合  98.9%  真值吻合 100.0%  ✓  [斜面切割 1 处] 213ms
corner-cut        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 231ms
rib-bracket       seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 2 处] 2405ms
rib-bracket       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 2 处] 2240ms
rib-bracket       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 2 处] 2362ms
round-bracket     seed1 输入吻合  97.7%  真值吻合  97.7%  ✓  [外形 + 圆孔] 165ms
round-bracket     seed2 输入吻合  98.5%  真值吻合  98.4%  ✓  [外形 + 圆孔] 149ms
round-bracket     seed3 输入吻合  98.4%  真值吻合  98.5%  ✓  [外形 + 圆孔] 125ms
bearing-seat      seed1 输入吻合  73.8%  真值吻合  73.5%  ✗  [挖切 3 处] 11641ms
bearing-seat      seed2 输入吻合  72.6%  真值吻合  68.6%  ✗  [挖切 3 处] 11429ms
bearing-seat      seed3 输入吻合  82.0%  真值吻合  81.0%  ✗  [挖切 3 处] 19542ms
slotted-cylinder  seed1 输入吻合  84.2%  真值吻合  84.4%  ✗  [外形拉伸] 3529ms
slotted-cylinder  seed2 输入吻合  83.6%  真值吻合  84.2%  ✗  [外形拉伸] 282ms
slotted-cylinder  seed3 输入吻合  96.5%  真值吻合  97.6%  ✓  [外形拉伸] 235ms

噪声 0.005 比例误差 0.02 缺视图 无：成功 34/39
### 噪声 0.01 比例误差 0.03
L-block           seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 57ms
L-block           seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 25ms
L-block           seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 21ms
slope-block       seed1 输入吻合  95.0%  真值吻合  86.7%  ✗  [外形拉伸] 36ms
slope-block       seed2 输入吻合  89.5%  真值吻合  89.6%  ✗  [外形拉伸] 42ms
slope-block       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 21ms
slot-block        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 38ms
slot-block        seed2 输入吻合  90.8%  真值吻合  86.9%  ✗  [外形拉伸] 21ms
slot-block        seed3 输入吻合  97.1%  真值吻合 100.0%  ✓  [外形拉伸] 132ms
back-notch        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 436ms
back-notch        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 476ms
back-notch        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 378ms
hole-plate        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 45ms
hole-plate        seed2 输入吻合  99.5%  真值吻合 100.0%  ✓  [外形 + 圆孔] 37ms
hole-plate        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 42ms
counterbore       seed1 输入吻合  97.3%  真值吻合  94.7%  ✗  [外形 + 圆孔] 72ms
counterbore       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 147ms
counterbore       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 105ms
dovetail          seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 22ms
dovetail          seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 15ms
dovetail          seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 20ms
v-block           seed1 输入吻合  98.6%  真值吻合 100.0%  ✓  [外形拉伸] 23ms
v-block           seed2 输入吻合  88.0%  真值吻合 100.0%  ✓  [外形拉伸] 103ms
v-block           seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 17ms
corner-cut        seed1 输入吻合  98.9%  真值吻合 100.0%  ✓  [斜面切割 1 处] 202ms
corner-cut        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 125ms
corner-cut        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 395ms
rib-bracket       seed1 输入吻合  81.6%  真值吻合  84.1%  ✗  [挖切 3 处] 6008ms
rib-bracket       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 2 处] 2417ms
rib-bracket       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 2 处] 2521ms
round-bracket     seed1 输入吻合  57.2%  真值吻合  53.2%  ✗  [外形 + 圆孔] 8111ms
round-bracket     seed2 输入吻合  97.4%  真值吻合  97.4%  ✓  [外形 + 圆孔] 1524ms
round-bracket     seed3 输入吻合  96.3%  真值吻合  95.7%  ✗  [外形 + 圆孔] 920ms
bearing-seat      seed1 输入吻合  79.5%  真值吻合  78.2%  ✗  [挖切 2 处] 19557ms
bearing-seat      seed2 输入吻合  68.4%  真值吻合  67.4%  ✗  [挖切 3 处] 13089ms
bearing-seat      seed3 输入吻合  71.7%  真值吻合  70.1%  ✗  [挖切 3 处] 9573ms
slotted-cylinder  seed1 输入吻合  84.2%  真值吻合 100.0%  ✓  [外形拉伸] 420ms
slotted-cylinder  seed2 输入吻合  85.2%  真值吻合  85.3%  ✗  [外形拉伸] 281ms
slotted-cylinder  seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 77ms

噪声 0.01 比例误差 0.03 缺视图 无：成功 28/39
## 只给主视图和俯视图（补画左视图）
### 噪声 0 比例误差 0
L-block           seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 67ms
L-block           seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 20ms
L-block           seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 27ms
slope-block       seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 15ms
slope-block       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 14ms
slope-block       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 17ms
slot-block        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 28ms
slot-block        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 38ms
slot-block        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 14ms
back-notch        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 385ms
back-notch        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 684ms
back-notch        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 299ms
hole-plate        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 42ms
hole-plate        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 31ms
hole-plate        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 32ms
counterbore       seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 121ms
counterbore       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 194ms
counterbore       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 109ms
dovetail          seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 9ms
dovetail          seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 18ms
dovetail          seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 44ms
v-block           seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 18ms
v-block           seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 18ms
v-block           seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 12ms
corner-cut        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 242ms
corner-cut        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 209ms
corner-cut        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 161ms
rib-bracket       seed1 输入吻合  93.2%  真值吻合  75.4%  ✗  [挖切 3 处] 4974ms
rib-bracket       seed2 输入吻合  93.2%  真值吻合  75.4%  ✗  [挖切 3 处] 4499ms
rib-bracket       seed3 输入吻合  93.2%  真值吻合  75.4%  ✗  [挖切 3 处] 4905ms
round-bracket     seed1 输入吻合  70.2%  真值吻合  65.4%  ✗  [外形 + 圆孔] 12887ms
round-bracket     seed2 输入吻合  70.2%  真值吻合  65.4%  ✗  [外形 + 圆孔] 12826ms
round-bracket     seed3 输入吻合  70.2%  真值吻合  65.4%  ✗  [外形 + 圆孔] 15126ms
bearing-seat      seed1 输入吻合  71.0%  真值吻合  69.0%  ✗  [挖切 3 处] 11865ms
bearing-seat      seed2 输入吻合  71.0%  真值吻合  69.0%  ✗  [挖切 3 处] 9088ms
bearing-seat      seed3 输入吻合  71.0%  真值吻合  69.0%  ✗  [挖切 3 处] 8697ms
slotted-cylinder  seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 2285ms
slotted-cylinder  seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 2117ms
slotted-cylinder  seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 2156ms

噪声 0 比例误差 0 缺视图 left：成功 30/39
### 噪声 0.005 比例误差 0.02
L-block           seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 60ms
L-block           seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 24ms
L-block           seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 28ms
slope-block       seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 24ms
slope-block       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 9ms
slope-block       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 12ms
slot-block        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 30ms
slot-block        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 48ms
slot-block        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 21ms
back-notch        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 414ms
back-notch        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 375ms
back-notch        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [挖切 1 处] 348ms
hole-plate        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 41ms
hole-plate        seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 31ms
hole-plate        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 33ms
counterbore       seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 78ms
counterbore       seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 76ms
counterbore       seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形 + 圆孔] 179ms
dovetail          seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 110ms
dovetail          seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 95ms
dovetail          seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 38ms
v-block           seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 17ms
v-block           seed2 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 11ms
v-block           seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [外形拉伸] 15ms
corner-cut        seed1 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 116ms
corner-cut        seed2 输入吻合  86.0%  真值吻合  84.7%  ✗  [外形拉伸] 644ms
corner-cut        seed3 输入吻合 100.0%  真值吻合 100.0%  ✓  [斜面切割 1 处] 179ms
rib-bracket       seed1 输入吻合  93.7%  真值吻合  75.3%  ✗  [挖切 3 处] 4082ms
rib-bracket       seed2 输入吻合  93.0%  真值吻合  75.4%  ✗  [挖切 3 处] 4306ms
rib-bracket       seed3 输入吻合  93.6%  真值吻合  75.2%  ✗  [挖切 3 处] 4089ms
round-bracket     seed1 输入吻合  68.4%  真值吻合  62.8%  ✗  [外形 + 圆孔] 13182ms
round-bracket     seed2 输入吻合  70.0%  真值吻合  65.3%  ✗  [外形 + 圆孔] 13272ms
round-bracket     seed3 输入吻合  70.2%  真值吻合  65.3%  ✗  [外形 + 圆孔] 12183ms
bearing-seat      seed1 输入吻合  85.4%  真值吻合  79.5%  ✗  [挖切 3 处] 16596ms
bearing-seat      seed2 输入吻合  76.9%  真值吻合  67.9%  ✗  [挖切 3 处] 8981ms
bearing-seat      seed3 输入吻合  85.5%  真值吻合  79.4%  ✗  [挖切 3 处] 15475ms
slotted-cylinder  seed1 输入吻合  86.7%  真值吻合  94.3%  ✗  [挖切 1 处] 4450ms
slotted-cylinder  seed2 输入吻合  94.9%  真值吻合  83.3%  ✗  [挖切 1 处] 2264ms
slotted-cylinder  seed3 输入吻合 100.0%  真值吻合  97.6%  ✓  [挖切 1 处] 2136ms

噪声 0.005 比例误差 0.02 缺视图 left：成功 27/39
