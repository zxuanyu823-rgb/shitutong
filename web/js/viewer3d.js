// 视图通 · 三维视图
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { VIEW_KEYS } from './engine.js';

const C = {
  bg: 0xf3f5f6, body: 0xdbe3ec, bodyCurved: 0xd3dde8, edge: 0x1d2733, hidden: 0x5a6b7d,
  sel: 0xe4572e, selFace: 0xffb199, occ: 0x2f6fde, plane: 0x9fb7d6,
};

// Several lines/faces share materials. Release each resource once before
// detaching the objects so repeated comparisons do not retain GPU buffers.
function disposeGroup(group) {
  const geometries = new Set(), materials = new Set();
  group.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material) materials.add(material);
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  group.clear();
}

export class Viewer3D {
  constructor(el, { onPick } = {}) {
    this.el = el; this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(C.bg);
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c2cc, 1.5));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dl = new THREE.DirectionalLight(0xffffff, 1.25); dl.position.set(-0.5, -1, 1.6); this.scene.add(dl);
    const dl2 = new THREE.DirectionalLight(0xffffff, 0.45); dl2.position.set(1, 0.6, 0.3); this.scene.add(dl2);
    this.dl = dl;
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.hl = new THREE.Group(); this.scene.add(this.hl);
    this.xray = false; this.anim = null; this.unfold = null;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(el);
    this._bindPick();
    const loop = () => { requestAnimationFrame(loop); this._tick(); this.controls.update(); this.renderer.render(this.scene, this.camera); };
    loop();
  }

  resize() {
    const w = this.el.clientWidth || 300, h = this.el.clientHeight || 300;
    this.renderer.setSize(w, h, false);
    this.aspect = w / h; this._frustum();
  }
  _frustum() {
    let s = (this.size || 60) * 0.78 * Math.max(1, 1 / (this.aspect || 1));
    if (this.unfold) { const [w, h] = this.unfold.extent; s = Math.max(h / 2, w / 2 / (this.aspect || 1)) * 1.12; }
    this.camera.left = -s * this.aspect; this.camera.right = s * this.aspect; this.camera.top = s; this.camera.bottom = -s;
    this.camera.updateProjectionMatrix();
  }

  rememberView() {
    return {
      position: this.camera.position.toArray(), target: this.controls.target.toArray(),
      up: this.camera.up.toArray(), zoom: this.camera.zoom,
      frustum: [this.camera.left, this.camera.right, this.camera.top, this.camera.bottom],
    };
  }
  restoreView(view) {
    if (!view) return;
    this.anim = null;
    // Consume residual damping before restoring the camera, otherwise the
    // following animation frame can move a just-restored view.
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.position.fromArray(view.position);
    this.camera.up.fromArray(view.up);
    this.controls.target.fromArray(view.target);
    this.camera.zoom = view.zoom;
    if (view.frustum) [this.camera.left, this.camera.right, this.camera.top, this.camera.bottom] = view.frustum;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.controls.enableDamping = damping;
  }

  setModel(model, { preserveCamera = false } = {}) {
    const savedView = preserveCamera && this.model ? this.rememberView() : null;
    const wasUnfold = this.unfold ? this.unfold.theta : null;
    this.anim = null;
    clearTimeout(this._unfoldViewTimer);
    this.model = model;
    disposeGroup(this.root); disposeGroup(this.hl);
    if (this.unfold) { this.scene.remove(this.unfold.group); disposeGroup(this.unfold.group); this.unfold = null; }
    const { pos, tris, tn, triFace, faces } = model;
    // 曲面用平滑法线，平面用面法线
    const vnorm = new Map();
    tris.forEach((t, i) => {
      const f = faces[triFace[i]];
      if (f.planar) return;
      for (const v of t) { const k = f.index + ':' + v; const n = vnorm.get(k) || [0, 0, 0]; vnorm.set(k, [n[0] + tn[i][0], n[1] + tn[i][1], n[2] + tn[i][2]]); }
    });
    const P = [], N = [], Col = [];
    const cA = new THREE.Color(C.body), cB = new THREE.Color(C.bodyCurved);
    tris.forEach((t, i) => {
      const f = faces[triFace[i]];
      for (const v of t) {
        P.push(...pos[v]);
        let n = tn[i];
        if (!f.planar) { const s = vnorm.get(f.index + ':' + v); const l = Math.hypot(...s); n = [s[0] / l, s[1] / l, s[2] / l]; }
        N.push(...n);
        const c = f.planar ? cA : cB; Col.push(c.r, c.g, c.b);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(Col, 3));
    this.matBody = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, this.matBody);
    this.root.add(this.mesh);
    // 棱线
    const E = [];
    for (const c of model.curves) for (const [a, b] of c.segs) E.push(...a, ...b);
    const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(E, 3));
    // 棱线和虚线都放在半透明队列里、排在实体之后绘制，才能用深度区分可见/不可见
    this.edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: C.edge, transparent: true }));
    this.edges.renderOrder = 1;
    this.root.add(this.edges);
    const hg = eg.clone();
    this.hiddenEdges = new THREE.LineSegments(hg, new THREE.LineDashedMaterial({ color: C.hidden, dashSize: 1.6, gapSize: 1.1, depthFunc: THREE.GreaterDepth, transparent: true, opacity: 0.9 }));
    this.hiddenEdges.computeLineDistances(); this.hiddenEdges.visible = this.xray; this.hiddenEdges.renderOrder = 2;
    this.root.add(this.hiddenEdges);

    const [bmin, bmax] = model.bbox;
    this.center = new THREE.Vector3((bmin[0] + bmax[0]) / 2, (bmin[1] + bmax[1]) / 2, (bmin[2] + bmax[2]) / 2);
    this.size = Math.max(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]);
    this._frustum();
    this.setXray(this.xray);
    this.setView('iso', false);
    // 展开演示开着时，换模型后按新模型重建投影面
    if (wasUnfold !== null) {
      this.showUnfold(true, model);
      this.unfold.theta = wasUnfold; this.unfold.hGroup.rotation.x = wasUnfold; this.unfold.wGroup.rotation.z = wasUnfold;
      if (wasUnfold > 0.01) { this.anim = null; this.setView('front', false); }
    }
    if (savedView) this.restoreView(savedView);
  }

  setXray(on) {
    this.xray = on;
    if (!this.matBody) return;
    // 透视模式：实体半透明但仍写深度，被遮挡的棱以虚线显示（与三视图中虚线的含义一致）
    this.matBody.transparent = on; this.matBody.opacity = on ? 0.3 : 1; this.matBody.depthWrite = true;
    this.matBody.needsUpdate = true;
    if (this.hiddenEdges) this.hiddenEdges.visible = on;
  }

  viewDir(v) {
    return { front: [0, -1, 0], top: [0, -0.0001, 1], left: [-1, 0, 0], iso: [-0.62, -1, 0.78], back: [0, 1, 0], right: [1, 0, 0] }[v];
  }
  setView(v, animate = true) {
    const d = new THREE.Vector3(...this.viewDir(v)).normalize();
    const D = 400;
    const to = this.center.clone().add(d.multiplyScalar(D));
    const target = this.unfold ? this.unfold.center.clone() : this.center.clone();
    if (this.unfold) to.add(this.unfold.center.clone().sub(this.center));
    if (!animate) { this.camera.position.copy(to); this.controls.target.copy(target); this.camera.zoom = 1; this.camera.updateProjectionMatrix(); return; }
    this.anim = { t0: performance.now(), dur: 700, from: this.camera.position.clone().sub(this.controls.target), to: to.clone().sub(target), tFrom: this.controls.target.clone(), tTo: target, zFrom: this.camera.zoom };
  }
  _tick() {
    const now = performance.now();
    if (this.anim) {
      const a = this.anim, k = Math.min(1, (now - a.t0) / a.dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      // 球面插值方向
      const f = a.from.clone().normalize(), t = a.to.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(f, t);
      const qi = new THREE.Quaternion().slerp(q, e);
      const dir = f.applyQuaternion(qi).multiplyScalar(a.to.length());
      const tgt = a.tFrom.clone().lerp(a.tTo, e);
      this.controls.target.copy(tgt);
      this.camera.position.copy(tgt.clone().add(dir));
      this.camera.zoom = a.zFrom + (1 - a.zFrom) * e; this.camera.updateProjectionMatrix();
      if (k >= 1) this.anim = null;
    }
    if (this.unfold && this.unfold.playing) {
      const u = this.unfold; const k = Math.min(1, (now - u.t0) / u.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const th = (u.from + (u.to - u.from) * e) * Math.PI / 2;
      u.hGroup.rotation.x = th; u.wGroup.rotation.z = th; u.theta = th;
      if (k >= 1) { u.playing = false; u.onDone && u.onDone(); }
    }
  }

  // 选中高亮：曲线用粗管，面用彩色覆盖
  setSelection(sel = {}) {
    disposeGroup(this.hl);
    if (!this.model) return;
    const model = this.model, r = this.size * 0.008;
    const curveIds = new Set(sel.curves || []), faceIds = new Set(sel.faces || []), occIds = new Set(sel.occluders || []);
    const segs = [];
    for (const c of model.curves) if (curveIds.has(c.id)) segs.push(...c.segs);
    for (const v of VIEW_KEYS) for (const s of model.views[v].sils) if (curveIds.has(s.id)) segs.push(...s.segs);
    let tubeMat;
    for (const [a, b] of segs) {
      const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
      const L = A.distanceTo(B); if (L < 1e-6) continue;
      tubeMat ||= new THREE.MeshBasicMaterial({ color: C.sel, depthTest: false, transparent: true });
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, 8, 1), tubeMat);
      m.position.copy(A.clone().add(B).multiplyScalar(0.5));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
      m.renderOrder = 10; this.hl.add(m);
    }
    const addFaces = (ids, color, opacity) => {
      const P = [];
      for (const f of model.faces) if (ids.has(f.id)) for (const t of f.tris) for (const v of model.tris[t]) P.push(...model.pos[v]);
      if (!P.length) return;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthTest: !this.xray, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.renderOrder = 5; this.hl.add(m);
    };
    addFaces(faceIds, C.selFace, 0.75);
    addFaces(occIds, C.occ, 0.38);
  }

  // 三投影面展开演示
  showUnfold(on, model = this.model, lines) {
    clearTimeout(this._unfoldViewTimer);
    if (on && !lines && model) lines = { front: model.views.front.lines, top: model.views.top.lines, left: model.views.left.lines };
    if (this.unfold) { this.scene.remove(this.unfold.group); disposeGroup(this.unfold.group); this.unfold = null; }
    if (!on) { this._frustum(); this.setView('iso'); return; }
    const [bmin, bmax] = model.bbox, gap = this.size * 0.45;
    const Yv = bmax[1] + gap, Zh = bmin[2] - gap, Xw = bmax[0] + gap;
    const ext = this.size * 1.05;
    const group = new THREE.Group();
    const planeMat = new THREE.MeshBasicMaterial({ color: C.plane, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const frameMat = new THREE.LineBasicMaterial({ color: 0x6d88ad });
    const rect = (pts) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(...p)));
      const sh = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([0, 1, 2, 0, 2, 3].map(i => new THREE.Vector3(...pts[i]))), planeMat);
      const fr = new THREE.LineLoop(g, frameMat);
      const gg = new THREE.Group(); gg.add(sh, fr); return gg;
    };
    const x0 = bmin[0] - gap * 0.6, z1 = bmax[2] + gap * 0.6, y0 = bmin[1] - gap * 0.6;
    // V 面（正立投影面）在物体后方
    const V = rect([[x0, Yv, Zh], [Xw, Yv, Zh], [Xw, Yv, z1], [x0, Yv, z1]]);
    // H 面（水平投影面）在物体下方，可绕 OX 轴向下转
    const hGroup = new THREE.Group(); hGroup.position.set(0, Yv, Zh);
    hGroup.add(rect([[x0, y0 - Yv, 0], [Xw, y0 - Yv, 0], [Xw, 0, 0], [x0, 0, 0]]));
    // W 面（侧立投影面）在物体右方，可绕 OZ 轴向右转
    const wGroup = new THREE.Group(); wGroup.position.set(Xw, Yv, 0);
    wGroup.add(rect([[0, y0 - Yv, Zh], [0, 0, Zh], [0, 0, z1], [0, y0 - Yv, z1]]));
    // 把三个视图画到投影面上
    const lineMat = new THREE.LineBasicMaterial({ color: C.edge });
    const dashMat = new THREE.LineDashedMaterial({ color: C.edge, dashSize: 1.4, gapSize: 0.9 });
    const put = (target, view, map) => {
      const vis = [], hid = [];
      for (const l of lines[view]) (l.vis ? vis : hid).push(...map(l.a), ...map(l.b));
      if (vis.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(vis, 3)); target.add(new THREE.LineSegments(g, lineMat)); }
      if (hid.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(hid, 3)); const ls = new THREE.LineSegments(g, dashMat); ls.computeLineDistances(); target.add(ls); }
    };
    put(V, 'front', ([u, v]) => [u, Yv - 0.05, v]);
    put(hGroup, 'top', ([u, v]) => [u, v - Yv, 0.05]);
    put(wGroup, 'left', ([u, v]) => [-0.05, -u - Yv, v]);
    // 坐标轴标注
    group.add(V, hGroup, wGroup);
    this.scene.add(group);
    // 展开后的整体范围：V 面 + 下方的 H 面 + 右方的 W 面
    const depth = Yv - y0;
    const X0 = x0, X1 = Xw + depth, Z0 = Zh - depth, Z1 = z1;
    const center = new THREE.Vector3((X0 + X1) / 2, (y0 + Yv) / 2, (Z0 + Z1) / 2);
    this.unfold = { group, hGroup, wGroup, theta: 0, playing: false, center, extent: [X1 - X0, Z1 - Z0] };
    this._frustum();
    this.setView('iso');
  }
  playUnfold(open = true, onDone) {
    if (!this.unfold) return;
    const u = this.unfold;
    u.from = u.theta / (Math.PI / 2); u.to = open ? 1 : 0; u.t0 = performance.now(); u.dur = 2200; u.playing = true; u.onDone = onDone;
    clearTimeout(this._unfoldViewTimer);
    if (open) this._unfoldViewTimer = setTimeout(() => { if (this.unfold === u) this.setView('front'); }, 300);
  }

  _bindPick() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const hit = this.pick(e.clientX, e.clientY);
      this.onPick && this.onPick(hit);
    });
  }
  pick(cx, cy) {
    if (!this.model) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObject(this.mesh);
    const hitDist = hits.length ? hits[0].distance : Infinity;
    // 先找附近的棱（屏幕距离 < 9px）
    const toScreen = p => { const v = new THREE.Vector3(...p).project(this.camera); return [(v.x + 1) / 2 * rect.width, (1 - v.y) / 2 * rect.height]; };
    const mx = cx - rect.left, my = cy - rect.top;
    let best = null, bd = 9;
    for (const c of this.model.curves) for (const [a, b] of c.segs) {
      const A = toScreen(a), B = toScreen(b);
      const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      let t = L2 ? ((mx - A[0]) * dx + (my - A[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(mx - A[0] - t * dx, my - A[1] - t * dy);
      if (d >= bd) continue;
      // 被挡住的棱只有在透视模式下才能点
      const P = new THREE.Vector3(...a).lerp(new THREE.Vector3(...b), t);
      const along = P.clone().sub(ray.ray.origin).dot(ray.ray.direction);
      if (!this.xray && along > hitDist + this.size * 0.02) continue;
      bd = d; best = c.id;
    }
    if (best) return { type: 'curve', id: best };
    if (hits.length) {
      const triIndex = hits[0].faceIndex;
      const f = this.model.faces[this.model.triFace[triIndex]];
      return { type: 'face', id: f.id };
    }
    return null;
  }

  snapshot() { return this.renderer.domElement.toDataURL('image/png'); }
}
