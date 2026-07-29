import { Renderer } from './gl/renderer.js';
import { CameraController } from './core/controls.js';
import { SourceManager, detectProjection, proxyUrl } from './core/source.js';
import { KeyframeTrack } from './core/keyframes.js';
import { ViewRecorder, supportedFormats } from './core/recorder.js';
import { XRPresenter, xrSupported } from './core/xr.js';
import { WindowManager } from './ui/windows.js';
import { CropTool, cropToOutSize, cropCamera, cropFlat } from './ui/crop.js';
import { clamp } from './gl/math.js';

const $ = (id) => document.getElementById(id);

const el = {
  stage: $('stage'), frame: $('frame'), canvas: $('gl'), video: $('video'),
  empty: $('emptyState'), dropHint: $('dropHint'), toast: $('toast'),
  recBadge: $('recBadge'), recBadgeText: $('recBadgeText'), hud: $('hud'),
  chipFormat: $('chipFormat'),
  btnPlay: $('btnPlay'), seek: $('seek'), timeCur: $('timeCur'), timeDur: $('timeDur'),
  btnMute: $('btnMute'), rngVol: $('rngVol'), selSpeed: $('selSpeed'), chkLoop: $('chkLoop'),
  btnSnapshot: $('btnSnapshot'), btnRec: $('btnRec'), btnRec2: $('btnRec2'),
  btnFull: $('btnFull'), btnXR: $('btnXR'),
  cropOverlay: $('cropOverlay'), cropBox: $('cropBox'), cropSize: $('cropSize'),
  cropBar: $('cropBar'), btnCropMode: $('btnCropMode'), selCropAspect: $('selCropAspect'),
  chkCropCam: $('chkCropCam'), outCropInfo: $('outCropInfo'),
  btnCropApply: $('btnCropApply'), btnCropFull: $('btnCropFull'), btnCropClose: $('btnCropClose'),
  fileInput: $('fileInput'), urlInput: $('urlInput'), btnAddUrl: $('btnAddUrl'),
  urlStatus: $('urlStatus'), btnUseProxy: $('btnUseProxy'),
  playlist: $('playlist'),
  infoRes: $('infoRes'), infoAspect: $('infoAspect'), infoDur: $('infoDur'), infoProj: $('infoProj'),
  infoFrames: $('infoFrames'), infoTex: $('infoTex'), infoBuf: $('infoBuf'),
  chkVR: $('chkVR'), selInput: $('selInput'), selLayout: $('selLayout'),
  fldFish: $('fldFish'), rngFishFov: $('rngFishFov'), outFishFov: $('outFishFov'),
  rngFishScale: $('rngFishScale'), outFishScale: $('outFishScale'),
  rngFishBlend: $('rngFishBlend'), outFishBlend: $('outFishBlend'),
  selOut: $('selOut'), fldFov: $('fldFov'), rngFov: $('rngFov'), outFov: $('outFov'),
  numYaw: $('numYaw'), numPitch: $('numPitch'), numRoll: $('numRoll'), rngSens: $('rngSens'),
  btnResetView: $('btnResetView'), btnLevel: $('btnLevel'),
  chkStereoView: $('chkStereoView'), chkGyro: $('chkGyro'), chkInertia: $('chkInertia'),
  chkFollow: $('chkFollow'), btnAddKf: $('btnAddKf'), btnClearKf: $('btnClearKf'),
  selEase: $('selEase'), kfList: $('kfList'),
  selRes: $('selRes'), numW: $('numW'), numH: $('numH'),
  selFps: $('selFps'), numBitrate: $('numBitrate'), selCodec: $('selCodec'), chkAudio: $('chkAudio'),
  numIn: $('numIn'), numOut: $('numOut'), btnSetIn: $('btnSetIn'), btnSetOut: $('btnSetOut'),
  btnExportRange: $('btnExportRange'), recStatus: $('recStatus'), results: $('results'),
};

const video = el.video;

/** Estado de proyección (entrada y salida). */
const proj = {
  inMode: 'flat',
  layout: 'mono',
  outMode: 'rect',
  fishFov: 190,
  fishScale: 1,
  fishBlend: 6,
  stereoView: false,
  srcAspect: 16 / 9,
};

/** Formato de salida: lo que se ve en el marco y lo que se graba. */
const out = { w: 1920, h: 1080 };

let recording = false;
let exportJob = null;
let scrubbing = false;
let detected = null;
let cropMode = false;

/* ---------------------------------------------------------------- núcleo */

let renderer;
try {
  renderer = new Renderer(el.canvas);
} catch (err) {
  fatal(err.message);
  throw err;
}

const cam = new CameraController(el.canvas, { onChange: syncCamInputs });
const sources = new SourceManager(video, renderPlaylist);
const track = new KeyframeTrack(renderKeyframes);
const recorder = new ViewRecorder(el.canvas, video);
const xr = new XRPresenter(renderer, video, renderState, {
  onStart: () => { el.btnXR.textContent = 'Salir de VR'; },
  onEnd: () => { el.btnXR.textContent = 'Gafas VR'; layoutFrame(); },
});
const windows = new WindowManager($('windows'), document.querySelectorAll('[data-win]'));
const crop = new CropTool(el.cropOverlay, el.cropBox, { onChange: updateCropInfo });

