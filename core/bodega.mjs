// BODEGA core: what the gateway, the agent kit and the tests share.
// A payment is one Solana transaction with a USDC transfer to the seller and one to the fee wallet.
// The buyer's key signs it (the wallet itself or its SPL delegate), the gateway signs last as fee payer,
// and only sends it once the seller has answered.
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';

export const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const EXPLORER = 'https://solscan.io';
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const USDC_KEY = new PublicKey(USDC);
// the most a payment may ask the fee payer to spend on priority: 40,000 units at 50,000 micro-lamports is 2,000 lamports
export const MAX_UNITS = 40_000, MAX_UNIT_PRICE = 50_000n;

export const pubkey = (s) => {
  try { return new PublicKey(s); } catch { throw Object.assign(new Error('not a Solana address'), { status: 400 }); }
};
export const ata = (owner, mint = USDC_KEY) => PublicKey.findProgramAddressSync([pubkey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), pubkey(mint).toBuffer()], ATA_PROGRAM)[0];
// USDC units (6 decimals) from a dollar price, and back
export const toUnits = (usd) => BigInt(Math.round(Number(usd) * 1e6));
export const fromUnits = (units) => Number(units) / 1e6;
export const feeOf = (value, bps) => (BigInt(value) * BigInt(bps)) / 10_000n;
export const newRef = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
// TransferChecked, written by hand so the same bytes are built in Node, in a Worker and in a browser
const transfer = (source, dest, authority, amount) => new TransactionInstruction({
  programId: TOKEN_PROGRAM,
  keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: USDC_KEY, isSigner: false, isWritable: false }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }],
  data: Buffer.from([12, ...u64(amount), 6]),
});

/// The buyer's side: the unsigned payment for one quote. `owner` holds the USDC, `authority` signs (the owner or its delegate).
export function buildPayment({ quote, owner, authority, blockhash }) {
  const source = ata(owner), signer = pubkey(authority);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }),
    transfer(source, pubkey(quote.sellerAccount), signer, quote.sellerAmount),
    ...(BigInt(quote.feeAmount) > 0n ? [transfer(source, pubkey(quote.feeAccount), signer, quote.feeAmount)] : []),
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`bodega:${quote.ref}`) }),
  ];
  return new VersionedTransaction(new TransactionMessage({ payerKey: pubkey(quote.feePayer), recentBlockhash: blockhash, instructions }).compileToV0Message());
}
export const encodePayment = (tx) => Buffer.from(tx.serialize()).toString('base64');

/// The gateway's side: is this transaction exactly the payment that was quoted, and nothing else?
/// The fee payer signs whatever passes here, so anything not on the list is refused.
export function inspectPayment(base64, quote) {
  const no = (code) => ({ error: code });
  let tx;
  try { tx = VersionedTransaction.deserialize(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))); } catch { return no('unreadable'); }
  const m = tx.message;
  if (m.version !== 0 || m.addressTableLookups.length) return no('unsupported_transaction');
  const keys = m.staticAccountKeys, h = m.header;
  if (h.numRequiredSignatures !== 2 || tx.signatures.length !== 2) return no('wrong_signers');
  if (keys[0].toBase58() !== quote.feePayer) return no('wrong_fee_payer');
  const authority = keys[1];
  if (!ed25519.verify(tx.signatures[1], m.serialize(), authority.toBytes())) return no('bad_signature');

  let source = null, memo = null, units = 0, unitPrice = 0n;
  const want = new Map([[quote.sellerAccount, BigInt(quote.sellerAmount)]]);
  if (BigInt(quote.feeAmount) > 0n) want.set(quote.feeAccount, BigInt(quote.feeAmount));
  for (const ix of m.compiledInstructions) {
    const program = keys[ix.programIdIndex], data = ix.data;
    // the fee payer pays the network fee and nothing else: no instruction may touch it
    if (ix.accountKeyIndexes.includes(0)) return no('touches_fee_payer');
    if (program.equals(ComputeBudgetProgram.programId)) {
      const view = new DataView(data.buffer, data.byteOffset, data.length);
      if (data[0] === 2 && data.length === 5 && !units) units = view.getUint32(1, true);
      else if (data[0] === 3 && data.length === 9 && !unitPrice) unitPrice = view.getBigUint64(1, true);
      else return no('unexpected_instruction');
      if (units > MAX_UNITS || unitPrice > MAX_UNIT_PRICE) return no('priority_too_high');
    } else if (program.equals(TOKEN_PROGRAM)) {
      if (data[0] !== 12 || data.length !== 10 || data[9] !== 6 || ix.accountKeyIndexes.length !== 4) return no('unexpected_instruction');
      const [src, mint, dest, auth] = ix.accountKeyIndexes.map((i) => keys[i]);
      if (!mint.equals(USDC_KEY)) return no('wrong_asset');
      if (!auth.equals(authority)) return no('wrong_signers');
      if (source && !source.equals(src)) return no('unexpected_instruction');
      source = src;
      const amount = new DataView(data.buffer, data.byteOffset, data.length).getBigUint64(1, true);
      if (want.get(dest.toBase58()) !== amount) return no(want.has(dest.toBase58()) ? 'wrong_amount' : 'wrong_recipient');
      want.delete(dest.toBase58());
    } else if (program.equals(MEMO_PROGRAM)) {
      if (memo !== null || ix.accountKeyIndexes.length || data.length > 80) return no('unexpected_instruction');
      memo = new TextDecoder().decode(data);
    } else return no('unexpected_instruction');
  }
  if (want.size) return no(source ? 'wrong_amount' : 'no_transfer');
  if (!units) return no('unexpected_instruction'); // without a limit the fee payer would be charged for the default budget
  // the buyer's signature names this exact message, so it is the key one payment is claimed under
  return { tx, authority: authority.toBase58(), source: source.toBase58(), memo, id: bs58.encode(tx.signatures[1]) };
}

export const signatureOf = (tx) => bs58.encode(tx.signatures[0]);

/// What a seller signs with the payout wallet to put an item on the shelf, change it or take it off.
export const listingMessage = ({ slug, url, priceUsd, payTo, open = true, at }) =>
  `BODEGA listing\nslug: ${slug}\nurl: ${url}\nprice: ${priceUsd} USDC per call\npay to: ${payTo}\nopen: ${open ? 'yes' : 'no'}\nat: ${at}`;
export function signedBy(message, signature, wallet) {
  try { return ed25519.verify(bs58.decode(signature), new TextEncoder().encode(message), pubkey(wallet).toBytes()); } catch { return false; }
}

/// A URL the gateway is willing to fetch: https on a public host name, default port, no credentials.
export function publicUrl(raw, allowHttp = false) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  if (allowHttp) return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  const h = u.hostname;
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return null;
  if (h === 'localhost' || !h.includes('.') || h.includes(':') || /^[\d.]+$/.test(h) || /\.(local|internal|localhost|test|lan|home)$/.test(h)) return null;
  return u;
}
