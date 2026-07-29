import { VERT_SRC, FRAG_SRC, IN_MODE, OUT_MODE, LAYOUT } from './shaders.js';
import { orientationMatrix, DEG } from './math.js';

const UNIFORMS = [
  'uTex', 'uAspect', 'uSrcAspect', 'uFov', 'uRot', 'uInvProj',
  'uOutMode', 'uInMode', 'uLayout', 'uEye',
  'uFishFov', 'uFishScale', 'uFishBlend', 'uZoom', 'uPan',
];

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Error compilando shader: ${log}`);
  }
  return sh;
}

/** Renderiza el vídeo reproyectado sobre un lienzo WebGL. */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // necesario para toBlob() fiable
      powerPreference: 'high-performance',
    };
    this.gl = canvas.getContext('webgl2', opts);
    this.isWebGL2 = !!this.gl;
    if (!this.gl) this.gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!this.gl) throw new Error('Este navegador no expone WebGL, imprescindible para reproyectar 360.');

    this.contextLost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this._build();
      this.contextLost = false;
    });

    this._build();
  }

  _build() {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Error enlazando el programa: ${gl.getProgramInfoLog(prog)}`);
    }
    this.prog = prog;
    gl.useProgram(prog);

    this.u = {};
    for (const name of UNIFORMS) this.u[name] = gl.getUniformLocation(prog, name);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Píxel negro inicial para poder pintar sin vídeo cargado.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.hasFrame = false;
    this._wrapRepeat = false;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    this.scaledTo = null;
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.u.uTex, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /** Envuelve horizontalmente la textura (sin costura visible en equirect). */
  setSeamlessWrap(on) {
    const want = !!on && this.isWebGL2;
    if (want === this._wrapRepeat) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, want ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    this._wrapRepeat = want;
  }

  /**
   * Reduce el fotograma cuando el vídeo es más grande que la textura máxima
   * que admite la GPU (habitual con 360 de 5.7K/8K en equipos con límite 4096).
   */
  _fit(video) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    const max = this.maxTex;
    if (!w || !h || (w <= max && h <= max)) {
      this.scaledTo = null;
      return video;
    }
    const s = Math.min(max / w, max / h);
    const tw = Math.max(2, Math.floor((w * s) / 2) * 2);
    const th = Math.max(2, Math.floor((h * s) / 2) * 2);
    if (!this._scratch) {
      this._scratch = document.createElement('canvas');
      this._scratchCtx = this._scratch.getContext('2d', { alpha: false, desynchronized: true });
    }
    if (this._scratch.width !== tw || this._scratch.height !== th) {
      this._scratch.width = tw;
      this._scratch.height = th;
    }
    this._scratchCtx.drawImage(video, 0, 0, tw, th);
    this.scaledTo = `${tw}x${th}`;
    return this._scratch;
  }

  /** Sube el fotograma actual del elemento <video> a la textura. */
  uploadFrame(video) {
    if (this.contextLost || !video || video.readyState < 2) return this.hasFrame;
    const gl = this.gl;
    const source = this._fit(video);
    // Solo se consulta el estado de WebGL cuando cambia el tamaño de la fuente:
    // es el único caso en el que texImage2D puede rechazar el fotograma (y no
    // lanza excepción, hay que preguntar explícitamente).
    const sig = `${video.videoWidth}x${video.videoHeight}`;
    const verify = sig !== this._checkedSize;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      if (verify) while (gl.getError()) { /* vacía errores anteriores */ }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      if (verify) {
        const code = gl.getError();
        this._checkedSize = sig;
        if (code) {
          this.lastError = new Error(`WebGL rechazó el fotograma (código ${code}): ${sig}, máximo ${this.maxTex} px.`);
          this.hasFrame = false;
          return false;
        }
      }
      this.hasFrame = true;
    } catch (err) {
      // Vídeo remoto sin CORS: la textura quedaría contaminada.
      this.lastError = err;
      this.hasFrame = false;
    }
    return this.hasFrame;
  }

  resize(w, h) {
    const cw = Math.max(2, Math.round(w));
    const ch = Math.max(2, Math.round(h));
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
  }

  /** Uniformes comunes a partir del estado de la aplicación. */
  _applyState(state) {
    const gl = this.gl;
    const u = this.u;
    const inMode = IN_MODE[state.inMode] ?? IN_MODE.flat;
    gl.useProgram(this.prog);
    gl.uniform1i(u.uInMode, inMode);
    gl.uniform1i(u.uLayout, LAYOUT[state.layout] ?? 0);
    gl.uniform1f(u.uSrcAspect, state.srcAspect || 16 / 9);
    gl.uniform1f(u.uFishFov, (state.fishFov ?? 190) * DEG);
    gl.uniform1f(u.uFishScale, state.fishScale ?? 1);
    gl.uniform1f(u.uFishBlend, (state.fishBlend ?? 6) * DEG);
    gl.uniform1f(u.uZoom, state.zoom ?? 1);
    gl.uniform2f(u.uPan, state.panX ?? 0, state.panY ?? 0);
    this.setSeamlessWrap(inMode === IN_MODE.equirect360 && (LAYOUT[state.layout] ?? 0) !== LAYOUT.sbs);
  }

  /**
   * Dibuja la vista en el lienzo. Si state.stereoView es true pinta dos
   * viewports (izquierda/derecha) para visores tipo cardboard.
   */
  render(state) {
    if (this.contextLost) return;
    const gl = this.gl;
    const u = this.u;
    const W = this.canvas.width;
    const H = this.canvas.height;

    this._applyState(state);
    gl.uniform1i(u.uOutMode, OUT_MODE[state.outMode] ?? OUT_MODE.rect);
    gl.uniform1f(u.uFov, (state.fov ?? 90) * DEG);
    gl.uniformMatrix3fv(u.uRot, false, orientationMatrix(state.yaw, state.pitch, state.roll));

    gl.clearColor(0, 0, 0, 1);
    gl.viewport(0, 0, W, H);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (state.stereoView) {
      const hw = Math.floor(W / 2);
      gl.uniform1f(u.uAspect, hw / H);
      for (let eye = 0; eye < 2; eye++) {
        gl.viewport(eye * hw, 0, hw, H);
        gl.uniform1f(u.uEye, state.layout === 'mono' ? 0 : eye);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    } else {
      gl.uniform1f(u.uAspect, W / H);
      gl.uniform1f(u.uEye, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  /** Dibuja una vista de WebXR usando su matriz de proyección. */
  renderXRView(state, viewport, invProj, rotMat, eye) {
    if (this.contextLost) return;
    const gl = this.gl;
    const u = this.u;
    this._applyState(state);
    gl.uniform1i(u.uOutMode, OUT_MODE.xr);
    gl.uniform1f(u.uAspect, viewport.width / viewport.height);
    gl.uniform1f(u.uEye, state.layout === 'mono' ? 0 : eye);
    gl.uniformMatrix4fv(u.uInvProj, false, invProj);
    gl.uniformMatrix3fv(u.uRot, false, rotMat);
    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
