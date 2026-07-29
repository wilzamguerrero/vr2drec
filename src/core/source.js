/**
 * Gestión de fuentes de vídeo: archivos locales (sin subida, mediante
 * URL.createObjectURL sobre el File) y URLs remotas.
 */

const RX = {
  tb: /(_|\b|-)(tb|top-?bottom|ou|over-?under)(_|\b|-|\.)/i,
  sbs: /(_|\b|-)(sbs|side-?by-?side|lr|left-?right)(_|\b|-|\.)/i,
  eq360: /(360|equirect|erp|panor|insta360|theta|gear\s?360|max2|onex)/i,
  vr180: /(vr180|180x180|_180)/i,
  fisheye: /(fisheye|ojo.?de.?pez|dualfish|raw)/i,
};

const INSTA = /\.(insv|insp)$/i;

/** Adivina la proyección a partir del nombre y de la relación de aspecto. */
export function detectProjection(name = '', width = 0, height = 0) {
  const a = width && height ? width / height : 0;
  const near = (v, t, tol = 0.06) => Math.abs(v - t) < tol;

  if (INSTA.test(name)) {
    return { inMode: 'fisheye_dual', layout: 'mono', label: 'Insta360 doble ojo de pez' };
  }
  if (RX.fisheye.test(name)) {
    return near(a, 2)
      ? { inMode: 'fisheye_dual', layout: 'mono', label: 'doble ojo de pez' }
      : { inMode: 'fisheye_single', layout: 'mono', label: 'ojo de pez único' };
  }
  if (RX.vr180.test(name)) {
    return near(a, 2)
      ? { inMode: 'equirect180', layout: 'sbs', label: 'VR180 estéreo lado a lado' }
      : { inMode: 'equirect180', layout: 'mono', label: 'equirect 180°' };
  }
  if (RX.tb.test(name) && a >= 0.9) {
    return { inMode: 'equirect360', layout: 'tb', label: '360 estéreo arriba/abajo' };
  }
  if (RX.sbs.test(name) && a >= 3) {
    return { inMode: 'equirect360', layout: 'sbs', label: '360 estéreo lado a lado' };
  }
  if (!a && RX.eq360.test(name)) {
    // Aún no conocemos el tamaño: el nombre ya sugiere material 360.
    return { inMode: 'equirect360', layout: 'mono', label: 'equirectangular 360° (por el nombre)' };
  }
  if (near(a, 2)) {
    return { inMode: 'equirect360', layout: 'mono', label: 'equirectangular 360° (2:1)' };
  }
  if (near(a, 4, 0.15)) {
    return { inMode: 'equirect360', layout: 'sbs', label: '360 estéreo lado a lado (4:1)' };
  }
  if (near(a, 1, 0.04) && RX.eq360.test(name)) {
    return { inMode: 'equirect360', layout: 'tb', label: '360 estéreo arriba/abajo (1:1)' };
  }
  if (near(a, 1, 0.04)) {
    return { inMode: 'fisheye_single', layout: 'mono', label: 'cuadrado: ojo de pez o 360 arriba/abajo' };
  }
  if (RX.eq360.test(name) && a > 1.6) {
    return { inMode: 'equirect360', layout: 'mono', label: 'equirectangular 360° (por el nombre)' };
  }
  return { inMode: 'flat', layout: 'mono', label: 'plano 2D' };
}

/** URL equivalente a través del proxy del servidor local. */
export function proxyUrl(url) {
  return `/proxy?url=${encodeURIComponent(url)}`;
}

let seq = 0;

export class SourceManager {
  /**
   * @param {HTMLVideoElement} video
   * @param {(items: Array, current: object|null) => void} onChange
   */
  constructor(video, onChange = () => {}) {
    this.video = video;
    this.onChange = onChange;
    this.items = [];
    this.currentId = null;
  }

  get current() {
    return this.items.find((i) => i.id === this.currentId) || null;
  }

  addFiles(fileList) {
    const added = [];
    for (const file of Array.from(fileList || [])) {
      // Blob.slice con tipo forzado permite intentar reproducir .insv/.insp
      // (contenedores MP4 con otra extensión) sin copiar el archivo en memoria.
      const blob = file.type ? file : file.slice(0, file.size, 'video/mp4');
      const item = {
        id: `s${++seq}`,
        kind: 'file',
        name: file.name,
        size: file.size,
        url: URL.createObjectURL(blob),
        revoke: true,
        hint: detectProjection(file.name),
      };
      this.items.push(item);
      added.push(item);
    }
    if (added.length) this.select(added[0].id);
    else this.onChange(this.items, this.current);
    return added;
  }

  addUrl(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!url) throw new Error('Escribe una URL.');
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      throw new Error('La URL no es válida.');
    }
    if (!/^https?:$/.test(parsed.protocol) && parsed.protocol !== 'blob:') {
      throw new Error('Solo se admiten URLs http(s).');
    }
    const name = decodeURIComponent(parsed.pathname.split('/').pop() || parsed.hostname);
    const item = {
      id: `s${++seq}`,
      kind: 'url',
      name,
      url: parsed.href,
      remote: parsed.href,
      proxied: false,
      revoke: false,
      hint: detectProjection(name),
    };
    this.items.push(item);
    this.select(item.id);
    return item;
  }

  /** Vuelve a cargar una URL remota a través del proxy local (añade CORS). */
  useProxy(id = this.currentId) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.kind !== 'url' || item.proxied) return null;
    item.proxied = true;
    item.url = proxyUrl(item.remote);
    return this.select(item.id);
  }

  select(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    this.currentId = id;
    this.video.crossOrigin = item.kind === 'url' ? 'anonymous' : null;
    this.video.src = item.url;
    this.video.load();
    this.onChange(this.items, item);
    return item;
  }

  remove(id) {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const [item] = this.items.splice(idx, 1);
    if (item.revoke) URL.revokeObjectURL(item.url);
    if (this.currentId === id) {
      this.currentId = null;
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      const next = this.items[Math.min(idx, this.items.length - 1)];
      if (next) return this.select(next.id);
    }
    this.onChange(this.items, this.current);
  }

  next(dir = 1) {
    if (!this.items.length) return null;
    const idx = this.items.findIndex((i) => i.id === this.currentId);
    const n = (idx + dir + this.items.length) % this.items.length;
    return this.select(this.items[n].id);
  }
}
