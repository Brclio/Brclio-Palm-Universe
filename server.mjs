import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const root = resolve(import.meta.dirname);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.jpg':'image/jpeg', '.png':'image/png', '.svg':'image/svg+xml', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.mp4':'video/mp4', '.wasm':'application/wasm', '.task':'application/octet-stream', '.srt':'text/plain; charset=utf-8', '.md':'text/plain; charset=utf-8' };
types['.m4a']='audio/mp4';
const port = Number(process.env.PORT || 5173);
http.createServer((req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const file = statSync(path).isDirectory() ? resolve(path, 'index.html') : path;
    const info = statSync(file);
    const headers = { 'Content-Type':types[extname(file)] || 'application/octet-stream', 'Accept-Ranges':'bytes', 'Cache-Control':'no-cache' };
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), info.size-1) : info.size-1;
      if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range':`bytes */${info.size}` }).end(); return; }
      res.writeHead(206, { ...headers, 'Content-Length':end-start+1, 'Content-Range':`bytes ${start}-${end}/${info.size}` });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length':info.size });
      createReadStream(file).pipe(res);
    }
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '0.0.0.0', () => console.log(`掌心宇宙 http://localhost:${port}`));
