# vr2drec

Reproductor web de vídeo **local o por URL** con soporte **360 / VR** y grabación de la
vista reencuadrada en **formato plano**, al estilo del reframing de Insta360 Studio,
pero funcionando al 100 % en el navegador.

- Los archivos **no se suben a ningún servidor**: se leen del disco con la File API
  (`URL.createObjectURL`) y todo el procesado ocurre en tu equipo.
- La reproyección 360 → plano se hace en la GPU con WebGL (un shader que traza un rayo
  por píxel), así que va fluido incluso con material 5.7K.
- La grabación usa `canvas.captureStream()` + `MediaRecorder`, con el audio del vídeo
  enrutado por la Web Audio API. Sin ffmpeg, sin WASM, sin dependencias.

## Arranque

Los módulos ES no se cargan desde `file://`, así que hay que servir la carpeta:

```powershell
node server.js          # http://localhost:5173
node server.js 8080     # otro puerto
```

Alternativas equivalentes: `npx serve .`, `python -m http.server 5173`.

## Interfaz

El vídeo ocupa toda la ventana. Los ajustes viven en **ventanas flotantes** que se abren
desde la barra superior (*Fuente*, *Proyección*, *Reencuadre*, *Grabar*, *Ayuda*): se
arrastran por su cabecera, se cierran con <kbd>Esc</kbd> o con la ✕, y recuerdan dónde las
dejaste. Doble clic en la cabecera devuelve la ventana a su posición inicial.

## Cómo se usa

1. **Fuente**: pulsa *Abrir archivos*, arrastra el vídeo sobre el reproductor, o pega una
   URL directa. Se admiten varios vídeos en la lista de reproducción.
2. **Proyección**: el formato del original se detecta por nombre y relación de aspecto
   (2:1 → equirectangular, `.insv` → doble ojo de pez, `_tb`/`_sbs` → estéreo…). Si falla,
   elígelo a mano. Con el modo 360/VR activo puedes rotar la cámara arrastrando, con
   <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>, con la rueda (zoom) o con el giroscopio.
3. **Formato de salida**: elige un preset en *Grabar*, o pulsa **Recortar salida** y
   dibuja el marco final sobre la propia imagen (ver abajo). El marco que ves en pantalla
   es exactamente lo que se graba.
4. **Grabar vista**: graba en tiempo real lo que estás viendo, ya aplanado. Al detener,
   el archivo se descarga y queda en la lista de resultados.
5. **Exportar tramo**: marca entrada/salida y vr2drec reproduce ese fragmento grabándolo
   y parando solo.

### Recortar el área de salida sobre la imagen

Con **Recortar salida** (<kbd>C</kbd>) aparece un marco con tiradores sobre el vídeo:

- arrastra el interior para moverlo, los tiradores para redimensionar, o dibuja uno nuevo
  arrastrando sobre el fondo;
- *Proporción* fija 16:9, 9:16, 1:1, 4:5, 4:3 o 2.39:1, o déjalo libre;
- la etiqueta muestra en vivo la resolución resultante;
- **Aplicar** convierte el marco en el nuevo formato de salida. Con *Reencuadrar cámara*
  activo también mueve la cámara: en 360 recentra el yaw/pitch y estrecha el campo de
  visión al recorte; en vídeo plano ajusta zoom y desplazamiento. Sin esa opción, solo
  cambia la proporción y la resolución.

Los campos numéricos de ancho y alto siguen ahí y se sincronizan con el recorte, por si
prefieres teclear un tamaño exacto.

### Reencuadre por keyframes

En la pestaña *Reencuadre* puedes fijar puntos clave (instante + yaw/pitch/roll/FOV).
Con *Seguir keyframes* activo, la cámara interpola el recorrido (Catmull-Rom, lineal o
escalonado) y ese movimiento es el que se graba. El yaw se desenrolla para no dar un giro
completo al cruzar ±180°.

## Formatos de entrada

| Entrada | Notas |
| --- | --- |
| Plano 2D | zoom y desplazamiento, encaje con letterbox |
| Equirectangular 360° (2:1) | costura sin corte cuando hay WebGL2 |
| Equirectangular 180° (VR180) | recorta fuera del hemisferio frontal |
| Doble ojo de pez (Insta360, dual-fisheye) | cobertura de lente, escala y mezcla de costura ajustables |
| Ojo de pez único (180°) | círculo centrado |
| Estéreo arriba/abajo y lado a lado | se muestra un ojo, o los dos en vista cardboard |

## Proyecciones de salida

Rectilínea (perspectiva natural), estereográfica (ojo de pez suave), *little planet* y
equirectangular completa. Todas se graban igual de bien porque la salida siempre es un
lienzo plano.

## VR con gafas

Si el navegador expone WebXR aparece *Ver en gafas VR*: la esfera se reproyecta para cada
ojo usando la matriz de proyección real del visor. Sin gafas puedes usar la vista estéreo
lado a lado con el giroscopio.