/** Estado completo que consume el shader. */
function renderState() {
  const planet = proj.outMode === 'planet';
  return {
    inMode: proj.inMode,
    layout: proj.layout,
    outMode: planet ? 'stereo' : proj.outMode,
    fov: cam.fov,
    yaw: cam.yaw,
    pitch: planet ? cam.pitch - 90 : cam.pitch,
    roll: cam.roll,
    srcAspect: proj.srcAspect,
    fishFov: proj.fishFov,
    fishScale: proj.fishScale,
    fishBlend: proj.fishBlend,
    zoom: cam.zoom,
    panX: cam.panX,
    panY: cam.panY,
    stereoView: proj.stereoView && proj.inMode !== 'flat',
  };
}

/* ------------------------------------------------------------- utilidades */

function fatal(msg) {
  el.empty.textContent = `No se puede iniciar: ${msg}`;
  document.body.classList.remove('has-video');
}

let toastTimer = 0;
function toast(msg, ms = 3600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

/** Etiqueta legible de una relación de aspecto. */
function ratioLabel(a) {
  const known = [
    [16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [4 / 3, '4:3'], [3 / 4, '3:4'],
    [4 / 5, '4:5'], [5 / 4, '5:4'], [2, '2:1'], [2.39, '2.39:1'], [21 / 9, '21:9'],
  ];
  for (const [v, label] of known) if (Math.abs(a - v) < 0.015) return label;
  return `${a.toFixed(2)}:1`;
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* --------------------------------------------------- marco y tamaño de salida */

/** Tamaño en píxeles CSS del marco de salida encajado en el escenario. */
function frameBox() {
  const sw = Math.max(120, el.stage.clientWidth - 10);
  const sh = Math.max(80, el.stage.clientHeight - 10);
  const a = out.w / out.h;
  let w = sw;
  let h = sw / a;
  if (h > sh) { h = sh; w = sh * a; }
  return { w: Math.floor(w), h: Math.floor(h) };
}

function layoutFrame() {
  if (xr.active) return;
  const b = frameBox();
  el.frame.style.width = `${b.w}px`;
  el.frame.style.height = `${b.h}px`;
  el.canvas.style.width = `${b.w}px`;
  el.canvas.style.height = `${b.h}px`;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = recording ? 1 : Math.min(1, (b.w * dpr) / out.w, (b.h * dpr) / out.h);
  renderer.resize(Math.round(out.w * scale), Math.round(out.h * scale));

  el.chipFormat.textContent = `${out.w}×${out.h} · ${ratioLabel(out.w / out.h)}`;
  crop.layout();
  updateCropInfo(crop.rect);
}

if (window.ResizeObserver) {
  new ResizeObserver(() => layoutFrame()).observe(el.stage);
} else {
  window.addEventListener('resize', layoutFrame);
}

function setOutSize(w, h) {
  out.w = clamp(Math.round(w / 2) * 2, 64, 7680);
  out.h = clamp(Math.round(h / 2) * 2, 64, 7680);
  el.numW.value = out.w;
  el.numH.value = out.h;
  layoutFrame();
}

/* --------------------------------------------------------------- bucle */

let lastT = performance.now();
let fpsAvg = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.25, Math.max(0.0001, (now - lastT) / 1000));
  lastT = now;
  const fps = Math.min(240, 1 / dt);
  fpsAvg = fpsAvg ? fpsAvg * 0.9 + fps * 0.1 : fps;

  if (xr.active) return; // la sesión XR pinta por su cuenta

  if (el.chkFollow.checked && track.length && !cam.dragging) {
    const v = track.sample(video.currentTime, el.selEase.value);
    if (v) cam.set(v);
  }
  cam.update(dt);
  drawFrame();
  updateHud();
  updateDiagnostics(now);

  if (exportJob && video.currentTime >= exportJob.end - 0.02) finishRecording('Tramo exportado.');
}

function drawFrame() {
  renderer.uploadFrame(video);
  renderer.render(renderState());
}

function updateHud() {
  el.hud.textContent =
    `${el.canvas.width}x${el.canvas.height} @ ${Math.round(fpsAvg)}fps` +
    (renderer.scaledTo ? ` · fuente reducida a ${renderer.scaledTo}` : '') + '\n' +
    `yaw ${cam.yaw.toFixed(1)}° pitch ${cam.pitch.toFixed(1)}° roll ${cam.roll.toFixed(1)}° fov ${Math.round(cam.fov)}°`;
}

/* Vigilancia: si el vídeo avanza pero no llega ningún fotograma a la GPU,
   avisa con la causa más probable en lugar de dejar la pantalla en negro. */
let blindSince = 0;
let blindWarned = false;
let statsAt = 0;

function updateDiagnostics(now) {
  if (now - statsAt < 500) return;
  statsAt = now;

  if (!sources.current) {
    el.infoFrames.textContent = '—';
    el.infoBuf.textContent = '—';
    return;
  }

  el.infoTex.textContent = `${renderer.maxTex} px`;
  const big = video.videoWidth > renderer.maxTex || video.videoHeight > renderer.maxTex;
  el.infoFrames.textContent = renderer.hasFrame
    ? (renderer.scaledTo ? `sí, reducidos a ${renderer.scaledTo}` : 'sí')
    : 'no llegan';

  const b = video.buffered;
  if (b && b.length && isFinite(video.duration) && video.duration) {
    const end = b.end(b.length - 1);
    el.infoBuf.textContent = `${fmtTime(end)} (${Math.round((end / video.duration) * 100)}%)`;
  } else {
    el.infoBuf.textContent = '—';
  }

  const advancing = !video.paused && video.readyState >= 2;
  if (advancing && !renderer.hasFrame) {
    if (!blindSince) blindSince = now;
    if (now - blindSince > 3000 && !blindWarned) {
      blindWarned = true;
      const why = big
        ? `el vídeo mide ${video.videoWidth}×${video.videoHeight} y esta GPU admite hasta ${renderer.maxTex} px por textura`
        : (renderer.lastError ? renderer.lastError.message : 'el navegador no entrega fotogramas descodificados');
      toast(`Se reproduce pero no hay imagen: ${why}. Prueba una versión de menor resolución del vídeo.`, 11000);
      setUrlStatus(`Sin imagen: ${why}.`);
    }
  } else if (renderer.hasFrame) {
    blindSince = 0;
    blindWarned = false;
  }
}

requestAnimationFrame(loop);

/* ------------------------------------------------------------- proyección */

function syncProjectionUI() {
  const spherical = proj.inMode !== 'flat';
  cam.spherical = spherical;
  el.canvas.classList.toggle('flat', !spherical);
  el.chkVR.checked = spherical;
  el.fldFish.hidden = !(proj.inMode === 'fisheye_dual' || proj.inMode === 'fisheye_single');
  el.fldFov.hidden = !spherical || proj.outMode === 'equirect';
  el.rngFov.max = proj.outMode === 'rect' ? '170' : '340';
  el.selLayout.value = proj.layout;
  el.selOut.disabled = !spherical;
  el.chkStereoView.disabled = !spherical;
  el.chkGyro.disabled = !spherical;
}

function setInMode(mode, layout) {
  proj.inMode = mode;
  if (layout) proj.layout = layout;
  syncProjectionUI();
}

function autoDetect() {
  const item = sources.current;
  detected = detectProjection(item ? item.name : '', video.videoWidth, video.videoHeight);
  el.infoProj.textContent = detected.label;
  if (el.selInput.value === 'auto') setInMode(detected.inMode, detected.layout);
}

el.selInput.addEventListener('change', () => {
  if (el.selInput.value === 'auto') autoDetect();
  else setInMode(el.selInput.value);
});

el.selLayout.addEventListener('change', () => { proj.layout = el.selLayout.value; });

el.chkVR.addEventListener('change', () => {
  if (el.chkVR.checked) {
    const f = detected && detected.inMode !== 'flat' ? detected : { inMode: 'equirect360', layout: 'mono' };
    setInMode(f.inMode, f.layout);
    el.selInput.value = f.inMode;
  } else {
    setInMode('flat', 'mono');
    el.selInput.value = 'flat';
  }
});

el.selOut.addEventListener('change', () => {
  proj.outMode = el.selOut.value;
  if (proj.outMode === 'planet') cam.set({ fov: 320 });
  else if (proj.outMode === 'stereo' && cam.fov < 150) cam.set({ fov: 180 });
  else if (proj.outMode === 'rect' && cam.fov > 170) cam.set({ fov: 100 });
  syncProjectionUI();
  syncCamInputs();
});

el.rngFov.addEventListener('input', () => cam.set({ fov: Number(el.rngFov.value) }));
el.rngSens.addEventListener('input', () => { cam.sensitivity = Number(el.rngSens.value); });
el.chkInertia.addEventListener('change', () => { cam.inertia = el.chkInertia.checked; });
el.chkStereoView.addEventListener('change', () => { proj.stereoView = el.chkStereoView.checked; });

for (const [range, output, key, fmt] of [
  [el.rngFishFov, el.outFishFov, 'fishFov', (v) => `${v}°`],
  [el.rngFishScale, el.outFishScale, 'fishScale', (v) => Number(v).toFixed(3)],
  [el.rngFishBlend, el.outFishBlend, 'fishBlend', (v) => `${v}°`],
]) {
  range.addEventListener('input', () => {
    proj[key] = Number(range.value);
    output.textContent = fmt(range.value);
  });
}

for (const [input, key] of [[el.numYaw, 'yaw'], [el.numPitch, 'pitch'], [el.numRoll, 'roll']]) {
  input.addEventListener('input', () => cam.set({ [key]: Number(input.value) || 0 }));
}

el.btnResetView.addEventListener('click', () => cam.reset());
el.btnLevel.addEventListener('click', () => cam.level());

el.chkGyro.addEventListener('change', async () => {
  try {
    await cam.setGyro(el.chkGyro.checked);
  } catch (err) {
    el.chkGyro.checked = false;
    toast(err.message);
  }
});

function syncCamInputs() {
  const round = (v) => Math.round(v * 10) / 10;
  if (document.activeElement !== el.numYaw) el.numYaw.value = round(cam.yaw);
  if (document.activeElement !== el.numPitch) el.numPitch.value = round(cam.pitch);
  if (document.activeElement !== el.numRoll) el.numRoll.value = round(cam.roll);
  el.rngFov.value = Math.round(clamp(cam.fov, 10, Number(el.rngFov.max) || 170));
  el.outFov.textContent = `${Math.round(cam.fov)}°`;
}

/* ------------------------------------------------------ recorte de salida */

function updateCropInfo(rect) {
  const size = cropToOutSize(rect, out);
  const label = `${size.w}×${size.h} · ${ratioLabel(size.w / size.h)}`;
  el.outCropInfo.textContent = label;
  el.cropSize.textContent = label;
}

function setCropMode(on) {
  cropMode = !!on;
  document.body.classList.toggle('cropping', cropMode);
  el.cropBar.hidden = !cropMode;
  el.btnCropMode.setAttribute('aria-pressed', String(cropMode));
  cam.enabled = !cropMode;
  if (cropMode) {
    crop.enable();
    crop.full();
    el.cropBox.focus({ preventScroll: true });
    toast('Arrastra el marco para elegir el área de salida y pulsa Aplicar.', 5000);
  } else {
    crop.disable();
  }
  layoutFrame();
}

function applyCrop() {
  if (recording) return toast('No se puede recortar mientras se graba.');
  const r = { ...crop.rect };
  if (r.w > 0.995 && r.h > 0.995) return toast('El marco ya ocupa toda la imagen.');

  const size = cropToOutSize(r, out);
  const aspect = out.w / out.h;

  if (el.chkCropCam.checked) {
    if (proj.inMode === 'flat') {
      cam.set(cropFlat(r, cam));
    } else if (proj.outMode === 'equirect') {
      toast('En salida equirectangular el recorte solo cambia el tamaño.', 4200);
    } else {
      const planet = proj.outMode === 'planet';
      const eff = { yaw: cam.yaw, pitch: planet ? cam.pitch - 90 : cam.pitch, roll: cam.roll, fov: cam.fov };
      const res = cropCamera(r, eff, aspect, planet ? 'stereo' : proj.outMode);
      cam.set({ yaw: res.yaw, pitch: planet ? res.pitch + 90 : res.pitch, fov: res.fov });
    }
  }

  setOutSize(size.w, size.h);
  el.selRes.value = 'custom';
  crop.full();
  toast(`Salida ${out.w}×${out.h} (${ratioLabel(out.w / out.h)}).`);
}

el.btnCropMode.addEventListener('click', () => setCropMode(!cropMode));
el.btnCropClose.addEventListener('click', () => setCropMode(false));
el.btnCropFull.addEventListener('click', () => crop.full());
el.btnCropApply.addEventListener('click', applyCrop);
el.selCropAspect.addEventListener('change', () => {
  const v = el.selCropAspect.value;
  crop.setAspect(v === 'free' ? null : Number(v));
});

/* ----------------------------------------------------------------- fuentes */

function renderPlaylist(items, current) {
  el.playlist.textContent = '';
  document.body.classList.toggle('has-video', !!current);

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty-list';
    li.textContent = 'Todavía no hay vídeos.';
    el.playlist.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    if (current && item.id === current.id) li.className = 'active';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'name icon-btn';
    btn.style.textAlign = 'left';
    btn.textContent = item.name;
    btn.title = item.kind === 'url' ? item.url : `${item.name} · ${fmtSize(item.size || 0)}`;
    btn.addEventListener('click', () => sources.select(item.id));

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = item.proxied ? 'proxy' : item.kind === 'url' ? 'URL' : 'local';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.title = 'Quitar de la lista';
    del.setAttribute('aria-label', `Quitar ${item.name}`);
    del.addEventListener('click', () => sources.remove(item.id));

    li.append(btn, badge, del);
    el.playlist.appendChild(li);
  }
}

