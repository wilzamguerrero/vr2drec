import { lerp, wrapDeg } from '../gl/math.js';

const FIELDS = ['yaw', 'pitch', 'roll', 'fov'];

function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/**
 * Pista de keyframes de cámara para reencuadrar (reframing) el vídeo 360.
 * El yaw y el roll se "desenrollan" para que la interpolación tome siempre
 * el camino corto y no dé un giro completo al cruzar ±180°.
 */
export class KeyframeTrack {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.items = [];
  }

  get length() { return this.items.length; }

  add(kf) {
    const item = {
      t: Math.max(0, Number(kf.t) || 0),
      yaw: Number(kf.yaw) || 0,
      pitch: Number(kf.pitch) || 0,
      roll: Number(kf.roll) || 0,
      fov: Number(kf.fov) || 90,
    };
    // Un solo keyframe por instante (tolerancia de 30 ms).
    const dup = this.items.findIndex((k) => Math.abs(k.t - item.t) < 0.03);
    if (dup >= 0) this.items[dup] = item;
    else this.items.push(item);
    this._prepare();
    return item;
  }

  update(index, patch) {
    const item = this.items[index];
    if (!item) return;
    Object.assign(item, patch);
    this._prepare();
  }

  removeAt(index) {
    if (index < 0 || index >= this.items.length) return;
    this.items.splice(index, 1);
    this._prepare();
  }

  clear() {
    this.items = [];
    this._prepare();
  }

  toJSON() { return this.items.map((k) => ({ ...k })); }

  load(list) {
    this.items = (list || []).map((k) => ({
      t: Number(k.t) || 0,
      yaw: Number(k.yaw) || 0,
      pitch: Number(k.pitch) || 0,
      roll: Number(k.roll) || 0,
      fov: Number(k.fov) || 90,
    }));
    this._prepare();
  }

  _prepare() {
    this.items.sort((a, b) => a.t - b.t);
    // Copia con ángulos continuos para interpolar.
    this._c = this.items.map((k) => ({ ...k }));
    for (let i = 1; i < this._c.length; i++) {
      for (const f of ['yaw', 'roll']) {
        const prev = this._c[i - 1][f];
        this._c[i][f] = prev + wrapDeg(this._c[i][f] - prev);
      }
    }
    this.onChange(this.items);
  }

  /**
   * Valor de cámara en el instante t.
   * @param {number} t segundos
   * @param {'smooth'|'linear'|'hold'} easing
   * @returns {{yaw:number,pitch:number,roll:number,fov:number}|null}
   */
  sample(t, easing = 'smooth') {
    const k = this._c;
    if (!k || !k.length) return null;
    if (k.length === 1 || t <= k[0].t) return normalize(k[0]);
    if (t >= k[k.length - 1].t) return normalize(k[k.length - 1]);

    let i = 0;
    while (i < k.length - 2 && t > k[i + 1].t) i++;
    const a = k[i];
    const b = k[i + 1];
    const span = b.t - a.t;
    const u = span > 1e-6 ? (t - a.t) / span : 0;

    if (easing === 'hold') return normalize(a);

    const out = {};
    if (easing === 'linear') {
      for (const f of FIELDS) out[f] = lerp(a[f], b[f], u);
    } else {
      const p0 = k[i - 1] || a;
      const p3 = k[i + 2] || b;
      for (const f of FIELDS) out[f] = catmull(p0[f], a[f], b[f], p3[f], u);
    }
    return normalize(out);
  }
}

function normalize(v) {
  return {
    yaw: wrapDeg(v.yaw),
    pitch: Math.max(-90, Math.min(90, v.pitch)),
    roll: wrapDeg(v.roll),
    fov: Math.max(10, Math.min(340, v.fov)),
  };
}
