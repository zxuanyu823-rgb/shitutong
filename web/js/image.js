// 视图通 · 图片工具：SVG 转 PNG（给视觉模型看）、照片缩小压缩（识图和自定义背景用）

export function svgToPNG(svg, width, height) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, width, height); g.drawImage(img, 0, 0, width, height);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('图片绘制失败'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

// 长边缩到 max 像素以内，转成 JPEG data URL
export function shrinkImage(file, max = 1600, quality = 0.86) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('图片读不出来'));
    const r = new FileReader(); r.onload = () => { img.src = r.result; }; r.onerror = reject; r.readAsDataURL(file);
  });
}