el.fileInput.addEventListener('change', () => {
  const added = sources.addFiles(el.fileInput.files);
  if (added.length) toast(`${added.length} vídeo(s) abiertos en local.`);
  el.fileInput.value = '';
});

el.btnAddUrl.addEventListener('click', () => {
  try {
    sources.addUrl(el.urlInput.value);
    el.urlInput.value = '';
  } catch (err) {
    toast(err.message);
  }
});
el.urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.btnAddUrl.click(); });

/* arrastrar y soltar: aviso discreto que se apaga solo */
let dropTimer = 0;
const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

function pingDrop() {
  el.dropHint.hidden = false;
  clearTimeout(dropTimer);
  dropTimer = setTimeout(() => { el.dropHint.hidden = true; }, 700);
}
function hideDrop() {
  clearTimeout(dropTimer);
  el.dropHint.hidden = true;
}

for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    pingDrop();
  });
}
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) hideDrop(); });
window.addEventListener('dragend', hideDrop);
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer) return;
  e.preventDefault();
  hideDrop();
  const files = [...e.dataTransfer.files]
    .filter((f) => /^video\//.test(f.type) || /\.(mp4|webm|mov|mkv|m4v|insv|insp|avi)$/i.test(f.name));
  if (files.length) {
    sources.addFiles(files);
    return;
  }
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (url) {
    try { sources.addUrl(url); } catch (err) { toast(err.message); }
  } else {
    toast('Eso no parece un vídeo.');
  }
});

