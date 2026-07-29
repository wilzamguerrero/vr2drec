/**
 * Grabación de la vista ya reproyectada.
 *
 * El lienzo WebGL es la fuente de vídeo (canvas.captureStream) y el audio se
 * toma del elemento <video> a través de la Web Audio API. Todo ocurre en el
 * navegador: no se envía nada a ningún servidor.
 */

const CANDIDATES = [
  { mime: 'video/mp4;codecs=avc1.4d002a,mp4a.40.2', label: 'MP4 · H.264 + AAC', ext: 'mp4' },
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', label: 'MP4 · H.264 base + AAC', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', label: 'WebM · VP9 + Opus', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', label: 'WebM · VP8 + Opus', ext: 'webm' },
  { mime: 'video/webm;codecs=h264,opus', label: 'WebM · H.264 + Opus', ext: 'webm' },
  { mime: 'video/mp4', label: 'MP4 (por defecto del navegador)', ext: 'mp4' },
  { mime: 'video/webm', label: 'WebM (por defecto del navegador)', ext: 'webm' },
];

/** Formatos que este navegador puede grabar, en orden de preferencia. */
export function supportedFormats() {
  if (typeof MediaRecorder === 'undefined') return [];
  return CANDIDATES.filter((c) => {
    try { return MediaRecorder.isTypeSupported(c.mime); } catch { return false; }
  });
}

export function extForMime(mime = '') {
  return mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : 'bin';
}

/**
 * Enruta el audio del <video> hacia el grabador.
 * La escucha pasa por un GainNode propio para que bajar el volumen o silenciar
 * el reproductor no afecte a lo que se está grabando.
 */
class AudioBus {
  constructor(video) {
    this.video = video;
    this.ctx = null;
    this.dest = null;
    this.gain = null;
    this.failed = false;
    this.monitor = 1;
  }

  get active() { return !!this.ctx && !this.failed; }

  ensure() {
    if (this.failed) return null;
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error('sin Web Audio');
        this.ctx = new Ctx();
        this.node = this.ctx.createMediaElementSource(this.video);
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.monitor;
        this.dest = this.ctx.createMediaStreamDestination();
        this.node.connect(this.gain);
        this.gain.connect(this.ctx.destination);
        this.node.connect(this.dest);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.dest.stream;
    } catch (err) {
      this.failed = true;
      this.error = err;
      return null;
    }
  }

  /** Volumen de escucha (no afecta a la grabación). */
  setMonitorGain(v) {
    this.monitor = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.monitor;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }
}

export class ViewRecorder {
  /**
   * @param {HTMLCanvasElement} canvas lienzo con la vista plana
   * @param {HTMLVideoElement} video fuente de audio
   */
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.bus = new AudioBus(video);
    this.recorder = null;
    this.chunks = [];
    this.warnings = [];
  }

  get recording() {
    return !!this.recorder && this.recorder.state === 'recording';
  }

  /** True si el audio ya pasa por la Web Audio API. */
  get audioRouted() { return this.bus.active; }

  resumeAudio() { this.bus.resume(); }

  setMonitorGain(v) { this.bus.setMonitorGain(v); }

  /**
   * @param {{fps?:number, bitrate?:number, audio?:boolean, mime?:string}} opts
   */
  start(opts = {}) {
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Este navegador no soporta MediaRecorder.');
    }
    if (this.recording) throw new Error('Ya se está grabando.');

    const formats = supportedFormats();
    if (!formats.length) throw new Error('El navegador no ofrece ningún formato de grabación.');
    const mime = opts.mime && formats.some((f) => f.mime === opts.mime) ? opts.mime : formats[0].mime;
    const fps = Math.max(1, Math.min(120, opts.fps || 30));

    this.warnings = [];
    const stream = this.canvas.captureStream(fps);
    if (opts.audio !== false) {
      const audioStream = this.bus.ensure();
      const track = audioStream && audioStream.getAudioTracks()[0];
      if (track) stream.addTrack(track);
      else this.warnings.push('No se pudo capturar el audio (¿vídeo remoto sin CORS?); se graba solo vídeo.');
    }

    const options = { mimeType: mime };
    if (opts.bitrate) options.videoBitsPerSecond = Math.round(opts.bitrate);
    options.audioBitsPerSecond = 128000;

    this.stream = stream;
    this.mime = mime;
    this.ext = extForMime(mime);
    this.chunks = [];
    this.startedAt = performance.now();

    const rec = new MediaRecorder(stream, options);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this._done = new Promise((resolve, reject) => {
      rec.onstop = () => resolve();
      rec.onerror = (e) => reject(e.error || new Error('Fallo durante la grabación.'));
    });
    this.recorder = rec;
    rec.start(1000);
    return { mime, ext: this.ext, warnings: this.warnings };
  }

  /** Detiene y devuelve el archivo resultante. */
  async stop() {
    const rec = this.recorder;
    if (!rec) return null;
    if (rec.state !== 'inactive') rec.stop();
    await this._done;
    this.recorder = null;
    for (const t of this.stream ? this.stream.getVideoTracks() : []) t.stop();
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = [];
    return {
      blob,
      url: URL.createObjectURL(blob),
      mime: this.mime,
      ext: this.ext,
      size: blob.size,
      duration: (performance.now() - this.startedAt) / 1000,
    };
  }
}
