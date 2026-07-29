import { clamp, wrapDeg } from '../gl/math.js';

const KEY_ROT = 70;   // grados por segundo con el teclado
const KEY_FOV = 40;
const DAMP = 6.5;     // amortiguación de la inercia

/**
 * Cámara virtual: rotación con ratón, dedo, teclado o giroscopio,
 * con inercia opcional. En vídeos planos el arrastre desplaza la imagen.
 */
export class CameraController {
  constructor(canvas, { onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.onChange = onChange;

    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.fov = 90;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    this.sensitivity = 1;
    this.inertia = true;
    this.spherical = false;
    this.enabled = true;
    this.gyro = false;

    this._vYaw = 0;
    this._vPitch = 0;
    this._keys = new Set();
    this._pointers = new Map();
    this._pinch = null;
    this._dragging = false;
    this._gyroBase = null;

    this._bind();
  }

  _emit() { this.onChange(this); }

  _bind() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      c.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._vYaw = this._vPitch = 0;
      this._dragging = true;
      c.classList.add('dragging');
      if (this._pointers.size === 2) this._pinch = this._pinchDist();
    });

    c.addEventListener('pointermove', (e) => {
      const prev = this._pointers.get(e.pointerId);
      if (!prev || !this.enabled) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size >= 2) {
        const d = this._pinchDist();
        if (this._pinch && d > 0) {
          this.adjustZoom(this._pinch / d);
          this._pinch = d;
        }
        return;
      }
      this._drag(dx, dy);
    });

    const end = (e) => {
      if (!this._pointers.delete(e.pointerId)) return;
      if (this._pointers.size < 2) this._pinch = null;
      if (this._pointers.size === 0) {
        this._dragging = false;
        c.classList.remove('dragging');
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('lostpointercapture', end);

    c.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.adjustZoom(Math.exp(e.deltaY * 0.0015));
    }, { passive: false });

    c.addEventListener('dblclick', () => this.reset());

    window.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if ('wasdqe'.includes(k)) { this._keys.add(k); e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this._keys.clear());

    this._onOrient = (e) => this._applyGyro(e);
  }

  _pinchDist() {
    const [a, b] = [...this._pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _drag(dx, dy) {
    const rect = this.canvas.getBoundingClientRect();
    if (this.spherical) {
      const k = (this.fov / Math.max(rect.width, 1)) * this.sensitivity;
      this.yaw = wrapDeg(this.yaw - dx * k);
      this.pitch = clamp(this.pitch + dy * k, -90, 90);
      this._vYaw = -dx * k;
      this._vPitch = dy * k;
    } else {
      this.panX = clamp(this.panX + (dx / Math.max(rect.width, 1)) * 2, -8, 8);
      this.panY = clamp(this.panY - (dy / Math.max(rect.height, 1)) * 2, -8, 8);
    }
    this._emit();
  }

  /** factor > 1 aleja, factor < 1 acerca. */
  adjustZoom(factor) {
    if (this.spherical) {
      this.fov = clamp(this.fov * factor, 2, 340);
    } else {
      this.zoom = clamp(this.zoom / factor, 0.2, 40);
    }
    this._emit();
  }

  set(values = {}) {
    if (values.yaw !== undefined) this.yaw = wrapDeg(values.yaw);
    if (values.pitch !== undefined) this.pitch = clamp(values.pitch, -90, 90);
    if (values.roll !== undefined) this.roll = wrapDeg(values.roll);
    if (values.fov !== undefined) this.fov = clamp(values.fov, 2, 340);
    if (values.zoom !== undefined) this.zoom = clamp(values.zoom, 0.2, 40);
    if (values.panX !== undefined) this.panX = clamp(values.panX, -8, 8);
    if (values.panY !== undefined) this.panY = clamp(values.panY, -8, 8);
    this._emit();
  }

  reset() {
    this.yaw = 0; this.pitch = 0; this.roll = 0;
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this._vYaw = this._vPitch = 0;
    this._emit();
  }

  level() {
    this.roll = 0;
    this.pitch = 0;
    this._emit();
  }

  get dragging() { return this._dragging; }

  /** Integra teclado e inercia. dt en segundos. */
  update(dt) {
    if (!this.enabled) return;
    let changed = false;
    const step = KEY_ROT * dt * this.sensitivity;

    if (this.spherical) {
      if (this._keys.has('a')) { this.yaw = wrapDeg(this.yaw - step); changed = true; }
      if (this._keys.has('d')) { this.yaw = wrapDeg(this.yaw + step); changed = true; }
      if (this._keys.has('w')) { this.pitch = clamp(this.pitch + step, -90, 90); changed = true; }
      if (this._keys.has('s')) { this.pitch = clamp(this.pitch - step, -90, 90); changed = true; }
      if (this._keys.has('q')) { this.roll = wrapDeg(this.roll - step); changed = true; }
      if (this._keys.has('e')) { this.roll = wrapDeg(this.roll + step); changed = true; }

      if (this.inertia && !this._dragging && !this.gyro) {
        const decay = Math.exp(-DAMP * dt);
        if (Math.abs(this._vYaw) > 0.002 || Math.abs(this._vPitch) > 0.002) {
          this.yaw = wrapDeg(this.yaw + this._vYaw * dt * 60);
          this.pitch = clamp(this.pitch + this._vPitch * dt * 60, -90, 90);
          this._vYaw *= decay;
          this._vPitch *= decay;
          changed = true;
        } else {
          this._vYaw = this._vPitch = 0;
        }
      }
    }
    if (changed) this._emit();
  }

  /** Activa/desactiva el control por giroscopio (pide permiso en iOS). */
  async setGyro(on) {
    if (!on) {
      this.gyro = false;
      this._gyroBase = null;
      window.removeEventListener('deviceorientation', this._onOrient);
      return false;
    }
    const D = window.DeviceOrientationEvent;
    if (!D) throw new Error('Este dispositivo no expone el giroscopio.');
    if (typeof D.requestPermission === 'function') {
      const res = await D.requestPermission();
      if (res !== 'granted') throw new Error('Permiso de sensores denegado.');
    }
    this.gyro = true;
    window.addEventListener('deviceorientation', this._onOrient);
    return true;
  }

  _applyGyro(e) {
    if (!this.gyro || e.alpha === null) return;
    const screen = (window.screen?.orientation?.angle ?? window.orientation ?? 0);
    if (!this._gyroBase) this._gyroBase = e.alpha;
    this.yaw = wrapDeg(-(e.alpha - this._gyroBase) - screen);
    this.pitch = clamp(e.beta - 90, -90, 90);
    this.roll = wrapDeg(-e.gamma);
    this._emit();
  }
}

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
