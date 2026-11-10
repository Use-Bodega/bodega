// The agent kit against the worker in-process and the faked chain: node kit.mjs
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { fakeChain, RPC_URL } from './fake-chain.mjs';
import { sqliteD1 } from '../worker/d1-sqlite.mjs';
import { USDC } from '../core/bodega.mjs';

process.env.BODEGA_URL = 'https://bodega.test';
process.env.BODEGA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bodega-kit-'));
const chain = fakeChain();
const { default: worker } = await import('../worker/src/index.js');
const kit = await import('../agent/bodega.mjs');

let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const feePayer = Keypair.generate(), feeTo = Keypair.generate(), house = Keypair.generate(), owner = Keypair.generate(), seller = Keypair.generate();
for (const w of [feeTo, house, seller]) chain.open(w.publicKey.toBase58());
const env = { DB: sqliteD1(), FEE_PAYER_KEY: JSON.stringify([...feePayer.secretKey]), SOL_RPC_URL: RPC_URL, FEE_TO: feeTo.publicKey.toBase58(), HOUSE_PAY_TO: house.publicKey.toBase58(), POLL_MS: '1', ALLOW_HTTP_UPSTREAM: '1' };
const inner = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).startsWith('https://bodega.test') ? worker.fetch(new Request(url, init), env) : inner(url, init));

const cfg = kit.initAgent();
ok('1 init makes a key and keeps it', kit.loadConfig().agent === cfg.agent && kit.initAgent().agent === cfg.agent);
ok('2 the shelf lists the house items', (await kit.shelf()).length === 6);

// its own wallet
chain.open(cfg.agent, USDC, 1_000_000n);
const r = await kit.buy(cfg, 'sol-wallet', { address: cfg.agent });
ok('3 own wallet: the call is answered and paid', r.result?.usdc === 1 && r.receipt?.buyer === cfg.agent && chain.balance(cfg.agent) === 990_000n, JSON.stringify(r.error || ''));
ok('4 the quote carried a blockhash, so the kit made no RPC call of its own', chain.sent.length === 1);
let msg = '';
try { await kit.buy({ ...cfg, maxPrice: 0.005 }, 'sol-wallet', { address: cfg.agent }); } catch (e) { msg = e.message; }
ok('5 a price above the limit is not signed', msg.startsWith('over_max_price') && chain.sent.length === 1);
ok('6 bad input comes back without a payment', (await kit.buy(cfg, 'sol-wallet', { address: 'x' })).error?.code === 'invalid_address' && chain.sent.length === 1);

// a budget on the owner's wallet
chain.open(owner.publicKey.toBase58(), USDC, 5_000_000n);
chain.approve(owner.publicKey.toBase58(), cfg.agent, 20_000n);
const withOwner = { ...cfg, owner: owner.publicKey.toBase58() };
const b = await kit.budget(withOwner);
ok('7 the budget is read from the chain', b.balanceUsd === 5 && b.allowanceUsd === 0.02 && b.delegate === cfg.agent);
const p = await kit.buy(withOwner, 'sol-token', { mint: USDC });
ok('8 the agent pays from the owner\'s wallet inside the allowance', p.receipt?.buyer === withOwner.owner && chain.balance(withOwner.owner) === 4_980_000n && chain.balance(cfg.agent) === 990_000n, JSON.stringify(p.error || ''));
ok('9 past the allowance the gateway refuses and nothing is sent', (await kit.buy(withOwner, 'sol-fees', {})).error?.code === 'over_budget' && chain.sent.length === 2);

// a seller lists with the kit
const made = await kit.list(seller, { slug: 'echo', url: 'http://127.0.0.1:9/echo', priceUsd: 0.03, name: 'Echo', summary: 'Says it back.' });
ok('10 a seller lists an item with the payout key', /^[0-9a-f]{64}$/.test(made.signingSecret || '') && (await kit.shelf()).some((s) => s.slug === 'echo' && s.seller === seller.publicKey.toBase58()), JSON.stringify(made.error || ''));
const dead = await kit.buy(cfg, 'echo', {});
ok('11 a seller that does not answer costs nothing', dead.error?.code === 'seller_unreachable' && chain.balance(cfg.agent) === 990_000n);

fs.rmSync(process.env.BODEGA_HOME, { recursive: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
