import { orientationMatrix, clamp } from '../gl/math.js';

const MIN = 0.04;
const R2D = 180 / Math.PI;

/**
 * Marco de recorte dibujable sobre la imagen. Define el área de salida
 * (proporción y resolución) sin tener que teclear ancho y alto.
 *
 * El rectángulo se guarda en coordenadas normalizadas del fotograma:
 * x, y desde la esquina superior izquierda, w, h como fracción (0..1).
 */
export class CropTool {
  constructor(overlay, box, { onChange = () => {} } = {}) {
    this.overlay = overlay;
    this.box = box;
    this.onChange = onChange;
    this.rect = { x: 0, y: 0, w: 1, h: 1 };
    this.aspect = null; // proporción bloqueada en píxeles de salida
    this.active = false;
    this._drag = null;
    this._bind();
  }

  get frameSize() {
    return { w: this.overlay.clientWidth || 1, h: this.overlay.clientHeight || 1 };
  }

  enable() {
    this.active = true;
    this.overlay.hidden = false;
    this.layout();
  }

  disable() {
    this.active = false;
    this.overlay.hidden = true;
    this._drag = null;
  }

  full() {
    this.rect = { x: 0, y: 0, w: 1, h: 1 };
    if (this.aspect) this._applyAspect('se');
    this.layout();
    this.onChange(this.rect);
  }

  setAspect(a) {
    this.aspect = a && isFinite(a) && a > 0 ? a : null;
    if (this.aspect) {
      this._applyAspect('c');
      this.layout();
      this.onChange(this.rect);
    }
  }

  /** Coloca el rectángulo del DOM según el estado actual. */
  layout() {
    const r = this.rect;
    const s = this.box.style;
    s.left = `${(r.x * 100).toFixed(4)}%`;
    s.top = `${(r.y * 100).toFixed(4)}%`;
    s.width = `${(r.w * 100).toFixed(4)}%`;
    s.height = `${(r.h * 100).toFixed(4)}%`;
  }

  _bind() {
    const onDown = (e) => {
      if (!this.active) return;
      const handle = e.target.closest('.hnd');
      const inBox = e.target === this.box || this.box.contains(e.target);
      e.preventDefault();
      e.stopPropagation();
      this.overlay.setPointerCapture(e.pointerId);
      const p = this._point(e);

      if (handle) {
        this._drag = { kind: handle.dataset.h, start: p, rect: { ...this.rect } };
      } else if (inBox) {
        this._drag = { kind: 'move', start: p, rect: { ...this.rect } };
      } else {
        // Arrastrar sobre el fondo dibuja un marco nuevo.
        const prev = { ...this.rect };
        this.rect = { x: p.x, y: p.y, w: MIN, h: MIN };
        this._drag = { kind: 'se', start: p, rect: { ...this.rect }, fresh: true, prev };
      }
    };

    const onMove = (e) => {
      if (!this._drag) return;
      e.preventDefault();
      const p = this._point(e);
      const d = this._drag;
      d.moved = true;
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;

      if (d.kind === 'move') {
        this.rect = {
          ...d.rect,
          x: clamp(d.rect.x + dx, 0, 1 - d.rect.w),
          y: clamp(d.rect.y + dy, 0, 1 - d.rect.h),
        };
      } else {
        const r = d.fresh ? { x: d.start.x, y: d.start.y, w: 0, h: 0 } : { ...d.rect };
        let l = r.x, t = r.y, rt = r.x + r.w, b = r.y + r.h;
        const k = d.kind;
        if (k.includes('w')) l = clamp(r.x + dx, 0, rt - MIN);
        if (k.includes('e')) rt = clamp(r.x + r.w + dx, l + MIN, 1);
        if (k.includes('n')) t = clamp(r.y + dy, 0, b - MIN);
        if (k.includes('s')) b = clamp(r.y + r.h + dy, t + MIN, 1);
        this.rect = { x: l, y: t, w: rt - l, h: b - t };
        if (this.aspect) this._applyAspect(k);
      }
      this.layout();
      this.onChange(this.rect);
    };

    const onUp = () => {
      const d = this._drag;
      if (!d) return;
      this._drag = null;
      // Un clic suelto sobre el fondo no debe reducir el marco a la nada.
      if (d.fresh && !d.moved && d.prev) {
        this.rect = d.prev;
        this.layout();
      }
      this.onChange(this.rect);
    };

    this.overlay.addEventListener('pointerdown', onDown);
    this.overlay.addEventListener('pointermove', onMove);
    this.overlay.addEventListener('pointerup', onUp);
    this.overlay.addEventListener('pointercancel', onUp);
    this.overlay.addEventListener('lostpointercapture', onUp);

    // Teclado: mover el marco con las flechas cuando tiene el foco.
    this.box.addEventListener('keydown', (e) => {
      if (!this.active) return;
      const step = e.shiftKey ? 0.05 : 0.01;
      const r = { ...this.rect };
      if (e.key === 'ArrowLeft') r.x = clamp(r.x - step, 0, 1 - r.w);
      else if (e.key === 'ArrowRight') r.x = clamp(r.x + step, 0, 1 - r.w);
      else if (e.key === 'ArrowUp') r.y = clamp(r.y - step, 0, 1 - r.h);
      else if (e.key === 'ArrowDown') r.y = clamp(r.y + step, 0, 1 - r.h);
      else return;
      e.preventDefault();
      this.rect = r;
      this.layout();
      this.onChange(this.rect);
    });
  }

