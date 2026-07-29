import { mat4Invert, mat3FromMat4, mat3Mul, orientationMatrix } from '../gl/math.js';

/** ¿Hay soporte de sesiones inmersivas en este navegador/dispositivo? */
export async function xrSupported() {
  if (!navigator.xr || !navigator.xr.isSessionSupported) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-vr');
  } catch {
    return false;
  }
}

/**
 * Sesión WebXR: reproyecta la esfera para cada ojo usando la matriz de
 * proyección de cada vista, de modo que también funcionan las lentes
 * asimétricas de los visores reales.
 */
export class XRPresenter {
  /**
   * @param {import('../gl/renderer.js').Renderer} renderer
   * @param {HTMLVideoElement} video
   * @param {() => object} getState estado de proyección actual
   */
  constructor(renderer, video, getState, { onStart = () => {}, onEnd = () => {} } = {}) {
    this.renderer = renderer;
    this.video = video;
    this.getState = getState;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.session = null;
    this.refSpace = null;
    this._invProj = new Float32Array(16);
    this._rot = new Float32Array(9);
  }

  get active() { return !!this.session; }

  async start() {
    if (this.session) return this.session;
    if (!navigator.xr) throw new Error('WebXR no está disponible en este navegador.');
    const gl = this.renderer.gl;
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor'],
    });
    this.session = session;

    if (gl.makeXRCompatible) await gl.makeXRCompatible();
    const layer = new XRWebGLLayer(session, gl);
    session.updateRenderState({ baseLayer: layer });

    for (const space of ['local-floor', 'local', 'viewer']) {
      try {
        this.refSpace = await session.requestReferenceSpace(space);
        break;
      } catch { /* probar el siguiente */ }
    }
    if (!this.refSpace) {
      await this.end();
      throw new Error('No se pudo obtener un espacio de referencia XR.');
    }

    session.addEventListener('end', () => {
      this.session = null;
      this.refSpace = null;
      this.onEnd();
    });

    this.onStart();
    session.requestAnimationFrame(this._frame);
    return session;
  }

  _frame = (time, frame) => {
    const session = this.session;
    if (!session) return;
    session.requestAnimationFrame(this._frame);

    const pose = frame.getViewerPose(this.refSpace);
    if (!pose) return;

    const gl = this.renderer.gl;
    const layer = session.renderState.baseLayer;
    this.renderer.uploadFrame(this.video);

    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const state = this.getState();
    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      if (!vp || !vp.width) continue;
      const inv = mat4Invert(view.projectionMatrix, this._invProj);
      if (!inv) continue;
      // Orientación del visor combinada con el yaw elegido por el usuario.
      const viewRot = mat3FromMat4(view.transform.matrix);
      const rot = mat3Mul(orientationMatrix(state.yaw, 0, 0), viewRot, this._rot);
      this.renderer.renderXRView(state, vp, inv, rot, view.eye === 'right' ? 1 : 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  async end() {
    if (this.session) {
      try { await this.session.end(); } catch { /* ya cerrada */ }
      this.session = null;
    }
  }
}