/* ------------------------------------------------------------ reproductor */

video.addEventListener('loadedmetadata', () => {
  proj.srcAspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  el.infoRes.textContent = `${video.videoWidth} × ${video.videoHeight}`;
  el.infoAspect.textContent = proj.srcAspect.toFixed(3);
  el.infoDur.textContent = fmtTime(video.duration);
  el.timeDur.textContent = fmtTime(video.duration);
  el.numOut.value = isFinite(video.duration) ? video.duration.toFixed(1) : 0;
  el.numIn.value = 0;
  autoDetect();
  document.body.classList.add('has-video');
  hideDrop();
  layoutFrame();
  blindSince = 0;
  blindWarned = false;
  el.infoTex.textContent = `${renderer.maxTex} px`;
  if (video.videoWidth > renderer.maxTex || video.videoHeight > renderer.maxTex) {
    toast(`El vídeo (${video.videoWidth}×${video.videoHeight}) supera el límite de textura de la GPU (${renderer.maxTex} px): se reducirá para poder verlo.`, 8000);
  }
  const item = sources.current;
  if (item && item.kind === 'url') {
    setUrlStatus(item.proxied
      ? 'Cargado a través del proxy local: el servidor remoto no enviaba CORS.'
      : 'Cargado directamente desde el servidor remoto.');
  } else {
    setUrlStatus('');
  }
});

