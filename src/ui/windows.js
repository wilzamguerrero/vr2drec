/**
 * Gestor de ventanas flotantes: paneles que se abren desde la barra superior,
 * se arrastran por su cabecera y no estorban al vídeo.
 * Las posiciones se recuerdan en localStorage.
 */

const STORE = 'vr2drec.windows.v1';
const MARGIN = 8;

export class WindowManager {
  /**
   * @param {ParentNode} root contenedor de las ventanas (.windows)
   * @param {NodeListOf<HTMLElement>|Array} buttons botones con data-win
   */
  constructor(root, buttons) {
    this.wins = new Map();
    this.buttons = new Map();
    this.z = 50;
    this.positions = loadPositions();

    for (const win of root.querySelectorAll('.win')) {
      this.wins.set(win.id, win);
      win.addEventListener('pointerdown', () => this.front(win), true);
      const bar = win.querySelector('.win-bar');
      if (bar) this._makeDraggable(win, bar);
      const close = win.querySelector('[data-close]');
      if (close) close.addEventListener('click', () => this.close(win.id));
    }

    for (const btn of buttons) {
      const id = btn.dataset.win;
      if (!this.wins.has(id)) continue;
      this.buttons.set(id, btn);
      btn.addEventListener('click', () => this.toggle(id));
    }

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const top = this.topmost();
      if (top) { this.close(top.id); e.preventDefault(); }
    });

    window.addEventListener('resize', () => {
      for (const win of this.wins.values()) if (!win.hidden) this._place(win, this._read(win));
    });
  }

  isOpen(id) {
    const win = this.wins.get(id);
    return !!win && !win.hidden;
  }

  topmost() {
    let best = null;
    for (const win of this.wins.values()) {
      if (win.hidden) continue;
      if (!best || Number(win.style.zIndex || 0) > Number(best.style.zIndex || 0)) best = win;
    }
    return best;
  }

  open(id) {
    const win = this.wins.get(id);
    if (!win || !win.hidden) return;
    win.hidden = false;
    this._place(win, this._read(win));
    this.front(win);
    this._sync(id, true);
    const focusable = win.querySelector('button, [href], input, select, textarea');
    if (focusable) focusable.focus({ preventScroll: true });
  }

  close(id) {
    const win = this.wins.get(id);
    if (!win || win.hidden) return;
    win.hidden = true;
    this._sync(id, false);
    const btn = this.buttons.get(id);
    if (btn) btn.focus({ preventScroll: true });
  }

  toggle(id) {
    this.isOpen(id) ? this.close(id) : this.open(id);
  }

  front(win) {
    win.style.zIndex = String(++this.z);
  }

  /** Posición guardada, o la de por defecto con un pequeño escalonado. */
  _read(win) {
    const saved = this.positions[win.id];
    if (saved) return saved;
    const idx = [...this.wins.keys()].indexOf(win.id);
    return {
      x: Number(win.dataset.x || 24) + idx * 22,
      y: Number(win.dataset.y || 60) + idx * 18,
    };
  }

  _place(win, pos) {
    const w = win.offsetWidth || 330;
    const h = win.offsetHeight || 260;
    const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
    const maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN);
    const x = Math.min(Math.max(MARGIN, pos.x), maxX);
    const y = Math.min(Math.max(MARGIN, pos.y), maxY);
    win.style.left = `${Math.round(x)}px`;
    win.style.top = `${Math.round(y)}px`;
    this.positions[win.id] = { x, y };
  }

  _sync(id, open) {
    const btn = this.buttons.get(id);
    if (btn) btn.setAttribute('aria-pressed', String(open));
  }

  _makeDraggable(win, bar) {
    let start = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      bar.setPointerCapture(e.pointerId);
      start = { px: e.clientX, py: e.clientY, x: win.offsetLeft, y: win.offsetTop };
      this.front(win);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!start) return;
      this._place(win, { x: start.x + (e.clientX - start.px), y: start.y + (e.clientY - start.py) });
    });
    const end = () => {
      if (!start) return;
      start = null;
      savePositions(this.positions);
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    bar.addEventListener('lostpointercapture', end);

    // Doble clic en la cabecera: devuelve la ventana a su sitio original.
    bar.addEventListener('dblclick', () => {
      delete this.positions[win.id];
      this._place(win, this._read(win));
      savePositions(this.positions);
    });
  }
}

function loadPositions() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    return {};
  }
}

function savePositions(pos) {
  try {
    localStorage.setItem(STORE, JSON.stringify(pos));
  } catch { /* almacenamiento no disponible */ }
}
