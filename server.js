/**
 * Servidor estático mínimo (sin dependencias) para abrir vr2drec.
 * Hace falta porque los módulos ES no se cargan desde file://.
 *
 *   node server.js            -> http://localhost:5173
 *   node server.js 8080       -> puerto a medida
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 5173);

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.insv': 'video/mp4',
}));

/* --------------------------------------------------------------------- proxy
 * /proxy?url=<url absoluta> reenvía un vídeo remoto añadiendo CORS, para poder
 * reproyectarlo en WebGL y grabarlo cuando el servidor de origen no manda
 * Access-Control-Allow-Origin. Solo escucha en 127.0.0.1 y se puede desactivar
 * con VR2DREC_PROXY=0.
 */
const PROXY_ON = process.env.VR2DREC_PROXY !== '0';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, X-Proxy-Status',
};

function proxyPass(target, req, res, depth = 0) {
  if (depth > 5) {
    res.writeHead(508, { ...CORS, 'Content-Type': 'application/json' }).end('{"error":"demasiadas redirecciones"}');
    return;
  }
  const mod = target.protocol === 'https:' ? https : http;
  const headers = {
    'user-agent': req.headers['user-agent'] || 'vr2drec',
    accept: req.headers.accept || '*/*',
    'accept-encoding': 'identity',
  };
  if (req.headers.range) headers.range = req.headers.range;

  const upstream = mod.request(
    target,
    { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, timeout: 20000 },
    (up) => {
      const loc = up.headers.location;
      if ([301, 302, 303, 307, 308].includes(up.statusCode) && loc) {
        up.resume();
        let next;
        try { next = new URL(loc, target); } catch { next = null; }
        if (next && /^https?:$/.test(next.protocol)) return proxyPass(next, req, res, depth + 1);
      }
      const out = { ...CORS, 'Cache-Control': 'no-store', 'X-Proxy-Status': String(up.statusCode) };
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        if (up.headers[h]) out[h] = up.headers[h];
      }
      if (!out['accept-ranges']) out['accept-ranges'] = 'bytes';
      res.writeHead(up.statusCode, out);
      up.pipe(res);
    }
  );
  upstream.on('timeout', () => upstream.destroy(new Error('tiempo de espera agotado')));
  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ error: err.message }));
  });
  upstream.end();
}

function handleProxy(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  if (!PROXY_ON) {
    res.writeHead(403, { ...CORS, 'Content-Type': 'application/json' }).end('{"error":"proxy desactivado"}');
    return;
  }
  if (url.searchParams.has('ping')) {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }).end('{"proxy":true}');
    return;
  }
  const raw = url.searchParams.get('url');
  let target;
  try { target = new URL(raw); } catch { target = null; }
  if (!target || !/^https?:$/.test(target.protocol)) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' }).end('{"error":"url no válida"}');
    return;
  }
  proxyPass(target, req, res);
}

const server = http.createServer((req, res) => {
  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('URL inválida');
    return;
  }

  if (pathname === '/proxy') {
    handleProxy(req, res, url);
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Impide salir del directorio del proyecto.
  const target = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('Prohibido');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
      return;
    }
    const type = TYPES.get(path.extname(target).toLowerCase()) || 'application/octet-stream';
    const range = req.headers.range;

    // Rango parcial: permite hacer seek en vídeos servidos desde aquí.
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [rawStart, rawEnd] = range.replace('bytes=', '').split('-');
      const start = rawStart ? Number(rawStart) : 0;
      const end = rawEnd ? Math.min(Number(rawEnd), stat.size - 1) : stat.size - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(target, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`vr2drec en http://localhost:${PORT}`);
  console.log(`proxy de vídeo remoto: ${PROXY_ON ? 'activo (/proxy?url=…)' : 'desactivado'}`);
  console.log('Ctrl+C para parar.');
});
