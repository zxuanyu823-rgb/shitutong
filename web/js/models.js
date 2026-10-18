// 视图通 · 典型组合体题库
// 坐标约定（与教材第一角画法一致）：X 向右（长），Y 向后（宽，y=0 为前表面），Z 向上（高），单位 mm。
// 形体用「叠加 add / 切割 sub」描述，每个基本体都是可核验的参数：
//   box   : 长方体 min/max
//   prism : 柱体，按 axis 方向拉伸 poly 轮廓
//           axis 'y' → poly 写在 (x,z) 平面，即主视图里看到的形状
//           axis 'x' → poly 写在 (y,z) 平面
//           axis 'z' → poly 写在 (x,y) 平面，即俯视图里看到的形状
//   cyl   : 圆柱，axis 方向，c 为截面圆心（坐标平面同上），r 半径
//   cut   : 用平面切掉一角，p 为平面上一点，n 指向被切掉的一侧

export const MODELS = [
  {
    id: 'L-block', name: 'L 形块', level: '入门',
    desc: '主视图为 L 形轮廓沿前后方向拉伸而成。',
    points: ['三视图的投影规律：长对正、高平齐、宽相等', '平面垂直于投影面时投影积聚成直线'],
    ops: [
      { op: 'add', type: 'prism', axis: 'y', from: 0, to: 24,
        poly: [[0, 0], [40, 0], [40, 12], [14, 12], [14, 30], [0, 30]] },
    ],
  },
  {
    id: 'slope-block', name: '斜面块', level: '入门',
    desc: '长方体右上方被一个正垂面切去一角。',
    points: ['正垂面：主视图积聚为斜线，俯视图、左视图为类似形', '同一个面在不同视图中的对应关系'],
    ops: [
      { op: 'add', type: 'prism', axis: 'y', from: 0, to: 24,
        poly: [[0, 0], [40, 0], [40, 12], [20, 28], [0, 28]] },
    ],
  },
  {
    id: 'slot-block', name: '开槽块', level: '基础',
    desc: '长方体顶部中间开一条前后贯通的方槽。',
    points: ['左视图中槽底被遮挡，画成虚线', '虚线与实线重合时只画实线'],
    ops: [
      { op: 'add', type: 'box', min: [0, 0, 0], max: [40, 24, 24] },
      { op: 'sub', type: 'box', min: [14, -1, 12], max: [26, 25, 25] },
    ],
  },
  {
    id: 'back-notch', name: '后部开槽块', level: '基础',
    desc: '长方体后下方开一条左右方向的通槽，从正面看不见。',
    points: ['主视图中看不见的槽画成虚线', '俯视图、左视图核对槽的宽度和高度'],
    ops: [
      { op: 'add', type: 'box', min: [0, 0, 0], max: [40, 30, 24] },
      { op: 'sub', type: 'box', min: [12, 16, -1], max: [28, 31, 12] },
    ],
  },
  {
    id: 'hole-plate', name: '带孔底板', level: '基础',
    desc: '长方形底板中间钻一个竖直通孔。',
    points: ['孔在俯视图中反映为圆，另两个视图中孔壁的转向轮廓线为虚线', '圆要画十字中心线，孔要画轴线（细点画线）'],
    ops: [
      { op: 'add', type: 'box', min: [0, 0, 0], max: [50, 30, 10] },
      { op: 'sub', type: 'cyl', axis: 'z', c: [25, 15], r: 7, from: -1, to: 11 },
    ],
  },
  {
    id: 'counterbore', name: '沉孔板', level: '提高',
    desc: '底板上加工一个沉孔：上部大孔，下部小孔，同轴。',
    points: ['同轴的两段孔在主视图中形成台阶状虚线', '俯视图两个同心圆，都可见'],
    ops: [
      { op: 'add', type: 'box', min: [0, 0, 0], max: [44, 30, 16] },
      { op: 'sub', type: 'cyl', axis: 'z', c: [22, 15], r: 5, from: -1, to: 17 },
      { op: 'sub', type: 'cyl', axis: 'z', c: [22, 15], r: 9, from: 9, to: 17 },
    ],
  },
  {
    id: 'dovetail', name: '燕尾槽块', level: '提高',
    desc: '长方体顶部开一条前后贯通的燕尾槽，槽口窄、槽底宽。',
    points: ['俯视图中槽底两侧被顶面遮挡，画成虚线', '燕尾斜面是正垂面，主视图积聚为斜线'],
    ops: [
      { op: 'add', type: 'box', min: [0, 0, 0], max: [48, 24, 24] },
      { op: 'sub', type: 'prism', axis: 'y', from: -1, to: 25,
        poly: [[14, 10], [34, 10], [28.2857, 26], [19.7143, 26]] },
    ],
  },
  {
    id: 'v-block', name: 'V 形块', level: '基础',
    desc: '长方体顶部开一条前后贯通的 V 形槽。',
    points: ['V 形槽两侧都是正垂面', '左视图中 V 形槽的底线被遮挡，画成虚线'],
    ops: [
      { op: 'add', type: 'box', min: [0, 0, 0], max: [48, 24, 26] },
      { op: 'sub', type: 'prism', axis: 'y', from: -1, to: 25,
        poly: [[24, 12], [40, 28], [8, 28]] },
    ],
  },
  {
    id: 'corner-cut', name: '切角块', level: '提高',
    desc: '长方体右前上角被一个一般位置平面切掉。',
    points: ['一般位置平面在三个视图中都是类似形（三角形）', '截平面与各表面的交线要逐一对应'],
    ops: [
      { op: 'add', type: 'box', min: [0, 0, 0], max: [36, 24, 24] },
      // 平面经过 (20,0,24)、(36,16,24)、(36,0,8)
      { op: 'sub', type: 'cut', p: [36, 0, 8], n: [1, -1, 1] },
    ],
  },
  {
    id: 'rib-bracket', name: '带肋支架', level: '综合',
    desc: '底板 + 后竖板 + 中间三角形肋板叠加而成。',
    points: ['肋板斜面是侧垂面，左视图积聚为斜线', '叠加体共面时中间不画分界线'],
    ops: [
      { op: 'add', type: 'box', min: [0, 0, 0], max: [50, 32, 8] },
      { op: 'add', type: 'box', min: [0, 24, 8], max: [50, 32, 40] },
      { op: 'add', type: 'prism', axis: 'x', from: 21, to: 29,
        poly: [[4, 8], [24, 8], [24, 32]] },
    ],
  },
  {
    id: 'round-bracket', name: '圆头支架', level: '综合',
    desc: '底板上立一块圆头竖板，竖板有前后通孔，底板有两个竖直孔。',
    points: ['平面与圆柱面相切处不画线', '不同方向的孔：俯视图反映底板孔为圆，主视图反映竖板孔为圆'],
    ops: [
      { op: 'add', type: 'box', min: [0, 0, 0], max: [56, 34, 10] },
      { op: 'add', type: 'prism', axis: 'y', from: 24, to: 34,
        poly: [[4, 10], [52, 10], [52, 32], [4, 32]] },
      { op: 'add', type: 'cyl', axis: 'y', c: [28, 32], r: 24, from: 24, to: 34 },
      { op: 'sub', type: 'cyl', axis: 'y', c: [28, 32], r: 10, from: 23, to: 35 },
      { op: 'sub', type: 'cyl', axis: 'z', c: [12, 12], r: 5, from: -1, to: 11 },
      { op: 'sub', type: 'cyl', axis: 'z', c: [44, 12], r: 5, from: -1, to: 11 },
    ],
  },
  {
    id: 'bearing-seat', name: '轴承座', level: '综合',
    desc: '底板、支撑板、肋板与带孔圆筒组合而成，是组合体的典型综合题。',
    points: ['支撑板侧面与圆筒相切，相切处不画线', '肋板与圆筒相交，交线要画出', '圆筒孔在主视图反映为圆'],
    ops: [
      { op: 'add', type: 'box', min: [0, 0, 0], max: [64, 30, 10] },
      { op: 'add', type: 'box', min: [16, 22, 10], max: [48, 30, 34] },
      { op: 'add', type: 'cyl', axis: 'y', c: [32, 34], r: 16, from: 0, to: 30 },
      { op: 'add', type: 'box', min: [28, 2, 10], max: [36, 22, 26] },
      { op: 'sub', type: 'cyl', axis: 'y', c: [32, 34], r: 9, from: -1, to: 31 },
    ],
  },
  {
    id: 'slotted-cylinder', name: '圆柱开槽', level: '综合',
    desc: '竖直圆柱顶部开一条左右贯通的方槽。',
    points: ['槽口切断了圆柱的转向轮廓线', '截平面与圆柱面的交线为直线'],
    ops: [
      { op: 'add', type: 'cyl', axis: 'z', c: [16, 16], r: 16, from: 0, to: 30 },
      { op: 'sub', type: 'box', min: [-1, 10, 18], max: [33, 22, 31] },
    ],
  },
];

// 拍照重建得到的模型（只在本次打开页面期间有效）
export const CUSTOM = [];
export function getModel(id) {
  return MODELS.find(m => m.id === id) || CUSTOM.find(m => m.id === id) || null;
}
