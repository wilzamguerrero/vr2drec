/** Utilidades de matrices en orden column-major (el que espera WebGL). */

export const DEG = Math.PI / 180;

export function mat3Mul(a, b, out = new Float32Array(9)) {
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      out[j * 3 + i] =
        a[i] * b[j * 3] + a[3 + i] * b[j * 3 + 1] + a[6 + i] * b[j * 3 + 2];
    }
  }
  return out;
}

export function rotX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, c, s, 0, -s, c]);
}

export function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 1, 0, s, 0, c]);
}

export function rotZ(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1]);
}

/**
 * Rotación cámara -> mundo a partir de ángulos en grados.
 * Convención: yaw positivo mira hacia la derecha (longitud creciente),
 * pitch positivo mira hacia arriba y roll gira el horizonte.
 * El signo negativo del yaw compensa que la cámara mira hacia -Z.
 */
export function orientationMatrix(yawDeg = 0, pitchDeg = 0, rollDeg = 0) {
  return mat3Mul(
    mat3Mul(rotY(-yawDeg * DEG), rotX(pitchDeg * DEG)),
    rotZ(rollDeg * DEG)
  );
}

/** Extrae la submatriz 3x3 de rotación de una matriz 4x4 column-major. */
export function mat3FromMat4(m, out = new Float32Array(9)) {
  out[0] = m[0]; out[1] = m[1]; out[2] = m[2];
  out[3] = m[4]; out[4] = m[5]; out[5] = m[6];
  out[6] = m[8]; out[7] = m[9]; out[8] = m[10];
  return out;
}

/** Inversa de una matriz 4x4 column-major. Devuelve null si es singular. */
export function mat4Invert(m, out = new Float32Array(16)) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** Normaliza un ángulo en grados al rango (-180, 180]. */
export function wrapDeg(a) {
  let x = ((a + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}
