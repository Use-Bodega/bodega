// A small stand-in for Solana, just enough for the gateway: USDC accounts with delegates, signature checks,
// blockhash expiry, and transactions that land, fail, arrive late or never arrive.
// It answers JSON-RPC over fetch at RPC_URL. It is our own model, not the real token program.
import { VersionedTransaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { USDC, TOKEN_PROGRAM, MEMO_PROGRAM, ata } from '../core/bodega.mjs';

export const RPC_URL = 'http://fake-solana.test/';

export function fakeChain() {
  const accounts = new Map(); // token account address -> { mint, owner, amount, delegate, allowance }
  const lamports = new Map();
  const statuses = new Map(); // signature -> { err } once visible
  const waiting = new Map(); // signature -> polls left before it shows
  let blockhashes = new Set(), n = 0;
  const chain = {
    mode: 'land', // 'land' | 'late' (shows after `lateBy` polls) | 'drop' (never shows)
    lateBy: 30,
    sent: [],
    newBlockhash() { const h = bs58.encode(ed25519.utils.randomPrivateKey()); blockhashes.add(h); return h; },
    expireBlockhashes() { blockhashes = new Set(); },
    open(owner, mint = USDC, amount = 0n) { const a = ata(owner, mint).toBase58(); accounts.set(a, { mint, owner: String(owner), amount: BigInt(amount), delegate: null, allowance: 0n }); return a; },
    approve(owner, delegate, amount) { Object.assign(accounts.get(ata(owner).toBase58()), { delegate: String(delegate), allowance: BigInt(amount) }); },
    balance: (owner, mint = USDC) => accounts.get(ata(owner, mint).toBase58())?.amount ?? null,
    allowance: (owner) => accounts.get(ata(owner).toBase58()).allowance,
    arrive(signature) { waiting.delete(signature); statuses.set(signature, { err: null }); },
  };

  // runs a transaction against a copy of the accounts; returns the error or the new state
  function run(tx, sigVerify) {
    const m = tx.message, keys = m.staticAccountKeys, bytes = m.serialize();
    if (sigVerify) for (let i = 0; i < m.header.numRequiredSignatures; i++) if (!ed25519.verify(tx.signatures[i], bytes, keys[i].toBytes())) return { err: 'SignatureFailure' };
    if (!blockhashes.has(m.recentBlockhash)) return { err: 'BlockhashNotFound' };
    if (statuses.has(bs58.encode(tx.signatures[0]))) return { err: 'AlreadyProcessed' };
    const next = new Map([...accounts].map(([k, v]) => [k, { ...v }]));
    for (const [i, ix] of m.compiledInstructions.entries()) {
      const program = keys[ix.programIdIndex], bad = (code) => ({ err: { InstructionError: [i, { Custom: code }] } });
      if (program.equals(ComputeBudgetProgram.programId) || program.equals(MEMO_PROGRAM) || program.equals(SystemProgram.programId)) continue;
      if (!program.equals(TOKEN_PROGRAM) || ix.data[0] !== 12) return { err: { InstructionError: [i, 'InvalidInstructionData'] } };
      const [src, mint, dest, auth] = ix.accountKeyIndexes.map((k) => keys[k].toBase58());
      const amount = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true);
      const from = next.get(src), to = next.get(dest);
      if (!from || !to) return { err: { InstructionError: [i, 'InvalidAccountData'] } };
      if (from.mint !== mint || to.mint !== mint) return bad(3); // MintMismatch
      if (ix.accountKeyIndexes[3] >= m.header.numRequiredSignatures) return { err: { InstructionError: [i, 'MissingRequiredSignature'] } };
      if (from.amount < amount) return bad(1); // InsufficientFunds
      if (auth !== from.owner) {
        if (auth !== from.delegate || from.allowance < amount) return bad(4); // OwnerMismatch
        from.allowance -= amount;
        if (from.allowance === 0n) from.delegate = null;
      }
      from.amount -= amount; to.amount += amount;
    }
    return { err: null, next };
  }

  const info = (address) => {
    const a = accounts.get(address);
    if (!a) return null;
    return { owner: TOKEN_PROGRAM.toBase58(), lamports: 2039280, data: { program: 'spl-token', parsed: { type: 'account', info: {
      mint: a.mint, owner: a.owner, state: 'initialized', tokenAmount: { amount: String(a.amount), decimals: 6, uiAmount: Number(a.amount) / 1e6 },
      ...(a.delegate ? { delegate: a.delegate, delegatedAmount: { amount: String(a.allowance), decimals: 6, uiAmount: Number(a.allowance) / 1e6 } } : {}),
    } } } };
  };
  const mintInfo = () => ({ owner: TOKEN_PROGRAM.toBase58(), lamports: 1461600, data: { program: 'spl-token', parsed: { type: 'mint', info: {
    decimals: 6, supply: String([...accounts.values()].filter((a) => a.mint === USDC).reduce((n, a) => n + a.amount, 0n)), mintAuthority: 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG', freezeAuthority: '7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar', isInitialized: true,
  } } } });
  const decode = (b64) => VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  const methods = {
    getLatestBlockhash: () => ({ value: { blockhash: chain.newBlockhash(), lastValidBlockHeight: 150 + n++ } }),
    getAccountInfo: ([address]) => ({ value: address === USDC ? mintInfo() : info(address) }),
    getTokenLargestAccounts: ([mint]) => ({ value: [...accounts].filter(([, a]) => a.mint === mint).sort((a, b) => Number(b[1].amount - a[1].amount)).slice(0, 20).map(([address, a]) => ({ address, amount: String(a.amount), decimals: 6 })) }),
    getBalance: ([address]) => ({ value: lamports.get(address) || 0 }),
    getTokenAccountsByOwner: ([owner, filter]) => ({ value: [...accounts].filter(([, a]) => a.owner === owner && (!filter.mint || a.mint === filter.mint)).map(([pubkey]) => ({ pubkey, account: info(pubkey) })) }),
    simulateTransaction: ([b64, cfg]) => ({ value: { err: run(decode(b64), cfg?.sigVerify).err, logs: [] } }),
    sendTransaction: ([b64]) => {
      const tx = decode(b64), signature = bs58.encode(tx.signatures[0]);
      chain.sent.push(signature);
      if (chain.mode === 'drop') return signature;
      const r = run(tx, true);
      if (r.next) for (const [k, v] of r.next) accounts.set(k, v);
      if (chain.mode === 'late') waiting.set(signature, chain.lateBy);
      statuses.set(signature, { err: r.err });
      return signature;
    },
    getSignatureStatuses: ([[signature]]) => {
      if (waiting.has(signature)) {
        waiting.set(signature, waiting.get(signature) - 1);
        if (waiting.get(signature) > 0) return { value: [null] };
        waiting.delete(signature);
      }
      const s = statuses.get(signature);
      return { value: [s ? { err: s.err, confirmationStatus: 'confirmed' } : null] };
    },
  };

  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url?.url || url) !== RPC_URL) return real(url, init);
    const { method, params } = JSON.parse(init.body);
    const body = methods[method] ? { jsonrpc: '2.0', id: 1, result: methods[method](params) } : { jsonrpc: '2.0', id: 1, error: { message: `fake chain has no ${method}` } };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return chain;
}