/* ------------------------------------- diagnóstico de fuentes remotas */

const MEDIA_ERR = {
  1: 'carga interrumpida',
  2: 'error de red',
  3: 'no se pudo decodificar el flujo',
  4: 'el navegador rechaza la fuente (códec no soportado o respuesta bloqueada por CORS)',
};

const HTTP_HINT = {
  401: 'el servidor pide autenticación (401).',
  403: 'acceso denegado (403). Los enlaces con firma y parámetro de caducidad dejan de valer en minutos: vuelve a copiar el enlace, o descarga el archivo y ábrelo como archivo local.',
  404: 'el archivo no existe en esa ruta (404).',
  410: 'el enlace ha caducado (410).',
  429: 'demasiadas peticiones (429): el servidor está limitando el acceso.',
};

let proxyOk = false;

/**
 * ¿Está disponible el proxy del servidor local?
 * Solo se memoriza el resultado positivo: así, si arrancas de nuevo el servidor,
 * basta reintentar sin recargar la página.
 */
async function proxyState() {
  if (proxyOk) return { ok: true };
  try {
    const r = await fetch('/proxy?ping=1', { cache: 'no-store' });
    if (r.ok) {
      proxyOk = true;
      return { ok: true };
    }
    if (r.status === 404) {
      return { ok: false, reason: 'el servidor que sirve esta página no tiene la ruta /proxy (responde 404). Si lo tenías abierto desde antes de actualizar, párralo con Ctrl+C y vuelve a lanzar "node server.js".' };
    }
    if (r.status === 403) {
      return { ok: false, reason: 'el proxy está desactivado (VR2DREC_PROXY=0). Relanza "node server.js" sin esa variable.' };
    }
    return { ok: false, reason: `el proxy responde HTTP ${r.status}.` };
  } catch {
    return { ok: false, reason: 'no hay servidor local que responda (¿has abierto el archivo directamente o con otro servidor?). Lanza "node server.js" y abre http://localhost:5173.' };
  }
}

/** Comprueba la URL a través del proxy local, que sí ve la respuesta real. */
async function probeThroughProxy(url) {
  try {
    const r = await fetch(proxyUrl(url), { headers: { Range: 'bytes=0-1' }, cache: 'no-store' });
    if (r.status === 502 || r.status === 508) {
      let msg = 'no se pudo conectar';
      try { msg = (await r.json()).error || msg; } catch { /* sin cuerpo JSON */ }
      return { error: msg };
    }
    return {
      status: Number(r.headers.get('x-proxy-status')) || r.status,
      type: (r.headers.get('content-type') || '').toLowerCase(),
    };
  } catch (err) {
    return { error: err.message };
  }
}

function setUrlStatus(msg) {
  el.urlStatus.textContent = msg || '';
  const item = sources.current;
  el.btnUseProxy.hidden = !(item && item.kind === 'url' && !item.proxied);
}

