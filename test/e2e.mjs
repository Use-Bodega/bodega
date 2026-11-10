// The whole BODEGA flow with the worker in-process, a local seller API and a faked chain (fake-chain.mjs).
// node e2e.mjs
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { Keypair, ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import worker from '../worker/src/index.js';
import { sqliteD1 } from '../worker/d1-sqlite.mjs';
import { USDC, ata, buildPayment, encodePayment, listingMessage } from '../core/bodega.mjs';
import { fakeChain, RPC_URL } from './fake-chain.mjs';

let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const usd = (n) => BigInt(Math.round(n * 1e6));
const chain = fakeChain();

// setup: the fee payer, the fee wallet and the house wallet with USDC accounts, an owner with 10 USDC whose agent key may spend 0.10
const feePayer = Keypair.generate(), feeTo = Keypair.generate(), house = Keypair.generate(), owner = Keypair.generate(), agent = Keypair.generate();
const seller = Keypair.generate(), noAccount = Keypair.generate(), thief = Keypair.generate(), poor = Keypair.generate();
const TOKEN = Keypair.generate().publicKey.toBase58();
for (const w of [feeTo, house, seller, thief, poor]) chain.open(w.publicKey.toBase58());
chain.open(owner.publicKey.toBase58(), USDC, usd(10));
chain.approve(owner.publicKey.toBase58(), agent.publicKey.toBase58(), usd(0.1));
const bal = (kp) => chain.balance(kp.publicKey.toBase58());

const env = {
  DB: sqliteD1(), FEE_PAYER_KEY: bs58.encode(feePayer.secretKey), SOL_RPC_URL: RPC_URL, FEE_TO: feeTo.publicKey.toBase58(), HOUSE_PAY_TO: house.publicKey.toBase58(),
  ALLOW_HTTP_UPSTREAM: '1', SAMPLE_PER_IP: '2', ADMIN_KEY: 'admin-secret', POLL_MS: '1', SELLER_MS: '400', HELD_MS: '300', HOLD_MIN: '1000000',
};
const api = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const r = await worker.fetch(new Request(`https://bodega.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json(), receipt: r.headers.get('x-payment-response') };
};
// what the agent kit does: ask, read the 402, build and sign, ask again
const quoteFor = async (slug, body) => (await api(`/v1/buy/${slug}`, { method: 'POST', body })).body.accepts[0];
const sign = (quote, { by = agent, from = owner, change } = {}) => {
  const tx = buildPayment({ quote: change ? { ...quote, ...change } : quote, owner: from.publicKey.toBase58(), authority: by.publicKey.toBase58(), blockhash: chain.newBlockhash() });
  tx.sign([by]);
  return encodePayment(tx);
};
const buy = (slug, body, payment) => api(`/v1/buy/${slug}`, { method: 'POST', body, headers: { 'x-payment': payment } });
// a transaction built by hand, for shapes the kit never makes
const handBuilt = (quote, extra, by = agent) => {
  const good = VersionedTransaction.deserialize(Buffer.from(sign(quote), 'base64'));
  const base = TransactionMessage.decompile(good.message).instructions;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: chain.newBlockhash(), instructions: extra(base) }).compileToV0Message());
  tx.sign([by]);
  return encodePayment(tx);
};

// a seller's API on localhost that checks the gateway's signature
let secret = '', mode = 'ok';
const seen = [];
const sellerApi = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  const mac = 'sha256=' + createHmac('sha256', secret).update(`${req.headers['x-bodega-timestamp']}.${text}`).digest('hex');
  seen.push({ signed: mac === req.headers['x-bodega-signature'], buyer: req.headers['x-bodega-buyer'], call: req.headers['x-bodega-call'], body: text });
  if (mode === 'down') { res.writeHead(500); return res.end('boom'); }
  if (mode === 'refuse') { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"error":"bad city"}'); }
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 900));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ forecast: 'rain', asked: JSON.parse(text || '{}') }));
});
await new Promise((r) => sellerApi.listen(0, '127.0.0.1', r));
const sellerUrl = `http://127.0.0.1:${sellerApi.address().port}/forecast`;

// 1 the shelf
{
  const info = await api('/v1');
  ok('1a /v1 names the fee payer, the fee wallet and the fee', info.body.feePayer === feePayer.publicKey.toBase58() && info.body.feeTo === env.FEE_TO && info.body.feeBps === 300);
  const items = (await api('/v1/shelf')).body.data;
  ok('1b six house items, paid to the house wallet, no calls yet', items.length === 6 && items.every((s) => s.house && s.seller === env.HOUSE_PAY_TO && s.paidCalls === 0 && s.failedCalls === 0));
  ok('1c one item by its slug', (await api('/v1/shelf/sol-wallet')).body.slug === 'sol-wallet' && (await api('/v1/shelf/nope')).status === 404);
}

// 2 an answered call to a house item, paid by the agent key out of the owner's wallet
{
  const body = { address: owner.publicKey.toBase58() };
  const first = await api('/v1/buy/sol-wallet', { method: 'POST', body }), q = first.body.accepts?.[0];
  ok('2a no payment: 402 says what to pay and to whom', first.status === 402 && q.sellerAccount === ata(env.HOUSE_PAY_TO).toBase58() && q.sellerAmount === '9700' && q.feeAmount === '300' && q.feeAccount === ata(env.FEE_TO).toBase58() && q.feePayer === feePayer.publicKey.toBase58());
  ok('2b bad input is refused before any payment is asked', (await api('/v1/buy/sol-wallet', { method: 'POST', body: { address: 'x' } })).status === 400);
  const [o0, h0, f0] = [bal(owner), bal(house), bal(feeTo)];
  const payment = sign(q), r = await buy('sol-wallet', body, payment);
  ok('2c the call answers with what the chain holds', r.status === 200 && r.body.result.usdc === 10 && r.body.result.address === body.address, JSON.stringify(r.body.result || r.body));
  ok('2d one transaction: 0.01 from the owner, 0.0097 to the seller, 0.0003 fee', o0 - bal(owner) === usd(0.01) && bal(house) - h0 === usd(0.0097) && bal(feeTo) - f0 === usd(0.0003) && chain.sent.length === 1);
  ok('2e the agent key spent from its allowance, the owner signed nothing', chain.allowance(owner.publicKey.toBase58()) === usd(0.09) && r.body.receipt.buyer === owner.publicKey.toBase58());
  ok('2f the receipt names the transaction that was sent', r.body.receipt.tx === chain.sent[0] && r.body.receipt.sellerGotUsd === 0.0097 && JSON.parse(atob(r.receipt)).tx === chain.sent[0]);
  const again = await buy('sol-wallet', body, payment);
  ok('2g the same payment buys nothing twice', again.status === 402 && again.body.error.code === 'payment_used' && chain.sent.length === 1);
  const ledger = (await api('/v1/ledger')).body.data;
  ok('2h the ledger and the item\'s count show it', ledger.length === 1 && ledger[0].tx === chain.sent[0] && (await api('/v1/shelf/sol-wallet')).body.paidCalls === 1);
}

// 3 payments that must not go through: nothing is sent to the chain for any of them
{
  const body = { address: env.FEE_TO }, o0 = bal(owner), sent0 = chain.sent.length;
  const code = async (payment, slug = 'sol-wallet') => { const r = await buy(slug, body, payment); return r.status === 402 ? r.body.error.code : `status ${r.status}`; };
  const q = () => quoteFor('sol-wallet', body);
  ok('3a paying the seller less refused', (await code(sign(await q(), { change: { sellerAmount: '100' } }))) === 'wrong_amount');
  ok('3b skipping the fee refused', (await code(sign(await q(), { change: { feeAmount: '0' } }))) === 'wrong_amount');
  ok('3c paying another wallet refused', (await code(sign(await q(), { change: { sellerAccount: ata(thief.publicKey).toBase58() } }))) === 'wrong_recipient');
  // the fee payer signs what it is sent, so a transaction must not be able to take its SOL or add anything of its own
  const drain = SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: thief.publicKey, lamports: 1_000_000 });
  ok('3d a transfer out of the fee payer refused', ['touches_fee_payer', 'unexpected_instruction'].includes(await code(handBuilt(await q(), (ixs) => [...ixs, drain]))));
  const extra = SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: thief.publicKey, lamports: 1 });
  ok('3e any extra instruction refused', (await code(handBuilt(await q(), (ixs) => [...ixs, extra]))) === 'unexpected_instruction');
  ok('3f a high priority fee on the fee payer\'s bill refused', (await code(handBuilt(await q(), (ixs) => [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 }), ...ixs]))) === 'priority_too_high');
  ok('3g no compute limit refused', (await code(handBuilt(await q(), (ixs) => ixs.slice(1)))) === 'unexpected_instruction');
  ok('3h a key that is not the delegate refused', (await code(sign(await q(), { by: thief }))) === 'over_budget');
  ok('3i a wallet without USDC refused', (await code(sign(await q(), { by: poor, from: poor }))) === 'no_funds');
  const tampered = Buffer.from(sign(await q()), 'base64');
  tampered[tampered.length - 20] ^= 1; // changes the memo after signing
  ok('3j a transaction changed after signing refused', (await code(tampered.toString('base64'))) === 'bad_signature');
  ok('3k garbage in the header refused', (await code('zzzz')) === 'unreadable');
  const old = sign(await q());
  chain.expireBlockhashes();
  ok('3l an expired payment refused', (await code(old)) === 'would_not_settle');
  ok('3m none of that reached the chain or cost anything', chain.sent.length === sent0 && bal(owner) === o0 && bal(thief) === 0n);
  // the same payment sent twice at once: one answer, one charge
  const p = sign(await q()), both = await Promise.all([buy('sol-wallet', body, p), buy('sol-wallet', body, p)]);
  ok('3n two copies at once: one answer, one charge', both.filter((r) => r.status === 200).length === 1 && o0 - bal(owner) === usd(0.01), both.map((r) => r.status).join());
  // the budget is the allowance on chain: 0.08 left, so four 0.02 calls pass and the fifth does not
  const token = { mint: USDC };
  let passed = 0;
  for (let i = 0; i < 5; i++) if ((await buy('sol-token', token, sign(await quoteFor('sol-token', token)))).status === 200) passed++;
  const over = await buy('sol-token', token, sign(await quoteFor('sol-token', token)));
  ok('3o the agent stops at its allowance', passed === 4 && over.body.error.code === 'over_budget' && chain.allowance(owner.publicKey.toBase58()) === 0n, `passed ${passed}`);
  chain.approve(owner.publicKey.toBase58(), agent.publicKey.toBase58(), usd(1));
}

