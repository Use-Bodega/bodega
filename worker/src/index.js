// BODEGA gateway on Solana: APIs sold to AI agents per call, paid in USDC, only for calls that were answered.
//   GET  /v1                      the fee payer, the fee, the minimum price
//   GET  /v1/shelf, /v1/shelf/:slug   the catalog: house items and the ones sellers listed, each with its paid and failed counts
//   POST /v1/shelf                a seller lists, changes or removes an item, signed with the payout wallet
//   POST /v1/buy/:slug            no X-Payment header -> 402 with what to pay; with it -> the answer and the receipt
//   POST /v1/sample/:slug         a free call to a house item, limited per day
//   GET  /v1/receipt/:tx          the answer of a call whose payment confirmed late
//   GET  /v1/budget?owner=        a wallet's USDC, and the delegate allowed to spend from it
//   GET  /v1/ledger, /v1/stats    settled payments, each with its transaction
// BODEGA never holds the money. The buyer signs a transaction that pays the seller and the fee, the gateway gets the
// seller's answer first and only then signs as fee payer and sends it. A call that fails is never sent to the chain.
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { NETWORK, USDC, EXPLORER, pubkey, ata, toUnits, fromUnits, feeOf, newRef, inspectPayment, signatureOf, listingMessage, signedBy, publicUrl } from '../../core/bodega.mjs';
import { rpc, usdcAccount, isHolder, waitFor } from './chain.js';
import { HOUSE, houseBy, checkInput } from './shelf.js';

export const VERSION = '0.1.0';
const CORS = {
  'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-payment',
  'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'x-payment-response',
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), {
  status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
});
const stop = (status, code, message, extra = {}) => ({ status, body: { error: { code, message }, ...extra } });
const fail = (status, code, message) => json({ error: { code, message } }, status);

const SLUG = /^[a-z0-9][a-z0-9-]{2,31}$/;
const MAX_BODY = 64 * 1024, MAX_REPLY = 1024 * 1024, MAX_PRICE = 100, SELLER_MS = 25000, HELD_MS = 600000;
const minPrice = (env) => Number(env.MIN_PRICE || 0.01);
const feeBps = (env) => Number(env.FEE_BPS || 300);
const changed = (r) => (r.meta?.changes ?? r.changes ?? 0) > 0;
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
let payer; // the fee payer's key: it only ever holds SOL for network fees
const feePayer = (env) => {
  if (!env.FEE_PAYER_KEY) return null;
  return payer ??= Keypair.fromSecretKey(env.FEE_PAYER_KEY.trim().startsWith('[') ? Uint8Array.from(JSON.parse(env.FEE_PAYER_KEY)) : bs58.decode(env.FEE_PAYER_KEY.trim()));
};

// ---------- the shelf ----------
const houseItem = (env, s) => ({ ...s, house: true, seller: env.HOUSE_PAY_TO || null, value: toUnits(s.price) });
const sellerItem = (r) => ({ slug: r.slug, name: r.name, summary: r.summary, docs: r.docs, house: false, seller: r.pay_to, value: BigInt(r.value), url: r.url, secret: r.secret, at: r.at });
async function itemBy(env, slug) {
  const h = houseBy(slug);
  if (h) return houseItem(env, h);
  const r = await env.DB.prepare('SELECT * FROM items WHERE slug = ? AND open = 1 AND hidden = 0').bind(slug).first();
  return r ? sellerItem(r) : null;
}
const show = (s, origin, n) => ({
  slug: s.slug, name: s.name, summary: s.summary, priceUsd: fromUnits(s.value), seller: s.seller, house: s.house,
  // from the ledger: calls that were paid on chain, and calls the seller failed and nobody paid for
  paidCalls: n?.paid || 0, failedCalls: n?.failed || 0,
  buy: `${origin}/v1/buy/${s.slug}`,
  ...(s.house ? { input: s.input.map(({ pattern, ...f }) => f), sample: `${origin}/v1/sample/${s.slug}` } : { docs: s.docs || null, listedAt: s.at }),
});
async function shelf(env, origin) {
  const [{ results }, counts] = await Promise.all([
    env.DB.prepare('SELECT * FROM items WHERE open = 1 AND hidden = 0 ORDER BY at DESC LIMIT 200').all(),
    env.DB.prepare('SELECT * FROM counts').all(),
  ]);
  const n = new Map(counts.results.map((c) => [c.item, c]));
  return [...HOUSE.map((s) => houseItem(env, s)), ...results.map(sellerItem)].map((s) => show(s, origin, n.get(s.slug)));
}
const count = (env, slug, col) => env.DB.prepare(`INSERT INTO counts (item, ${col}) VALUES (?, 1) ON CONFLICT (item) DO UPDATE SET ${col} = ${col} + 1`).bind(slug).run();

