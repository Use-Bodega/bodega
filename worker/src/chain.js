// Plain JSON-RPC to Solana, and the few reads the gateway needs.
import { USDC } from '../../core/bodega.mjs';

const PUBLIC_RPC = 'https://solana-rpc.publicnode.com';

export async function rpc(env, method, params, tries = 3) {
  const r = await fetch(env.SOL_RPC_URL || PUBLIC_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  // a public RPC answers 429 now and then: wait a moment and ask again
  if (r.status === 429 && tries > 1) { await new Promise((ok) => setTimeout(ok, 500)); return rpc(env, method, params, tries - 1); }
  if (!r.ok) throw new Error(`rpc ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

/// A USDC token account as the chain sees it, or null: who owns it, what it holds, who may spend from it and how much.
export async function usdcAccount(env, account) {
  const r = await rpc(env, 'getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const info = r?.value?.data?.parsed?.info;
  if (r?.value?.data?.parsed?.type !== 'account' || info?.mint !== USDC) return null;
  return { owner: info.owner, amount: BigInt(info.tokenAmount.amount), delegate: info.delegate || null, allowance: BigInt(info.delegatedAmount?.amount || 0), frozen: info.state === 'frozen' };
}

// Sellers holding the token sell with no fee. Off until TOKEN_ADDRESS is set after launch.
const holders = new Map();
export async function isHolder(env, wallet) {
  if (!env.TOKEN_ADDRESS) return false;
  const hit = holders.get(wallet);
  if (hit && Date.now() - hit.at < 60000) return hit.yes;
  const r = await rpc(env, 'getTokenAccountsByOwner', [wallet, { mint: env.TOKEN_ADDRESS }, { encoding: 'jsonParsed' }]).catch(() => null);
  if (!r) return false; // when the chain cannot be read the fee applies
  const yes = r.value.reduce((n, a) => n + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0) >= Number(env.HOLD_MIN || 1000000);
  holders.set(wallet, { yes, at: Date.now() });
  return yes;
}

/// Waits for a sent transaction: 'landed', 'failed', or 'unknown' when it has not shown up in time.
export async function waitFor(env, signature, tries = 18, gap = 1200) {
  for (let i = 0; i < tries; i++) {
    const s = (await rpc(env, 'getSignatureStatuses', [[signature]]).catch(() => null))?.value?.[0];
    if (s?.err) return 'failed';
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return 'landed';
    if (i < tries - 1) await new Promise((r) => setTimeout(r, env.POLL_MS ? Number(env.POLL_MS) : gap));
  }
  return 'unknown';
}