// 4 a seller lists an item
const listing = async (by, over = {}, extra = {}) => {
  const s = { slug: 'forecast', url: sellerUrl, priceUsd: 0.05, payTo: by.publicKey.toBase58(), open: true, at: Math.floor(Date.now() / 1000), ...over };
  const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(listingMessage(s)), by.secretKey.slice(0, 32)));
  return api('/v1/shelf', { method: 'POST', body: { ...s, name: 'Forecast', summary: 'Weather for a city.', docs: 'POST {"city": "Paris"}', signature, ...extra } });
};
{
  const made = await listing(seller);
  secret = made.body.signingSecret;
  ok('4a the payout wallet signs, the item is listed with a signing secret', made.status === 201 && /^[0-9a-f]{64}$/.test(secret));
  ok('4b a listing not signed by the payout wallet refused', (await listing(thief, { payTo: seller.publicKey.toBase58() })).status === 401);
  ok('4c another wallet cannot take the item over', (await listing(thief, { at: Math.floor(Date.now() / 1000) + 1 })).status === 403);
  ok('4d a house item\'s name cannot be taken', (await listing(seller, { slug: 'sol-wallet' })).status === 409);
  ok('4e a price under the minimum refused', (await listing(seller, { slug: 'cheap', priceUsd: 0.001 })).status === 400);
  ok('4f a payout wallet with no USDC account refused', (await listing(noAccount, { slug: 'nowhere' })).body.error?.code === 'no_usdc_account');
  const shown = (await api('/v1/shelf')).body.data.find((s) => s.slug === 'forecast');
  ok('4g it is on the shelf without its URL or secret', shown && !shown.house && shown.seller === seller.publicKey.toBase58() && shown.priceUsd === 0.05 && !JSON.stringify(shown).includes(secret) && !JSON.stringify(shown).includes('127.0.0.1'));
}

