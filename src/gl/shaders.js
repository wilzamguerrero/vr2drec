/**
 * Shaders de reproyección.
 *
 * Para cada píxel del lienzo de salida se calcula un rayo de cámara según la
 * proyección de salida elegida, se rota con la orientación actual y se convierte
 * en coordenadas de textura según el formato del vídeo original.
 * Es el mismo principio que usan las herramientas de reframing (Insta360 Studio,
 * GoPro Player): la salida siempre es una imagen plana ya reencuadrada.
 */

/** Proyección del vídeo de entrada. */
export const IN_MODE = {
  equirect360: 0,
  equirect180: 1,
  fisheye_dual: 2,
  fisheye_single: 3,
  flat: 4,
};

/** Proyección con la que se pinta (y se graba) la salida. */
export const OUT_MODE = {
  rect: 0,      // rectilínea: perspectiva normal
  stereo: 1,    // estereográfica (little planet / ojo de pez suave)
  equirect: 2,  // equirectangular completa
  xr: 3,        // rayos a partir de la matriz de proyección de WebXR
};

/** Disposición estéreo del original. */
export const LAYOUT = { mono: 0, tb: 1, sbs: 2 };

export const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vPos;
void main() {
  vPos = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const FRAG_SRC = `
precision highp float;

varying vec2 vPos;

uniform sampler2D uTex;
uniform float uAspect;      // ancho/alto del viewport de salida
uniform float uSrcAspect;   // ancho/alto de la textura de vídeo
uniform float uFov;         // campo de visión horizontal en radianes
uniform mat3  uRot;         // rotación cámara -> mundo
uniform mat4  uInvProj;     // inversa de la matriz de proyección (modo XR)
uniform int   uOutMode;
uniform int   uInMode;
uniform int   uLayout;
uniform float uEye;         // 0.0 = izquierdo, 1.0 = derecho
uniform float uFishFov;     // cobertura de la lente en radianes
uniform float uFishScale;   // ajuste fino del radio del círculo
uniform float uFishBlend;   // ancho de mezcla en la costura (radianes)
uniform float uZoom;        // zoom en modo plano
uniform vec2  uPan;         // desplazamiento en modo plano

const float PI = 3.141592653589793;

/* Remapea a la mitad correspondiente si el original es estéreo. */
vec2 stereoRemap(vec2 uv) {
  if (uLayout == 1) return vec2(uv.x, uv.y * 0.5 + uEye * 0.5);
  if (uLayout == 2) return vec2(uv.x * 0.5 + uEye * 0.5, uv.y);
  return uv;
}

/* Rayo de cámara (mira hacia -Z) para el píxel p en [-1, 1]. */
vec3 rayDir(vec2 p) {
  if (uOutMode == 3) {
    vec4 v = uInvProj * vec4(p, -1.0, 1.0);
    return normalize(v.xyz / v.w);
  }
  if (uOutMode == 2) {
    float lon = p.x * PI;
    float lat = p.y * PI * 0.5;
    float cl = cos(lat);
    return vec3(sin(lon) * cl, sin(lat), -cos(lon) * cl);
  }
  if (uOutMode == 1) {
    // Estereográfica: r = 2 * tan(theta / 2)
    float k = 2.0 * tan(clamp(uFov, 0.02, 6.02) * 0.25);
    vec2 q = vec2(p.x, p.y / uAspect) * k;
    float r = length(q);
    if (r < 1e-6) return vec3(0.0, 0.0, -1.0);
    float th = 2.0 * atan(r * 0.5);
    return vec3(q / r * sin(th), -cos(th));
  }
  float t = tan(clamp(uFov, 0.02, 3.05) * 0.5);
  return normalize(vec3(p.x * t, p.y * t / uAspect, -1.0));
}

/* Radio del círculo de ojo de pez en coordenadas de textura. */
vec2 fishRadius(float aspect) {
  return vec2(0.5 * min(1.0, 1.0 / aspect), 0.5 * min(1.0, aspect)) * uFishScale;
}

/* Muestra una lente de ojo de pez equidistante.
   center: centro del círculo en uv. th: ángulo respecto al eje de la lente. */
vec4 sampleFish(vec2 center, vec2 rad, vec2 dxy, float th) {
  float r = th / max(uFishFov * 0.5, 0.01);
  vec2 uv = vec2(center.x + dxy.x * r * rad.x, center.y - dxy.y * r * rad.y);
  return texture2D(uTex, stereoRemap(uv));
}

vec2 unitXY(vec2 v) {
  float l = length(v);
  return l < 1e-6 ? vec2(1.0, 0.0) : v / l;
}

void main() {
  vec2 p = vPos;
  vec4 color = vec4(0.0, 0.0, 0.0, 1.0);

  if (uInMode == 4) {
    // Vídeo plano: encaje "contain" con zoom y desplazamiento.
    float srcA = uSrcAspect;
    if (uLayout == 1) srcA = uSrcAspect * 2.0;
    if (uLayout == 2) srcA = uSrcAspect * 0.5;
    float f = min(uAspect / srcA, 1.0);
    vec2 q = (p - uPan) / max(uZoom, 0.05);
    vec2 c = vec2(q.x * uAspect / (f * srcA), q.y / f);
    if (abs(c.x) <= 1.0 && abs(c.y) <= 1.0) {
      vec2 uv = vec2(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
      color = texture2D(uTex, stereoRemap(uv));
    }
    gl_FragColor = color;
    return;
  }

  vec3 d = uRot * rayDir(p);

  if (uInMode == 0) {
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    color = texture2D(uTex, stereoRemap(vec2(0.5 + lon / (2.0 * PI), 0.5 - lat / PI)));
  } else if (uInMode == 1) {
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    if (abs(lon) <= PI * 0.5) {
      color = texture2D(uTex, stereoRemap(vec2(0.5 + lon / PI, 0.5 - lat / PI)));
    }
  } else if (uInMode == 2) {
    // Doble ojo de pez: lente frontal a la izquierda, trasera a la derecha.
    vec2 rad = fishRadius(uSrcAspect * 0.5) * vec2(0.5, 1.0);
    float thF = acos(clamp(-d.z, -1.0, 1.0));
    float thB = PI - thF;
    float halfFov = uFishFov * 0.5;
    vec4 front = sampleFish(vec2(0.25, 0.5), rad, unitXY(d.xy), thF);
    vec4 back  = sampleFish(vec2(0.75, 0.5), rad, unitXY(vec2(-d.x, d.y)), thB);
    float b = max(min(uFishBlend, halfFov - PI * 0.5), 0.0005);
    float m = smoothstep(PI * 0.5 - b, PI * 0.5 + b, thF);
    if (halfFov < PI * 0.5) {
      // Sin solape: cada lente cubre menos de un hemisferio.
      m = thF > halfFov ? 1.0 : 0.0;
      if (thB > halfFov && thF > halfFov) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    }
    color = mix(front, back, m);
  } else {
    // Ojo de pez único centrado, mirando al frente (-Z).
    vec2 rad = fishRadius(uSrcAspect);
    float th = acos(clamp(-d.z, -1.0, 1.0));
    if (th <= uFishFov * 0.5) {
      color = sampleFish(vec2(0.5, 0.5), rad, unitXY(d.xy), th);
    }
  }

  gl_FragColor = color;
}
`;
