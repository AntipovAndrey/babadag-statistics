'use strict';

// Tiny zero-dependency local "backend" whose only job is to relay the cached
// flight JSON to the generated SPA report and serve the static front-end.
// Having a same-origin local server means the SPA can `fetch()` the data
// without running into the API's missing CORS headers or file:// limitations.

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJsonFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'No cached data. Run the CLI with credentials first.' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

function makeHandler({ publicDir, dataFile, metaFile }) {
  return function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');

    // --- API relay endpoints ---
    if (url.pathname === '/api/flights') return sendJsonFile(res, dataFile);
    if (url.pathname === '/api/meta') return sendJsonFile(res, metaFile);

    // --- static SPA ---
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // Prevent path traversal: resolve and ensure it stays inside publicDir.
    const filePath = path.join(publicDir, path.normalize(pathname));
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(buf);
    });
  };
}

/**
 * Start the local server, automatically hopping to the next free port if the
 * requested one is taken. Resolves with `{ server, port }`.
 */
function startServer({ port, publicDir, dataFile, metaFile }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(makeHandler({ publicDir, dataFile, metaFile }));
    let current = Number(port);
    let attempts = 0;

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempts < 20) {
        attempts += 1;
        current += 1;
        setTimeout(() => server.listen(current), 60);
      } else {
        reject(err);
      }
    });
    server.on('listening', () => resolve({ server, port: current }));
    server.listen(current);
  });
}

module.exports = { startServer };
