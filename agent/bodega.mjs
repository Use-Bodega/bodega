// The agent side of BODEGA. The key here signs payments for API calls, one call at a time.
// It is either a delegate on the owner's USDC account, limited to the allowance the owner set and revocable
// from the owner's wallet, or a small wallet of its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { NETWORK, USDC, TOKEN_PROGRAM, ata, buildPayment, encodePayment, listingMessage } from '../core/bodega.mjs';

export const BASE_URL = (process.env.BODEGA_URL || 'https://usebodega.fun').replace(/\/+$/, '');
const RPC = process.env.BODEGA_RPC || 'https://solana-rpc.publicnode.com';
const HOME = process.env.BODEGA_HOME || path.join(os.homedir(), '.bodega');
const CONFIG = path.join(HOME, 'agent.json');

export const loadConfig = () => (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : null);
export function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
export function initAgent() {
  const existing = loadConfig();
  if (existing) return existing;
  const kp = Keypair.generate();
  // owner null means the agent pays from its own wallet
  const cfg = { agent: kp.publicKey.toBase58(), secret: [...kp.secretKey], owner: null, maxPrice: 0.1 };
  saveConfig(cfg);
  return cfg;
}
const keypair = (cfg) => Keypair.fromSecretKey(Uint8Array.from(cfg.secret));
const payingWallet = (cfg) => cfg.owner || cfg.agent;
export const keyFromFile = (file) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));

const get = async (p) => (await fetch(`${BASE_URL}${p}`)).json();
export const shelf = async () => (await get('/v1/shelf')).data;
export const budget = (cfg) => get(`/v1/budget?owner=${payingWallet(cfg)}`);

// Buys one call. Refuses anything above maxPrice before signing, and checks the quote pays in USDC on Solana.
export async function buy(cfg, slug, input = {}, { confirm } = {}) {
  if (!cfg) throw new Error('no_agent: run `bodega init` first');
  const url = `${BASE_URL}/v1/buy/${slug}`;
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) };
  let res = await fetch(url, init);
  if (res.status !== 402) return res.json();
  const quote = ((await res.json()).accepts || []).find((a) => a.scheme === 'bodega-split' && a.network === NETWORK && a.asset === USDC);
  if (!quote) throw new Error('no_quote: the gateway did not offer a USDC payment on Solana');
  const usd = (Number(quote.sellerAmount) + Number(quote.feeAmount)) / 1e6;
  if (usd > cfg.maxPrice) throw new Error(`over_max_price: $${usd} is above your $${cfg.maxPrice} limit`);
  if (confirm && !await confirm({ usd, slug, seller: quote.seller })) throw new Error('declined');
  const blockhash = quote.blockhash || (await new Connection(RPC, 'confirmed').getLatestBlockhash()).blockhash;
  const tx = buildPayment({ quote, owner: payingWallet(cfg), authority: cfg.agent, blockhash });
  tx.sign([keypair(cfg)]);
  init.headers['x-payment'] = encodePayment(tx);
  res = await fetch(url, init);
  let out = await res.json();
  // the payment went out but had not confirmed: the answer waits at the receipt URL
  for (let i = 0; res.status === 202 && out.receipt && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    res = await fetch(`${BASE_URL}${out.receipt}`);
    const next = await res.json();
    if (res.status !== 202) out = next;
  }
  return out;
}

// The owner's side, for an owner who has a keypair file: lets the agent key spend up to `usd` from the owner's USDC.
// Owners with a browser wallet do the same on the site.
export async function approve(cfg, ownerKey, usd) {
  const owner = ownerKey.publicKey, amount = new Uint8Array(8);
  new DataView(amount.buffer).setBigUint64(0, BigInt(Math.round(usd * 1e6)), true);
  // ApproveChecked: source, mint, delegate, owner
  const ix = new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [{ pubkey: ata(owner), isSigner: false, isWritable: true }, { pubkey: new PublicKey(USDC), isSigner: false, isWritable: false }, { pubkey: new PublicKey(cfg.agent), isSigner: false, isWritable: false }, { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from([13, ...amount, 6]),
  });
  const conn = new Connection(RPC, 'confirmed');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
  tx.sign([ownerKey]);
  const signature = await conn.sendTransaction(tx);
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
  return signature;
}

// The seller's side: lists, changes or removes an item, signed with the payout wallet's key.
export async function list(payoutKey, { slug, url, priceUsd, name, summary, docs = '', open = true, rotate = false }) {
  const s = { slug, url, priceUsd: Number(priceUsd), payTo: payoutKey.publicKey.toBase58(), open, at: Math.floor(Date.now() / 1000) };
  const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(listingMessage(s)), payoutKey.secretKey.slice(0, 32)));
  const res = await fetch(`${BASE_URL}/v1/shelf`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...s, name, summary, docs, rotate, signature }) });
  return res.json();
}