// ---------- a seller's listing ----------
async function bump(env, kind, who) {
  const day = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare('INSERT INTO uses (day, who, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, who, kind) DO UPDATE SET n = n + 1 RETURNING n').bind(day, who, kind).first();
  return r.n;
}
async function visitor(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${new Date().toISOString().slice(0, 10)}:${ip}`))).slice(0, 12));
}

async function list(request, env, body, origin) {
  const slug = String(body.slug || ''), name = String(body.name || '').trim(), summary = String(body.summary || '').trim(), docs = String(body.docs || '').trim();
  const open = body.open !== false, price = Number(body.priceUsd), at = Number(body.at);
  if (!SLUG.test(slug)) return fail(400, 'invalid_slug', '3 to 32 characters: a-z, 0-9 and dashes.');
  if (houseBy(slug)) return fail(409, 'slug_taken', 'That name belongs to a house item.');
  if (!name || name.length > 60 || !summary || summary.length > 200 || docs.length > 2000) return fail(400, 'invalid_text', 'name up to 60, summary up to 200, docs up to 2000 characters.');
  if (!(price >= minPrice(env) && price <= MAX_PRICE) || toUnits(price) !== toUnits(price.toFixed(6))) return fail(400, 'invalid_price', `Price per call is ${minPrice(env)} to ${MAX_PRICE} USDC.`);
  const url = publicUrl(body.url, env.ALLOW_HTTP_UPSTREAM === '1');
  if (!url) return fail(400, 'invalid_url', 'The item URL must be https on a public host.');
  let payTo;
  try { payTo = pubkey(body.payTo).toBase58(); } catch { return fail(400, 'invalid_pay_to', 'payTo is the wallet that gets paid.'); }
  if (!(Math.abs(Date.now() / 1000 - at) < 600)) return fail(400, 'stale', 'Sign again: `at` is unix seconds, within ten minutes of now.');
  if (!signedBy(listingMessage({ slug, url: body.url, priceUsd: body.priceUsd, payTo, open, at }), String(body.signature || ''), payTo)) return fail(401, 'bad_signature', 'Sign the listing message with the payout wallet.');

  const old = await env.DB.prepare('SELECT pay_to, secret, hidden, updated FROM items WHERE slug = ?').bind(slug).first();
  if (old && old.pay_to !== payTo) return fail(403, 'not_yours', 'That item belongs to another wallet.');
  if (old && at * 1000 <= old.updated) return fail(400, 'stale', 'A newer signed change is already in.');
  // a payment cannot create the seller's USDC account, so it has to be there already
  if (open && !await usdcAccount(env, ata(payTo).toBase58()).catch(() => null)) return fail(400, 'no_usdc_account', 'The payout wallet has no USDC account yet. Receive any USDC once and list again.');
  if (!old && await bump(env, 'list', await visitor(request)) > Number(env.LIST_PER_DAY || 5)) return fail(429, 'too_many', 'Too many new items from here today.');
  const secret = old && !body.rotate ? old.secret : hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(`INSERT INTO items (slug, name, summary, docs, url, value, pay_to, secret, open, hidden, at, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11)
    ON CONFLICT (slug) DO UPDATE SET name = ?2, summary = ?3, docs = ?4, url = ?5, value = ?6, secret = ?8, open = ?9, updated = ?11`)
    .bind(slug, name, summary, docs, String(url), Number(toUnits(price)), payTo, secret, open ? 1 : 0, Date.now(), at * 1000).run();
  return json({
    slug, open, hidden: !!old?.hidden, buy: `${origin}/v1/buy/${slug}`,
    // shown when the item is listed or the secret is rotated: the seller checks X-Bodega-Signature with it
    ...(!old || body.rotate ? { signingSecret: secret } : {}),
  }, old ? 200 : 201);
}

// ---------- a call ----------
/// What one call of this item costs and where each part goes. Built here every time, never taken from the client.
async function quoteFor(env, s) {
  const sellerAccount = ata(s.seller).toBase58(), feeAccount = ata(env.FEE_TO).toBase58();
  // nothing to split when the seller is the fee wallet itself, or holds the token
  const fee = sellerAccount === feeAccount || await isHolder(env, s.seller) ? 0n : feeOf(s.value, feeBps(env));
  return {
    scheme: 'bodega-split', network: NETWORK, asset: USDC, priceUsd: fromUnits(s.value), amount: s.value,
    seller: s.seller, sellerAccount, sellerAmount: s.value - fee, feeAccount, feeAmount: fee, feePayer: feePayer(env).publicKey.toBase58(),
    ref: newRef(), maxSeconds: 40,
  };
}
// The quote a buyer sees also carries a fresh blockhash, so the kit needs no RPC of its own to pay.
async function quoteWithBlockhash(env, s) {
  const [q, latest] = await Promise.all([quoteFor(env, s), rpc(env, 'getLatestBlockhash', [{ commitment: 'confirmed' }]).catch(() => null)]);
  return { ...q, blockhash: latest?.value?.blockhash || null };
}

async function forward(s, raw, call, buyer, ms) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(s.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${raw}`))));
  const r = await fetch(s.url, {
    method: 'POST', body: raw, redirect: 'manual', signal: AbortSignal.timeout(ms),
    headers: { 'content-type': 'application/json', 'x-bodega-timestamp': ts, 'x-bodega-call': call, 'x-bodega-buyer': buyer, 'x-bodega-signature': `sha256=${mac}` },
  }).catch(() => null);
  if (!r) return { ok: false, status: 502, code: 'seller_unreachable', counts: true };
  const text = (await r.text().catch(() => '')).slice(0, MAX_REPLY + 1);
  if (text.length > MAX_REPLY) return { ok: false, status: 502, code: 'reply_too_large', counts: true };
  let result = text;
  try { result = JSON.parse(text); } catch { /* plain text is a fine answer */ }
  // a 4xx is the seller turning down this input: not charged, and not held against the seller
  if (r.status >= 400 && r.status < 500) return { ok: false, status: r.status, code: 'seller_refused', result };
  if (r.status < 200 || r.status > 299) return { ok: false, status: 502, code: 'seller_failed', counts: true, result };
  return { ok: true, result };
}