async function diagnoseSource() {
  const item = sources.current;
  if (!item) return;
  const base = MEDIA_ERR[video.error && video.error.code] || 'error desconocido';

  if (item.kind === 'file') {
    const msg = `${item.name}: ${base}. Los .insv/.insp de Insta360 solo se abren si el vídeo interno es H.264/H.265 que el navegador sepa decodificar.`;
    setUrlStatus(msg);
    toast(msg, 7000);
    return;
  }

  if (item.proxied) {
    const msg = `${item.name}: ni con el proxy local se puede reproducir (${base}). Puede ser un códec que el navegador no decodifica.`;
    setUrlStatus(msg);
    toast(msg, 7000);
    return;
  }

  toast(`No se pudo abrir ${item.name} (${base}). Comprobando el servidor remoto…`, 5000);
  setUrlStatus('Comprobando el servidor remoto…');

  const proxy = await proxyState();
  if (!proxy.ok) {
    const msg = `${base}. Esa URL necesita cabeceras CORS y el proxy local no está disponible: ${proxy.reason} Mientras tanto, descarga el archivo y ábrelo con Abrir archivos.`;
    setUrlStatus(msg);
    toast(msg, 10000);
    return;
  }

  const info = await probeThroughProxy(item.remote);
  if (info.error) {
    const msg = `El servidor remoto no responde: ${info.error}.`;
    setUrlStatus(msg);
    toast(msg, 7000);
    return;
  }
  if (info.status >= 400) {
    const msg = HTTP_HINT[info.status] || `el servidor responde HTTP ${info.status}.`;
    setUrlStatus(`No es un problema de vr2drec: ${msg}`);
    toast(msg, 9000);
    return;
  }
  if (info.type && !/^video\/|^application\/(octet-stream|vnd\.apple\.mpegurl|x-mpegurl)/.test(info.type)) {
    const extra = /mpegurl/.test(info.type) ? ' Es una lista HLS (.m3u8) y este reproductor solo abre archivos de vídeo directos.' : '';
    const msg = `El servidor devuelve "${info.type}" en vez de un vídeo (¿página de bloqueo o enlace caducado?).${extra}`;
    setUrlStatus(msg);
    toast(msg, 9000);
    return;
  }

  // El archivo existe y es vídeo: lo que faltaba era CORS. Reintento por proxy.
  setUrlStatus(`El archivo existe (HTTP ${info.status}, ${info.type || 'tipo desconocido'}) pero el servidor no envía CORS. Reintentando a través del proxy local…`);
  toast('El servidor remoto no envía CORS: reintentando por el proxy local.', 6000);
  sources.useProxy(item.id);
}

video.addEventListener('error', () => { diagnoseSource().catch(() => {}); });

el.btnUseProxy.addEventListener('click', async () => {
  const item = sources.current;
  if (!item || item.kind !== 'url') return toast('Selecciona primero una URL de la lista.');
  if (item.proxied) return toast('Ya se está usando el proxy local.');
  const proxy = await proxyState();
  if (!proxy.ok) {
    const msg = `Proxy no disponible: ${proxy.reason}`;
    setUrlStatus(msg);
    return toast(msg, 10000);
  }
  setUrlStatus('Cargando a través del proxy local…');
  sources.useProxy(item.id);
});

video.addEventListener('timeupdate', () => {
  el.timeCur.textContent = fmtTime(video.currentTime);
  if (!scrubbing && isFinite(video.duration) && video.duration > 0) {
    el.seek.value = Math.round((video.currentTime / video.duration) * 1000);
  }
});

video.addEventListener('play', () => {
  el.btnPlay.textContent = '❚❚';
  el.btnPlay.setAttribute('aria-label', 'Pausar');
  recorder.resumeAudio();
});
video.addEventListener('pause', () => {
  el.btnPlay.textContent = '▶';
  el.btnPlay.setAttribute('aria-label', 'Reproducir');
});
video.addEventListener('ended', () => {
  if (exportJob) finishRecording('Exportación terminada al final del vídeo.');
});

function togglePlay() {
  if (!sources.current) return toast('Carga primero un vídeo.');
  if (video.paused) video.play().catch((err) => toast(`No se pudo reproducir: ${err.message}`));
  else video.pause();
}

el.btnPlay.addEventListener('click', togglePlay);

el.seek.addEventListener('pointerdown', () => { scrubbing = true; });
el.seek.addEventListener('pointerup', () => { scrubbing = false; });
el.seek.addEventListener('input', () => {
  if (!isFinite(video.duration)) return;
  video.currentTime = (Number(el.seek.value) / 1000) * video.duration;
  el.timeCur.textContent = fmtTime(video.currentTime);
});

function applyVolume() {
  const v = Number(el.rngVol.value);
  const muted = el.btnMute.dataset.muted === '1';
  const gain = muted ? 0 : v;
  if (recorder.audioRouted) {
    recorder.setMonitorGain(gain);
    video.muted = false;
    video.volume = 1;
  } else {
    video.muted = muted;
    video.volume = v;
  }
  el.btnMute.textContent = gain === 0 ? '🔇' : '🔊';
}

el.rngVol.addEventListener('input', applyVolume);
el.btnMute.addEventListener('click', () => {
  el.btnMute.dataset.muted = el.btnMute.dataset.muted === '1' ? '0' : '1';
  applyVolume();
});
el.selSpeed.addEventListener('change', () => { video.playbackRate = Number(el.selSpeed.value); });
el.chkLoop.addEventListener('change', () => { video.loop = el.chkLoop.checked; });

el.btnFull.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (err) {
    toast(`Pantalla completa no disponible: ${err.message}`);
  }
});
document.addEventListener('fullscreenchange', () => {
  el.btnFull.setAttribute('aria-pressed', String(!!document.fullscreenElement));
  setTimeout(layoutFrame, 60);
});

/* -------------------------------------------------------------- keyframes */