// 5 calls to the seller's item: paid when answered, free when not
{
  const body = { city: 'Paris' }, counts = async () => { const s = (await api('/v1/shelf/forecast')).body; return `${s.paidCalls}/${s.failedCalls}`; };
  const [o0, s0, f0] = [bal(owner), bal(seller), bal(feeTo)];
  const q = await quoteFor('forecast', body), r = await buy('forecast', body, sign(q));
  ok('5a the seller\'s answer comes back', r.status === 200 && r.body.result.forecast === 'rain' && r.body.result.asked.city === 'Paris');
  ok('5b the seller got 0.0485 in their own wallet in that transaction', o0 - bal(owner) === usd(0.05) && bal(seller) - s0 === usd(0.0485) && bal(feeTo) - f0 === usd(0.0015));
  const got = seen.at(-1);
  ok('5c the seller saw a signed request with the buyer\'s wallet and the call ref', got.signed && got.buyer === owner.publicKey.toBase58() && got.call === `bodega:${q.ref}` && got.body === JSON.stringify(body));

  const [o1, s1, sent1] = [bal(owner), bal(seller), chain.sent.length];
  mode = 'down';
  const p = sign(await quoteFor('forecast', body)), down = await buy('forecast', body, p);
  ok('5d the seller fails: nothing sent, nothing charged, counted against the item', down.status === 502 && down.body.error.code === 'seller_failed' && chain.sent.length === sent1 && bal(owner) === o1 && (await counts()) === '1/1');
  mode = 'refuse';
  const refused = await buy('forecast', body, p);
  ok('5e the seller turns the input down: not charged, their reply passed on, not counted as a failure', refused.status === 422 && refused.body.sellerReply?.error === 'bad city' && bal(owner) === o1 && (await counts()) === '1/1');
  mode = 'slow';
  const slow = await buy('forecast', body, p);
  ok('5f the seller is too slow: not charged, counted', slow.status === 502 && slow.body.error.code === 'seller_unreachable' && bal(owner) === o1 && (await counts()) === '1/2');
  mode = 'ok';
  const retry = await buy('forecast', body, p);
  ok('5g the unspent payment still works once the seller is back', retry.status === 200 && o1 - bal(owner) === usd(0.05) && bal(seller) - s1 === usd(0.0485) && (await counts()) === '2/2');
}