const receiptOf = (row) => ({
  tx: row.tx, explorer: `${EXPLORER}/tx/${row.tx}`, network: NETWORK, asset: 'USDC', paidUsd: fromUnits(row.value), sellerGotUsd: fromUnits(row.value - row.fee),
  feeUsd: fromUnits(row.fee), buyer: row.buyer, seller: row.seller, ms: row.ms,
});
async function record(env, row) {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO payments (tx, item, house, seller, buyer, value, fee, own, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.tx, row.item, row.house, row.seller, row.buyer, row.value, row.fee, row.own, row.ms, row.at).run();
  if (changed(r)) await count(env, row.item, 'paid');
}

async function paidCall(env, s, raw, input, header) {
  const started = Date.now();
  if (!feePayer(env) || !env.FEE_TO || !s.seller) return stop(503, 'not_open', 'The counter is not set up yet.');
  const q = await quoteFor(env, s);
  const p = inspectPayment(header, q);
  if (p.error) return stop(402, p.error, 'The payment is not the one that was quoted. Ask for a new quote and sign that.');

  // one payment buys one answer, even when it arrives twice at once
  if (!changed(await env.DB.prepare('INSERT OR IGNORE INTO claims (id, at) VALUES (?, ?)').bind(p.id, started).run())) return stop(402, 'payment_used', 'That payment was already used. Sign a new one.');
  const release = () => env.DB.prepare('DELETE FROM claims WHERE id = ?').bind(p.id).run();
  const refuse = async (code, message) => { await release(); return stop(402, code, message); };

  // who is really paying: the wallet that owns the USDC, whoever signed for it
  const src = await usdcAccount(env, p.source).catch(() => null);
  if (!src) return refuse('no_usdc_account', 'The paying account is not a USDC account.');
  if (src.amount < s.value) return refuse('no_funds', 'The wallet does not hold enough USDC.');
  if (p.authority !== src.owner && (p.authority !== src.delegate || src.allowance < s.value)) return refuse('over_budget', 'The signing key is not allowed to spend this much from the wallet.');

  // from here on the transaction is complete; the chain confirms it would go through before the seller does any work
  p.tx.sign([feePayer(env)]);
  const wire = btoa(String.fromCharCode(...p.tx.serialize()));
  const sim = await rpc(env, 'simulateTransaction', [wire, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]).catch(() => null);
  if (!sim || sim.value.err) return refuse('would_not_settle', sim?.value?.err === 'BlockhashNotFound' ? 'The payment is too old. Sign a new one.' : 'The payment would not go through.');

  let result;
  if (s.house) {
    try { result = await s.run(env, input); } catch (e) {
      await release();
      if (e.input) return stop(422, e.message, 'Not charged.');
      console.error('house item failed:', s.slug, e.message);
      await count(env, s.slug, 'failed');
      return stop(502, 'item_failed', 'A data source failed. Not charged.');
    }
  } else {
    const f = await forward(s, raw, p.memo || p.id, src.owner, Number(env.SELLER_MS) || SELLER_MS);
    if (!f.ok) {
      await release();
      if (f.counts) await count(env, s.slug, 'failed');
      return stop(f.status, f.code, 'The seller did not answer the call. Not charged.', f.result === undefined ? {} : { sellerReply: f.result });
    }
    result = f.result;
  }

  // the seller answered: now the payment goes out, and the answer leaves only after the chain shows it
  const tx = signatureOf(p.tx);
  const own = (env.OWN_PAYERS || '').split(',').includes(src.owner) ? 1 : 0;
  const row = { tx, item: s.slug, house: s.house ? 1 : 0, seller: s.seller, buyer: src.owner, value: Number(s.value), fee: Number(q.feeAmount), own, ms: 0, at: Date.now() };
  const sent = await rpc(env, 'sendTransaction', [wire, { encoding: 'base64', skipPreflight: true, maxRetries: 5 }]).then(() => true, (e) => { console.error('send failed:', e.message); return false; });
  const state = sent ? await waitFor(env, tx) : 'failed';
  row.ms = Date.now() - started;
  if (state === 'failed') return stop(402, 'settle_failed', 'The payment did not land. No answer returned, nothing charged.');
  if (state === 'unknown') {
    await env.DB.prepare('INSERT OR REPLACE INTO held (tx, row, result, at) VALUES (?, ?, ?, ?)').bind(tx, JSON.stringify(row), JSON.stringify(result), Date.now()).run();
    return stop(202, 'payment_pending', 'The payment was sent but has not confirmed yet. Fetch the answer from the receipt URL.', { tx, receipt: `/v1/receipt/${tx}` });
  }
  await record(env, row);
  const receipt = receiptOf(row);
  return { status: 200, receipt, body: { item: s.slug, result, receipt } };
}