function renderKeyframes(items) {
  el.kfList.textContent = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty-list';
    li.textContent = 'Sin keyframes: se graba la vista tal como la muevas.';
    el.kfList.appendChild(li);
    return;
  }
  items.forEach((kf, i) => {
    const li = document.createElement('li');

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'name icon-btn';
    go.style.textAlign = 'left';
    go.textContent = `${i + 1}. ${fmtTime(kf.t)}`;
    go.title = 'Ir a este keyframe';
    go.addEventListener('click', () => {
      video.currentTime = kf.t;
      cam.set(kf);
    });

    const kv = document.createElement('span');
    kv.className = 'kv';
    kv.textContent = `${Math.round(kf.yaw)}° / ${Math.round(kf.pitch)}° / ${Math.round(kf.fov)}°`;

    const upd = document.createElement('button');
    upd.type = 'button';
    upd.className = 'icon-btn';
    upd.textContent = '⟳';
    upd.title = 'Actualizar con la vista actual';
    upd.setAttribute('aria-label', `Actualizar keyframe ${i + 1}`);
    upd.addEventListener('click', () => {
      track.update(i, { yaw: cam.yaw, pitch: cam.pitch, roll: cam.roll, fov: cam.fov });
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.title = 'Eliminar';
    del.setAttribute('aria-label', `Eliminar keyframe ${i + 1}`);
    del.addEventListener('click', () => track.removeAt(i));

    li.append(go, kv, upd, del);
    el.kfList.appendChild(li);
  });
}

function addKeyframe() {
  if (!sources.current) return toast('Carga primero un vídeo.');
  track.add({ t: video.currentTime, yaw: cam.yaw, pitch: cam.pitch, roll: cam.roll, fov: cam.fov });
  toast(`Keyframe en ${fmtTime(video.currentTime)}.`);
}

el.btnAddKf.addEventListener('click', addKeyframe);
el.btnClearKf.addEventListener('click', () => track.clear());
track.clear();

/* --------------------------------------------------------------- grabación */

function initCodecs() {
  const formats = supportedFormats();
  el.selCodec.textContent = '';
  if (!formats.length) {
    const opt = document.createElement('option');
    opt.textContent = 'MediaRecorder no disponible';
    el.selCodec.appendChild(opt);
    el.selCodec.disabled = true;
    el.btnRec.disabled = el.btnRec2.disabled = el.btnExportRange.disabled = true;
    el.recStatus.textContent = 'Este navegador no puede grabar vídeo (MediaRecorder ausente).';
    return;
  }
  for (const f of formats) {
    const opt = document.createElement('option');
    opt.value = f.mime;
    opt.textContent = f.label;
    el.selCodec.appendChild(opt);
  }
}
initCodecs();

el.selRes.addEventListener('change', () => {
  if (el.selRes.value === 'custom') return;
  const [w, h] = el.selRes.value.split('x').map(Number);
  setOutSize(w, h);
});
for (const input of [el.numW, el.numH]) {
  input.addEventListener('change', () => {
    el.selRes.value = 'custom';
    setOutSize(Number(el.numW.value) || 1920, Number(el.numH.value) || 1080);
  });
}

function setRecUI(on) {
  el.recBadge.hidden = !on;
  el.btnRec.textContent = on ? 'Detener' : 'Grabar vista';
  el.btnRec2.textContent = on ? 'Detener' : 'Grabar en directo';
  el.btnRec.classList.toggle('active', on);
  el.btnRec2.classList.toggle('active', on);
  el.btnExportRange.disabled = on;
  el.selRes.disabled = on;
  el.numW.disabled = el.numH.disabled = on;
  el.selCodec.disabled = on;
  el.selFps.disabled = on;
  el.btnCropApply.disabled = on;
}

function startRecording(label = 'REC') {
  if (recording) return;
  if (!sources.current) return toast('Carga primero un vídeo.');
  if (!renderer.hasFrame) return toast('Aún no hay imagen: espera a que cargue el vídeo (o revisa CORS si es una URL).');
  if (cropMode) setCropMode(false);

  recording = true;
  layoutFrame(); // lienzo a la resolución de salida completa
  drawFrame();

  try {
    const info = recorder.start({
      fps: Number(el.selFps.value),
      bitrate: Number(el.numBitrate.value) * 1_000_000,
      audio: el.chkAudio.checked,
      mime: el.selCodec.value,
    });
    if (recorder.audioRouted) applyVolume();
    for (const w of info.warnings) toast(w, 5000);
    el.recBadgeText.textContent = label;
    setRecUI(true);
    el.recStatus.textContent = `Grabando ${out.w}×${out.h} a ${el.selFps.value} fps · ${info.mime}`;
  } catch (err) {
    recording = false;
    layoutFrame();
    toast(`No se pudo iniciar la grabación: ${err.message}`);
  }
}

async function finishRecording(message = 'Grabación detenida.') {
  if (!recording) return;
  const wasExport = !!exportJob;
  exportJob = null;
  recording = false;
  let result = null;
  try {
    result = await recorder.stop();
  } catch (err) {
    toast(`Error al cerrar la grabación: ${err.message}`);
  }
  if (wasExport) video.pause();
  setRecUI(false);
  layoutFrame();
  applyVolume();
  if (result && result.blob.size) {
    addResult(result);
    el.recStatus.textContent = `${message} ${fmtSize(result.size)} · ${fmtTime(result.duration)}`;
    toast(`${message} Archivo listo en el panel Grabar.`);
  } else {
    el.recStatus.textContent = 'La grabación quedó vacía.';
  }
}

function addResult(result) {
  const name = `vr2drec_${out.w}x${out.h}_${stamp()}.${result.ext}`;
  const li = document.createElement('li');

  const a = document.createElement('a');
  a.className = 'name';
  a.href = result.url;
  a.download = name;
  a.textContent = name;

  const kv = document.createElement('span');
  kv.className = 'kv';
  kv.textContent = `${fmtSize(result.size)} · ${fmtTime(result.duration)}`;

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'icon-btn';
  play.textContent = '▶';
  play.title = 'Cargar en el reproductor';
  play.setAttribute('aria-label', `Reproducir ${name}`);
  play.addEventListener('click', () => {
    sources.items.push({ id: `r${Date.now()}`, kind: 'file', name, url: result.url, revoke: false, hint: { inMode: 'flat', layout: 'mono' } });
    sources.select(sources.items[sources.items.length - 1].id);
    el.selInput.value = 'flat';
    setInMode('flat', 'mono');
  });

  const dl = document.createElement('button');
  dl.type = 'button';
  dl.className = 'icon-btn';
  dl.textContent = '⭳';
  dl.title = 'Descargar';
  dl.setAttribute('aria-label', `Descargar ${name}`);
  dl.addEventListener('click', () => download(result.url, name));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn';
  del.textContent = '✕';
  del.title = 'Descartar';
  del.setAttribute('aria-label', `Descartar ${name}`);
  del.addEventListener('click', () => {
    URL.revokeObjectURL(result.url);
    li.remove();
  });

  li.append(a, kv, play, dl, del);
  el.results.prepend(li);
  download(result.url, name); // descarga automática
}

el.btnRec.addEventListener('click', () => (recording ? finishRecording() : startRecording()));
el.btnRec2.addEventListener('click', () => (recording ? finishRecording() : startRecording()));

el.btnSetIn.addEventListener('click', () => { el.numIn.value = video.currentTime.toFixed(1); });
el.btnSetOut.addEventListener('click', () => { el.numOut.value = video.currentTime.toFixed(1); });

el.btnExportRange.addEventListener('click', async () => {
  if (recording) return;
  if (!sources.current) return toast('Carga primero un vídeo.');
  if (!isFinite(video.duration) || !video.duration) return toast('El vídeo no tiene duración conocida.');

  const start = clamp(Number(el.numIn.value) || 0, 0, video.duration);
  let end = Number(el.numOut.value) || 0;
  if (!end || end <= start) end = video.duration;
  end = clamp(end, start + 0.1, video.duration);

  video.pause();
  video.loop = false;
  el.chkLoop.checked = false;
  if (track.length) el.chkFollow.checked = true;

  await seekTo(start);
  drawFrame();
  startRecording('EXPORT');
  if (!recording) return;
  exportJob = { start, end };
  el.recStatus.textContent = `Exportando ${fmtTime(start)} → ${fmtTime(end)} a ${out.w}×${out.h}…`;
  try {
    await video.play();
  } catch (err) {
    toast(`No se pudo reproducir para exportar: ${err.message}`);
    finishRecording('Exportación cancelada.');
  }
});

function seekTo(t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.02) return resolve();
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
    setTimeout(done, 1500);
  });
}