// 6 the payment is sent but the chain is slow to show it
{
  const body = { city: 'Oslo' }, o0 = bal(owner), paid0 = (await api('/v1/stats')).body.paidCalls;
  chain.mode = 'late';
  const r = await buy('forecast', body, sign(await quoteFor('forecast', body)));
  ok('6a not confirmed in time: no answer yet, a receipt URL instead', r.status === 202 && r.body.error.code === 'payment_pending' && !('result' in r.body) && r.body.receipt === `/v1/receipt/${r.body.tx}`);
  ok('6b still pending: the receipt waits', (await api(r.body.receipt)).status === 202 && (await api('/v1/stats')).body.paidCalls === paid0);
  chain.arrive(r.body.tx);
  const late = await api(r.body.receipt);
  ok('6c once the chain shows it, the answer is handed over and the payment recorded', late.status === 200 && late.body.result.asked.city === 'Oslo' && late.body.receipt.tx === r.body.tx && o0 - bal(owner) === usd(0.05) && (await api('/v1/stats')).body.paidCalls === paid0 + 1);
  ok('6d the answer is handed over once', (await api(r.body.receipt)).body.result === undefined);

  chain.mode = 'drop';
  const o1 = bal(owner), d = await buy('forecast', body, sign(await quoteFor('forecast', body)));
  await new Promise((res) => setTimeout(res, 350));
  const gone = await api(d.body.receipt);
  ok('6e a payment that never lands: no answer, no charge, not in the ledger', d.status === 202 && gone.status === 402 && gone.body.error.code === 'settle_failed' && bal(owner) === o1 && (await api('/v1/stats')).body.paidCalls === paid0 + 1);
  chain.mode = 'land';
}