async function buy(request, env, slug) {
  const s = await itemBy(env, slug);
  if (!s) return fail(404, 'unknown_item', 'No such item.');
  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail(413, 'too_large', 'The request body is over 64 KB.');
  let body = {};
  try { if (raw) body = JSON.parse(raw); } catch { return fail(400, 'invalid_json', 'Send JSON. Not charged.'); }
  let input = body;
  if (s.house) {
    const c = checkInput(s, body);
    if (c.error) return fail(400, c.error, 'Check your input. Not charged.');
    input = c.input;
  }
  const header = request.headers.get('x-payment');
  if (!header) {
    if (!feePayer(env) || !env.FEE_TO || !s.seller) return fail(503, 'not_open', 'The counter is not set up yet.');
    return json({ error: { code: 'payment_required', message: 'Build the payment from `accepts`, sign it and send the same request again with it in the X-Payment header.' }, accepts: [await quoteWithBlockhash(env, s)] }, 402);
  }
  const out = await paidCall(env, s, raw || '{}', input, header);
  return json(out.body, out.status, out.receipt ? { 'x-payment-response': btoa(JSON.stringify(out.receipt)) } : {});
}

// The answer of a call whose payment was still on its way when the call returned.
async function lateReceipt(env, tx) {
  const done = await env.DB.prepare('SELECT * FROM payments WHERE tx = ?').bind(tx).first();
  const h = await env.DB.prepare('SELECT * FROM held WHERE tx = ?').bind(tx).first();
  if (!h) return done ? json({ item: done.item, receipt: receiptOf(done) }) : fail(404, 'unknown_payment', 'No such payment.');
  const state = await waitFor(env, tx, 1);
  if (state === 'unknown' && Date.now() - h.at < (Number(env.HELD_MS) || HELD_MS)) return fail(202, 'payment_pending', 'Not confirmed yet. Try again in a few seconds.');
  await env.DB.prepare('DELETE FROM held WHERE tx = ?').bind(tx).run();
  // a transaction lives about a minute and a half; unseen after ten, it can no longer land
  if (state !== 'landed') return fail(402, 'settle_failed', 'The payment did not land. Nothing was charged.');
  const row = JSON.parse(h.row);
  await record(env, row);
  return json({ item: row.item, result: JSON.parse(h.result), receipt: receiptOf(row) });
}

