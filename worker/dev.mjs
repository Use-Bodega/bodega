// Runs the worker under Node with SQLite in place of D1, serving the site too. node dev.mjs [port]
// Settings come from .dev.vars (FEE_PAYER_KEY, SOL_RPC_URL, FEE_TO, HOUSE_PAY_TO); the environment wins over the file.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import worker from './src/index.js';
import { sqliteD1 } from './d1-sqlite.mjs';

const file = new URL('./.dev.vars', import.meta.url);
const vars = existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])) : {};
for (const k of ['FEE_PAYER_KEY', 'SOL_RPC_URL', 'FEE_TO', 'HOUSE_PAY_TO', 'TOKEN_ADDRESS']) if (process.env[k]) vars[k] = process.env[k];
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const ASSETS = { fetch: async (request) => {
  // like Cloudflare's assets: /shelf serves shelf.html
  const p = new URL(request.url).pathname, name = p === '/' ? '/index.html' : extname(p) ? p : `${p.replace(/\/+$/, '')}.html`, f = new URL(`../site${name}`, import.meta.url);
  return existsSync(f) ? new Response(readFileSync(f), { headers: { 'content-type': TYPES[extname(f.pathname)] || 'application/octet-stream' } }) : new Response('not found', { status: 404 });
} };
const env = { ...vars, DB: sqliteD1(process.env.DB_FILE || ':memory:'), ASSETS };
const port = Number(process.argv[2] || 8841);
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`bodega dev on http://localhost:${port}`));