// 7 a seller holding the token sells with no fee
{
  const body = { city: 'Lima' };
  env.TOKEN_ADDRESS = TOKEN;
  ok('7a without the token the fee stays', (await quoteFor('forecast', body)).feeAmount === '1500');
  chain.open(seller.publicKey.toBase58(), TOKEN, 1_000_000n * 1_000_000n);
  await new Promise((r) => setTimeout(r, 5));
  const q = await quoteFor('sol-fees', {}); // another seller's quote is unchanged
  ok('7b the house wallet does not hold it: fee stays', q.feeAmount === '300');
  env.HOLD_MIN = '1000000';
  const fresh = Keypair.generate();
  chain.open(fresh.publicKey.toBase58());
  chain.open(fresh.publicKey.toBase58(), TOKEN, 1_000_000n * 1_000_000n);
  const made = await listing(fresh, { slug: 'holder-item' });
  const hq = await quoteFor('holder-item', body), s0 = chain.balance(fresh.publicKey.toBase58()), f0 = bal(feeTo);
  const prev = secret; secret = made.body.signingSecret;
  const r = await buy('holder-item', body, sign(hq));
  secret = prev;
  ok('7c a seller holding 1M gets the whole price', hq.feeAmount === '0' && hq.sellerAmount === '50000' && r.status === 200 && chain.balance(fresh.publicKey.toBase58()) - s0 === usd(0.05) && bal(feeTo) === f0, JSON.stringify(r.body.error || ''));
  env.TOKEN_ADDRESS = '';
}

// 8 changing, hiding and closing; samples; the numbers
{
  const up = await listing(seller, { priceUsd: 0.08, at: Math.floor(Date.now() / 1000) + 2 });
  ok('8a the seller changes the price, the secret stays', up.status === 200 && !up.body.signingSecret && (await api('/v1/shelf/forecast')).body.priceUsd === 0.08);
  ok('8b an older signed change cannot be replayed', (await listing(seller, { priceUsd: 0.05, at: Math.floor(Date.now() / 1000) - 60 })).status === 400);
  ok('8c admin hide needs the key', (await api('/v1/admin/hide', { method: 'POST', body: { slug: 'forecast' } })).status === 401);
  await api('/v1/admin/hide', { method: 'POST', body: { slug: 'forecast' }, headers: { 'x-admin-key': 'admin-secret' } });
  ok('8d a hidden item is off the shelf and cannot be bought', (await api('/v1/shelf/forecast')).status === 404 && (await api('/v1/buy/forecast', { method: 'POST', body: {} })).status === 404);
  ok('8e the seller cannot bring a hidden item back', (await listing(seller, { at: Math.floor(Date.now() / 1000) + 4 })).body.hidden === true && (await api('/v1/shelf/forecast')).status === 404);
  await api('/v1/admin/hide', { method: 'POST', body: { slug: 'forecast', hidden: false }, headers: { 'x-admin-key': 'admin-secret' } });
  await listing(seller, { open: false, at: Math.floor(Date.now() / 1000) + 6 });
  ok('8f the seller takes the item off the shelf', (await api('/v1/shelf/forecast')).status === 404);

  const d = await api('/v1/sample/sol-wallet', { method: 'POST', body: { address: owner.publicKey.toBase58() } });
  ok('8g a free sample answers with no wallet', d.status === 200 && d.body.sample && typeof d.body.result.usdc === 'number');
  await api('/v1/sample/sol-wallet', { method: 'POST', body: { address: env.FEE_TO } });
  ok('8h samples are limited per visitor', (await api('/v1/sample/sol-wallet', { method: 'POST', body: { address: env.FEE_TO } })).status === 429);
  ok('8i seller items have no free sample', (await api('/v1/sample/holder-item', { method: 'POST', body: {} })).status === 403);
  const b = (await api(`/v1/budget?owner=${owner.publicKey.toBase58()}`)).body;
  ok('8j the budget is read from the chain', b.delegate === agent.publicKey.toBase58() && b.balanceUsd === Number(bal(owner)) / 1e6 && b.allowanceUsd === Number(chain.allowance(owner.publicKey.toBase58())) / 1e6, JSON.stringify(b));
  const s = (await api('/v1/stats')).body, ledger = (await api('/v1/ledger?limit=100')).body.data;
  const total = ledger.reduce((n, r) => n + r.value, 0);
  ok('8k stats count confirmed payments only and match the ledger', s.paidCalls === ledger.length && s.paidCalls === 10 && s.callsToSellerItems === 4 && s.failedCallsNotCharged === 2 && Math.abs(s.volumeUsd - total / 1e6) < 1e-9 && BigInt(total) === usd(10) - bal(owner), JSON.stringify(s));
  ok('8l every ledger row is a transaction the chain has', ledger.every((r) => chain.sent.includes(r.tx)));
}

sellerApi.close(); sellerApi.closeAllConnections();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
