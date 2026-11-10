// Builds the site's pages into ../site: one shared head, sign, nav and footer around each page's body.
// node build.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const PAGES = [
  { file: 'index', path: '/', title: 'BODEGA: the corner store for AI agents', description: 'APIs sold to AI agents per call, paid in USDC on Solana. Your agent pays only when the call is answered, and the seller is paid in that same transaction.' },
  { file: 'shelf', path: '/shelf', title: 'The shelf · BODEGA', description: 'Every API on the shelf with its price per call, and how many calls were paid and how many the seller failed.', nav: 'Shelf' },
  { file: 'agents', path: '/agents', title: 'For agents · BODEGA', description: 'Give your AI agent a USDC budget on Solana and install the BODEGA kit or MCP server.', nav: 'For agents', wallet: true },
  { file: 'sell', path: '/sell', title: 'Sell your API · BODEGA', description: 'List any HTTPS API with a price per call and get paid in USDC on every answered call.', nav: 'Sell here', wallet: true },
  { file: 'register', path: '/register', title: 'The register · BODEGA', description: 'Every confirmed payment, each with its Solana transaction.', nav: 'Register' },
  { file: 'docs', path: '/docs', title: 'Docs · BODEGA', description: 'How a BODEGA call works: the quote, the payment, the receipt, the errors and the rules.', nav: 'Docs' },
];

const nav = PAGES.filter((p) => p.nav).map((p) => `<a href="${p.path}">${p.nav}</a>`).join('');
const layout = (p, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.title}</title>
<meta name="description" content="${p.description}">
<meta property="og:title" content="${p.title}">
<meta property="og:description" content="${p.description}">
<meta property="og:type" content="website">
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=IBM+Plex+Mono:wght@400;600&family=Karla:wght@400;600;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="awning"></div>
<header class="sign"><div class="wrap">
  <a class="brand" href="/"><img src="/logo.svg" alt=""><span class="name slab">BODEGA</span></a><span class="open">OPEN 24 HRS</span>
  <nav>${nav}</nav>
</div></header>
<main>
${body.trim()}
</main>
<footer><div class="wrap">
  <span class="grow">BODEGA. APIs for AI agents, paid per call in USDC on Solana. We never hold funds.</span>
  <a href="/docs">Docs</a><a href="/v1">API</a><a data-repo hidden target="_blank" rel="noopener">GitHub</a><a data-x hidden target="_blank" rel="noopener">X</a>
</div></footer>
${p.wallet ? '<script src="https://unpkg.com/@solana/web3.js@1.98.4/lib/index.iife.min.js"></script>\n' : ''}<script src="/app.js"></script>
</body>
</html>
`;

const dir = new URL('./pages/', import.meta.url);
const known = new Set(PAGES.map((p) => `${p.file}.html`));
for (const f of readdirSync(dir)) if (!known.has(f)) throw new Error(`pages/${f} is not in PAGES`);
for (const p of PAGES) {
  writeFileSync(new URL(`../site/${p.file}.html`, import.meta.url), layout(p, readFileSync(new URL(`${p.file}.html`, dir), 'utf8')));
  console.log(`site/${p.file}.html`);
}