// Lets a visitor see a real answer with no wallet. House items only, limited per visitor and per day.
async function sample(request, env, slug) {
  const h = houseBy(slug);
  if (!h) return fail(403, 'no_sample', 'Only house items have a free sample.');
  const c = checkInput(h, await request.json().catch(() => ({})));
  if (c.error) return fail(400, c.error, 'Check your input.');
  if (await bump(env, 'sample', '*') > Number(env.SAMPLE_PER_DAY || 500)) return fail(429, 'samples_gone', 'Free samples are used up for today.');
  if (await bump(env, 'sample', await visitor(request)) > Number(env.SAMPLE_PER_IP || 10)) return fail(429, 'sample_limit', 'Sample limit reached for today.');
  try { return json({ item: slug, sample: true, result: await h.run(env, c.input) }); } catch (e) {
    if (e.input) return fail(422, e.message, 'Check your input.');
    console.error('sample failed:', slug, e.message);
    return fail(502, 'item_failed', 'A data source failed.');
  }
}

async function budget(env, owner) {
  const account = ata(owner).toBase58(), a = await usdcAccount(env, account);
  if (!a) return { owner, usdcAccount: null, balanceUsd: 0, delegate: null, allowanceUsd: 0 };
  return { owner, usdcAccount: account, balanceUsd: fromUnits(a.amount), delegate: a.delegate, allowanceUsd: fromUnits(a.allowance) };
}