  _point(e) {
    const b = this.overlay.getBoundingClientRect();
    return {
      x: clamp((e.clientX - b.left) / Math.max(b.width, 1), 0, 1),
      y: clamp((e.clientY - b.top) / Math.max(b.height, 1), 0, 1),
    };
  }

  /** Fuerza la proporción bloqueada anclando el lado contrario al que se arrastra. */
  _applyAspect(kind) {
    const { w: FW, h: FH } = this.frameSize;
    const r = { ...this.rect };
    // h (fracción) = w * FW / (aspect * FH)
    const hFromW = (w) => (w * FW) / (this.aspect * FH);
    const wFromH = (h) => (h * this.aspect * FH) / FW;

    const vertical = kind === 'n' || kind === 's';
    let w = r.w;
    let h = r.h;
    if (vertical) { h = r.h; w = wFromH(h); } else { w = r.w; h = hFromW(w); }

    if (w > 1) { w = 1; h = hFromW(w); }
    if (h > 1) { h = 1; w = wFromH(h); }

    // Ancla: la esquina/lado opuesto al que se está moviendo.
    let x = r.x;
    let y = r.y;
    if (kind.includes('w')) x = r.x + r.w - w;
    if (kind.includes('n')) y = r.y + r.h - h;
    if (kind === 'n' || kind === 's' || kind === 'c') x = r.x + r.w / 2 - w / 2;
    if (kind === 'w' || kind === 'e' || kind === 'c') y = r.y + r.h / 2 - h / 2;

    x = clamp(x, 0, 1 - w);
    y = clamp(y, 0, 1 - h);
    this.rect = { x, y, w, h };
  }
}

/* ------------------------------------------------------------------ cálculo */

/** Tamaño de salida (píxeles pares) que corresponde al recorte. */
export function cropToOutSize(rect, out) {
  const even = (v) => Math.max(64, Math.round(v / 2) * 2);
  return { w: even(out.w * rect.w), h: even(out.h * rect.h) };
}

/** Rayo de cámara para un punto en coordenadas NDC, según la proyección de salida. */
export function rayFromNdc(px, py, aspect, fovDeg, outMode) {
  const fov = fovDeg / R2D;
  if (outMode === 'equirect') {
    const lon = px * Math.PI;
    const lat = (py * Math.PI) / 2;
    const cl = Math.cos(lat);
    return [Math.sin(lon) * cl, Math.sin(lat), -Math.cos(lon) * cl];
  }
  if (outMode === 'stereo') {
    const k = 2 * Math.tan(fov / 4);
    const qx = px * k;
    const qy = (py * k) / aspect;
    const r = Math.hypot(qx, qy);
    if (r < 1e-9) return [0, 0, -1];
    const th = 2 * Math.atan(r / 2);
    const s = Math.sin(th) / r;
    return [qx * s, qy * s, -Math.cos(th)];
  }
  const t = Math.tan(fov / 2);
  const v = [px * t, (py * t) / aspect, -1];
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Cámara equivalente al recorte: el centro del marco pasa a ser el centro de
 * la vista y el campo de visión se estrecha en la misma proporción.
 * @returns {{yaw:number, pitch:number, fov:number}}
 */
export function cropCamera(rect, cam, aspect, outMode) {
  const cx = (rect.x + rect.w / 2) * 2 - 1;
  const cy = 1 - (rect.y + rect.h / 2) * 2;
  const d = rayFromNdc(cx, cy, aspect, cam.fov, outMode);
  const R = orientationMatrix(cam.yaw, cam.pitch, cam.roll);
  // R es column-major: componente i = suma_k R[k*3+i] * d[k]
  const wx = R[0] * d[0] + R[3] * d[1] + R[6] * d[2];
  const wy = R[1] * d[0] + R[4] * d[1] + R[7] * d[2];
  const wz = R[2] * d[0] + R[5] * d[1] + R[8] * d[2];

  const yaw = Math.atan2(wx, -wz) * R2D;
  const pitch = Math.asin(clamp(wy, -1, 1)) * R2D;

  let fov = cam.fov;
  if (outMode === 'rect') {
    fov = 2 * Math.atan(rect.w * Math.tan(cam.fov / R2D / 2)) * R2D;
  } else if (outMode === 'stereo') {
    const k = 2 * Math.tan(cam.fov / R2D / 4);
    fov = 2 * (2 * Math.atan((rect.w * k) / 2)) * R2D;
  }
  return { yaw, pitch, fov: clamp(fov, 1, 340) };
}

/** Zoom y desplazamiento equivalentes al recorte en vídeo plano. */
export function cropFlat(rect, cam) {
  const cx = (rect.x + rect.w / 2) * 2 - 1;
  const cy = 1 - (rect.y + rect.h / 2) * 2;
  return {
    zoom: clamp(cam.zoom / Math.max(rect.w, 1e-3), 0.2, 40),
    panX: clamp((cam.panX - cx) / Math.max(rect.w, 1e-3), -8, 8),
    panY: clamp((cam.panY - cy) / Math.max(rect.h, 1e-3), -8, 8),
  };
}
