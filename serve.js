// Zero-dependency static server. getDisplayMedia needs a secure context,
// and http://localhost counts as one — file:// does not.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const PORT = process.env.PORT || 4173;

http.createServer((req, res) => {
  let target = '/';
  try { target = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { /* bad escape */ }
  const file = path.join(root, target === '/' ? 'index.html' : target);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`Kino → http://localhost:${PORT}`));