el.btnSnapshot.addEventListener('click', () => {
  if (!renderer.hasFrame) return toast('Todavía no hay imagen que capturar.');
  const wasPreview = !recording;
  if (wasPreview) { renderer.resize(out.w, out.h); drawFrame(); }
  el.canvas.toBlob((blob) => {
    if (wasPreview) layoutFrame();
    if (!blob) return toast('No se pudo generar la imagen.');
    const url = URL.createObjectURL(blob);
    download(url, `vr2drec_${out.w}x${out.h}_${stamp()}.png`);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Captura PNG descargada.');
  }, 'image/png');
});

/* --------------------------------------------------------------- WebXR */

xrSupported().then((ok) => { el.btnXR.hidden = !ok; }).catch(() => {});

el.btnXR.addEventListener('click', async () => {
  try {
    if (xr.active) await xr.end();
    else {
      if (proj.inMode === 'flat') toast('Sugerencia: activa el modo 360/VR para ver en esfera.');
      await xr.start();
    }
  } catch (err) {
    toast(`WebXR: ${err.message}`);
  }
});

/* ------------------------------------------------------------ atajos */

window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const step = e.shiftKey ? 1 : 5;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': if (!cropMode) { e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + step); } break;
    case 'ArrowLeft': if (!cropMode) { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - step); } break;
    case '+': case '=': cam.adjustZoom(0.9); break;
    case '-': case '_': cam.adjustZoom(1.1); break;
    case '0': cam.reset(); break;
    case 'k': case 'K': addKeyframe(); break;
    case 'c': case 'C': setCropMode(!cropMode); break;
    case 'r': case 'R': recording ? finishRecording() : startRecording(); break;
    case 'f': case 'F': el.btnFull.click(); break;
    case 'm': case 'M': el.btnMute.click(); break;
    default: break;
  }
});

/* --------------------------------------------------------------- arranque */

cam.sensitivity = Number(el.rngSens.value) || 1;
cam.inertia = el.chkInertia.checked;
video.playbackRate = 1;
applyVolume();
syncProjectionUI();
syncCamInputs();
renderPlaylist([], null);
setOutSize(1920, 1080);
el.selRes.value = '1920x1080';

window.addEventListener('beforeunload', () => {
  for (const item of sources.items) if (item.revoke) URL.revokeObjectURL(item.url);
});
