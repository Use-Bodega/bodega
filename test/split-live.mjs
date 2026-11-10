// A real split payment on mainnet: a throwaway seller lists an item, the agent buys one call,
// and the chain must show the seller's part and the fee landing in one transaction. Then the item comes off the shelf,
// the seller's USDC goes back to the agent and its USDC account is closed, rent back to the fee payer.
// node split-live.mjs <fee payer key file> <seller key file to create or reuse>
import fs from 'node:fs';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { USDC, ata } from '../core/bodega.mjs';
import { BASE_URL, buy, list, loadConfig } from '../agent/bodega.mjs';

const RPC = process.env.SOL_RPC_URL || 'https://solana-rpc.publicnode.com';
const conn = new Connection(RPC, 'confirmed');
const [payerFile, sellerFile] = process.argv.slice(2);
if (!payerFile || !sellerFile) throw new Error('usage: node split-live.mjs <fee payer key file> <seller key file>');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerFile, 'utf8')).secretKey));
if (!fs.existsSync(sellerFile)) fs.writeFileSync(sellerFile, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
const seller = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(sellerFile, 'utf8'))));
const cfg = loadConfig(), agent = cfg.agent, mint = new PublicKey(USDC);
const FEE_TO = (await (await fetch(`${BASE_URL}/v1`)).json()).feeTo;
const SLUG = 'split-test', PRICE = 0.02;

let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const send = async (instructions, signers) => {
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [
    // a small priority fee, or the transaction can sit unseen until its blockhash runs out
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...instructions] }).compileToV0Message());
  tx.sign(signers);
  const signature = await conn.sendTransaction(tx, { maxRetries: 10 });
  // web3.js reads block height from the RPC and can call a landed transaction expired, so ask for the status instead
  for (let i = 0; i < 40; i++) {
    const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (st?.err) throw new Error(`${signature} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return signature;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${signature} not seen in 60 s`);
};
// getTokenAccountBalance needs a paid key on publicnode; the parsed account works everywhere
const usdc = async (owner) => { const r = await conn.getParsedAccountInfo(ata(owner)); return r.value ? BigInt(r.value.data.parsed.info.tokenAmount.amount) : null; };
console.log('seller', seller.publicKey.toBase58(), '| agent', agent, '| fee to', FEE_TO);

// 1 the seller's USDC account, paid by the fee payer (rent comes back at the end)
if (await usdc(seller.publicKey) === null) {
  const sig = await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(seller.publicKey), seller.publicKey, mint)], [payer]);
  console.log('seller USDC account opened', sig);
}

let paid = null;
try {
  // 2 list, buy one call
  const made = await list(seller, { slug: SLUG, url: 'https://httpbin.org/anything', priceUsd: PRICE, name: 'Split test', summary: 'A test item for one real split payment. Removed after the test.' });
  // a second run reopens the closed item and keeps its secret, so no new secret comes back
  ok('the throwaway seller lists an item', made.open === true && !made.error, JSON.stringify(made.error || ''));
  const [a0, s0, f0] = await Promise.all([usdc(agent), usdc(seller.publicKey), usdc(FEE_TO)]);
  const r = await buy(cfg, SLUG, { test: 'split' });
  paid = r.receipt?.tx;
  ok('the call is answered with a receipt', !!paid && r.result?.json?.test === 'split', JSON.stringify(r.error || ''));
  ok('the receipt splits 0.02 into 0.0194 and 0.0006', r.receipt?.sellerGotUsd === 0.0194 && r.receipt?.feeUsd === 0.0006);

  // 3 what the chain shows
  if (!paid) throw new Error('no payment, skipping the chain checks');
  const t = await conn.getParsedTransaction(paid, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  const transfers = t.transaction.message.instructions.filter((i) => i.program === 'spl-token').map((i) => ({ to: i.parsed.info.destination, units: i.parsed.info.tokenAmount.amount, authority: i.parsed.info.authority }));
  ok('one transaction, two USDC transfers, both signed by the agent', t.meta.err === null && transfers.length === 2 && transfers.every((x) => x.authority === agent), JSON.stringify(transfers));
  ok('the seller part goes to the seller\'s account', transfers.some((x) => x.to === ata(seller.publicKey).toBase58() && x.units === '19400'));
  ok('the fee goes to the fee wallet\'s account', transfers.some((x) => x.to === ata(FEE_TO).toBase58() && x.units === '600'));
  const [a1, s1, f1] = await Promise.all([usdc(agent), usdc(seller.publicKey), usdc(FEE_TO)]);
  ok('balances: agent -0.02, seller +0.0194, fee wallet +0.0006', a0 - a1 === 20000n && s1 - s0 === 19400n && f1 - f0 === 600n, `${a0 - a1} ${s1 - s0} ${f1 - f0}`);
  const row = (await (await fetch(`${BASE_URL}/v1/ledger`)).json()).data.find((x) => x.tx === paid);
  ok('the ledger row is marked ours and names the seller', row?.own === true && row.seller === seller.publicKey.toBase58() && row.fee === 600);
} finally {
  // 4 off the shelf, money back to the agent, the seller's account closed with its rent back to the fee payer
  const off = await list(seller, { slug: SLUG, url: 'https://httpbin.org/anything', priceUsd: PRICE, name: 'Split test', summary: 'A test item for one real split payment. Removed after the test.', open: false });
  const gone = (await fetch(`${BASE_URL}/v1/shelf/${SLUG}`)).status === 404;
  ok('the test item is off the shelf', off.open === false && gone, JSON.stringify(off.error || ''));
  const left = await usdc(seller.publicKey);
  if (left !== null) {
    const ixs = [
      ...(left > 0n ? [createTransferCheckedInstruction(ata(seller.publicKey), mint, ata(agent), seller.publicKey, left, 6)] : []),
      createCloseAccountInstruction(ata(seller.publicKey), payer.publicKey, seller.publicKey),
    ];
    const sig = await send(ixs, [payer, seller]);
    ok('the seller\'s USDC went back to the agent and its account is closed', (await usdc(seller.publicKey)) === null, `${left} units back, tx ${sig}`);
  }
}
console.log(paid ? `\npayment ${paid}` : '\nno payment');
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