async function stats(env) {
  const r = await env.DB.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(value), 0) value, COALESCE(SUM(value - fee), 0) toSellers, COUNT(DISTINCT buyer) buyers,
    COALESCE(SUM(CASE WHEN own = 0 THEN 1 ELSE 0 END), 0) outside, COALESCE(SUM(CASE WHEN house = 0 THEN 1 ELSE 0 END), 0) toOutsideSellers FROM payments`).first();
  const listed = await env.DB.prepare('SELECT COUNT(*) n FROM items WHERE open = 1 AND hidden = 0').first();
  const failed = await env.DB.prepare('SELECT COALESCE(SUM(failed), 0) n FROM counts').first();
  return {
    houseItems: HOUSE.length, sellerItems: listed.n, paidCalls: r.calls, failedCallsNotCharged: failed.n, volumeUsd: fromUnits(r.value), paidToSellersUsd: fromUnits(r.toSellers), buyers: r.buyers,
    // calls not made by the team's own wallets, and calls that paid a seller other than the house
    outsideCalls: r.outside, callsToSellerItems: r.toOutsideSellers, token: env.TOKEN_ADDRESS || null,
  };
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/', { origin } = url;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const post = request.method === 'POST';

  if (path === '/v1') {
    return json({
      name: 'BODEGA', version: VERSION, network: NETWORK, asset: USDC, feePayer: feePayer(env)?.publicKey.toBase58() || null, feeTo: env.FEE_TO || null,
      feeBps: feeBps(env), minPriceUsd: minPrice(env), token: env.TOKEN_ADDRESS || null,
      endpoints: ['/v1/shelf', '/v1/shelf/:slug', '/v1/buy/:slug', '/v1/sample/:slug', '/v1/receipt/:tx', '/v1/budget?owner=', '/v1/ledger', '/v1/stats'],
    });
  }
  if (path === '/v1/shelf') {
    if (post) return list(request, env, await request.json().catch(() => ({})), origin);
    return json({ data: await shelf(env, origin) });
  }
  const one = path.match(/^\/v1\/shelf\/([a-z0-9-]+)$/);
  if (one) {
    const s = await itemBy(env, one[1]);
    return s ? json(show(s, origin, await env.DB.prepare('SELECT * FROM counts WHERE item = ?').bind(s.slug).first())) : fail(404, 'unknown_item', 'No such item.');
  }
  const c = path.match(/^\/v1\/(buy|sample)\/([a-z0-9-]+)$/);
  if (c) {
    if (!post) return fail(405, 'use_post', 'POST JSON here.');
    return c[1] === 'sample' ? sample(request, env, c[2]) : buy(request, env, c[2]);
  }
  const late = path.match(/^\/v1\/receipt\/([1-9A-HJ-NP-Za-km-z]{80,90})$/);
  if (late) return lateReceipt(env, late[1]);
  if (path === '/v1/budget') return json(await budget(env, pubkey(url.searchParams.get('owner')).toBase58()));
  // for the site: a browser wallet needs a recent blockhash to set or revoke a budget
  if (path === '/v1/blockhash') return json((await rpc(env, 'getLatestBlockhash', [{ commitment: 'confirmed' }])).value);
  if (path === '/v1/stats') return json(await stats(env));
  if (path === '/v1/ledger') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const { results } = await env.DB.prepare('SELECT tx, item, house, seller, buyer, value, fee, own, ms, at FROM payments ORDER BY at DESC LIMIT ?').bind(limit).all();
    return json({ data: results.map((r) => ({ ...r, house: !!r.house, own: !!r.own, paidUsd: fromUnits(r.value), feeUsd: fromUnits(r.fee), explorer: `${EXPLORER}/tx/${r.tx}` })) });
  }
  // takes an item off the shelf; its owner cannot bring it back
  if (path === '/v1/admin/hide' && post) {
    if (!env.ADMIN_KEY || request.headers.get('x-admin-key') !== env.ADMIN_KEY) return fail(401, 'no', 'Not allowed.');
    const b = await request.json().catch(() => ({}));
    const r = await env.DB.prepare('UPDATE items SET hidden = ? WHERE slug = ?').bind(b.hidden === false ? 0 : 1, String(b.slug || '')).run();
    return json({ slug: b.slug, changed: changed(r) });
  }
  if (path.startsWith('/v1')) return fail(404, 'not_found', 'Nothing here.');
  return env.ASSETS ? env.ASSETS.fetch(request) : fail(404, 'not_found', 'Nothing here.');
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); } catch (e) {
      if (e.status) return fail(e.status, 'bad_request', e.message);
      console.error(e);
      return fail(500, 'server_error', 'Something failed. Not charged.');
    }
  },
};