## URLs remotas y CORS

Para reproyectar en WebGL y grabar, el navegador exige que el servidor remoto envíe
`Access-Control-Allow-Origin`. Si no lo hace, el `<video>` falla con un genérico
"formato no soportado" aunque el archivo esté perfecto, porque se pide con
`crossOrigin="anonymous"`.

vr2drec lo resuelve así:

1. Al fallar una URL, consulta el archivo a través del **proxy del servidor local**
   (`/proxy?url=…` en `server.js`), que sí ve la respuesta real.
2. Si el archivo existe y es un vídeo, recarga la fuente por el proxy (que añade CORS) y
   sigue funcionando todo: reproyección, recorte y grabación. La lista marca la fuente
   como `proxy`.
3. Si el problema es otro, lo dice con claridad en el panel *Fuente*: HTTP 403 (enlaces
   firmados con caducidad), 404/410, 429, o un `Content-Type: text/html` cuando el
   servidor devuelve una página de bloqueo en vez del vídeo.

El proxy solo escucha en `127.0.0.1`, reenvía los rangos (`Range`) para poder hacer seek,
sigue redirecciones y no inventa cabeceras de origen: si el CDN exige un `Referer`
concreto o el enlace ya caducó, seguirá dando 403 y así te lo dirá. Se puede desactivar
arrancando con `VR2DREC_PROXY=0 node server.js`.

Notas prácticas para enlaces de CDN: los que llevan `expires=…` y una firma caducan en
minutos, así que hay que copiarlos de nuevo; y los `.m3u8` (HLS) no se admiten, este
reproductor abre archivos de vídeo directos.

## Limitaciones conocidas

- **URLs remotas**: sin CORS solo funcionan a través del proxy local descrito arriba; si
  abres `index.html` con otro servidor sin proxy, descarga el archivo y ábrelo en local.
- **Códecs**: solo se reproduce lo que el navegador sabe decodificar. Los `.insv`/`.insp`
  se intentan abrir como MP4 (suelen ser H.264 y funcionan); no se leen sus metadatos de
  giroscopio, así que no hay estabilización ni nivelado de horizonte automático.
- **Vídeos muy grandes**: si el ancho o el alto superan el `MAX_TEXTURE_SIZE` de la GPU
  (4096 px en equipos modestos), el fotograma no se puede subir a WebGL. vr2drec lo
  detecta, lo reduce al máximo admitido y avisa; el panel *Fuente* muestra el límite de la
  GPU y si están llegando fotogramas. Un 360 de 4320 px o más también puede exceder el
  decodificador por hardware: si se reproduce sin imagen, usa una versión de menor
  resolución.
- **Grabación en tiempo real**: `MediaRecorder` graba a la velocidad de reproducción. Si
  minimizas la ventana o cambias de pestaña, el navegador frena el renderizado y pueden
  perderse fotogramas. Para 4K conviene bajar los fps o el bitrate.
- Los WebM generados por `MediaRecorder` a veces no llevan duración en la cabecera; al
  volver a cargarlos, algunos reproductores muestran duración desconocida.
- El contenedor disponible depende del navegador: se listan los que soporta (MP4/H.264,
  WebM/VP9…) y se usa el primero por defecto.

## Estructura

```
index.html            interfaz
styles/main.css        estilos
server.js              servidor estático mínimo (sin dependencias)
src/app.js             orquestación: UI, bucle de render, grabación
src/gl/shaders.js      shaders de reproyección (entrada y salida)
src/gl/renderer.js     contexto WebGL, textura de vídeo, viewports
src/gl/math.js         matrices y utilidades angulares
src/core/source.js     archivos locales, URLs y detección de proyección
src/core/controls.js   cámara: ratón, dedo, teclado, giroscopio, inercia
src/core/keyframes.js  pista de keyframes e interpolación
src/core/recorder.js   captureStream + MediaRecorder + audio
src/core/xr.js         sesión WebXR inmersiva
src/ui/windows.js      ventanas flotantes (arrastre, foco, posiciones)
src/ui/crop.js         marco de recorte y cálculo de cámara/tamaño
```

## Atajos

<kbd>Espacio</kbd> play/pausa · <kbd>←</kbd><kbd>→</kbd> ±5 s (con <kbd>Shift</kbd>, 1 s) ·
<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> rotar · <kbd>Q</kbd><kbd>E</kbd> horizonte ·
<kbd>+</kbd><kbd>−</kbd> zoom · <kbd>0</kbd> recentrar · <kbd>K</kbd> keyframe ·
<kbd>C</kbd> recortar salida · <kbd>R</kbd> grabar · <kbd>F</kbd> pantalla completa ·
<kbd>M</kbd> silenciar · <kbd>Esc</kbd> cerrar ventana

## Licencia

MIT
