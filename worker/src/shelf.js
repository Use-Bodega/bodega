// The house items: BODEGA's own listings, so a call can be paid for on day one. Open data and the chain itself, no AI.
// They are paid like any other item; the seller is HOUSE_PAY_TO.
import { publicUrl, USDC, ata } from '../../core/bodega.mjs';
import { rpc } from './chain.js';

const fail = (code) => Object.assign(new Error(code), { input: true });
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const TOKEN_PROGRAMS = { TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'spl-token', TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'token-2022' };

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const plain = (html) => html
  .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : entities[e.toLowerCase()] ?? m))
  .replace(/[ \t\r\f]+/g, ' ').replace(/ ?\n[ \n]*/g, '\n').trim();

export const HOUSE = [
  {
    slug: 'page-text', name: 'Page Text', price: 0.01, summary: 'Fetches a web page and returns its title and readable text, without the markup.',
    input: [{ name: 'url', type: 'string', required: true, description: 'Public https page.', example: 'https://en.wikipedia.org/wiki/Convenience_store' }],
    run: async (env, { url }) => {
      const u = publicUrl(url, env.ALLOW_HTTP_UPSTREAM === '1');
      if (!u) throw fail('invalid_url');
      const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'BodegaBot/0.1 (+page-text)', accept: 'text/html,text/plain;q=0.9' } }).catch(() => null);
      if (!r || !r.ok) throw fail('fetch_failed');
      if (!/text\/|json|xml/.test(r.headers.get('content-type') || 'text/html')) throw fail('not_text');
      const html = (await r.text()).slice(0, 1_500_000);
      const text = plain(html);
      return { url: r.url || String(u), title: plain(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''), chars: text.length, truncated: text.length > 20000, text: text.slice(0, 20000) };
    },
  },
  {
    slug: 'coin-price', name: 'Coin Price', price: 0.01, summary: 'Current USD prices for up to 20 coins by CoinGecko id, from DefiLlama.',
    input: [{ name: 'ids', type: 'string', required: true, pattern: /^[a-z0-9-]+(,[a-z0-9-]+){0,19}$/, description: 'CoinGecko ids, comma separated.', example: 'solana,bitcoin' }],
    run: async (_env, { ids }) => {
      const j = await getJson(`https://coins.llama.fi/prices/current/${ids.split(',').map((i) => `coingecko:${i}`).join(',')}`);
      const prices = Object.fromEntries(ids.split(',').map((i) => [i, j.coins?.[`coingecko:${i}`] ? { usd: j.coins[`coingecko:${i}`].price, symbol: j.coins[`coingecko:${i}`].symbol, at: j.coins[`coingecko:${i}`].timestamp } : null]));
      if (Object.values(prices).every((p) => !p)) throw fail('unknown_coin');
      return { prices, source: 'DefiLlama' };
    },
  },
  {
    slug: 'sol-wallet', name: 'Solana Wallet', price: 0.01, summary: 'SOL and USDC balance of a wallet, and how many token accounts it holds.',
    input: [{ name: 'address', type: 'string', required: true, pattern: ADDRESS, description: 'Wallet address.', example: 'HELnQfJ9mtWX4eoyxQaQF1q53yBAjjxAhGLNYFJdMMxi' }],
    run: async (env, { address }) => {
      // the balance and the USDC account always answer; the full token list is refused by some public RPCs
      const [lamports, usdc, tokens] = await Promise.all([
        rpc(env, 'getBalance', [address]),
        rpc(env, 'getAccountInfo', [ata(address).toBase58(), { encoding: 'jsonParsed' }]),
        rpc(env, 'getTokenAccountsByOwner', [address, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]).catch(() => null),
      ]);
      const held = tokens ? tokens.value.map((a) => a.account.data.parsed.info).filter((i) => i.tokenAmount.amount !== '0') : null;
      return { address, sol: lamports.value / 1e9, usdc: usdc?.value?.data?.parsed?.info?.tokenAmount?.uiAmount || 0, tokenAccounts: tokens ? tokens.value.length : null, tokensHeld: held ? held.length : null };
    },
  },
  {
    slug: 'sol-token', name: 'Solana Token', price: 0.02, summary: 'Supply, decimals, who can still mint or freeze, and the share of the ten largest accounts.',
    input: [{ name: 'mint', type: 'string', required: true, pattern: ADDRESS, description: 'Token mint address.', example: USDC }],
    run: async (env, { mint }) => {
      const info = await rpc(env, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
      const m = info?.value?.data?.parsed;
      if (m?.type !== 'mint') throw fail('not_a_token');
      const largest = await rpc(env, 'getTokenLargestAccounts', [mint]).catch(() => null);
      const supply = Number(m.info.supply), top = largest ? largest.value.slice(0, 10).reduce((n, a) => n + Number(a.amount), 0) : null;
      return {
        mint, program: TOKEN_PROGRAMS[info.value.owner] || info.value.owner, decimals: m.info.decimals, supply: supply / 10 ** m.info.decimals,
        mintAuthority: m.info.mintAuthority || null, freezeAuthority: m.info.freezeAuthority || null,
        top10Share: top === null || !supply ? null : +(top / supply).toFixed(4),
      };
    },
  },
  {
    slug: 'sol-tx', name: 'Solana Transaction', price: 0.02, summary: 'What a transaction did: status, fee, signers and every token balance it changed.',
    input: [{ name: 'signature', type: 'string', required: true, pattern: SIGNATURE, description: 'Transaction signature.' }],
    run: async (env, { signature }) => {
      const t = await rpc(env, 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (!t) throw fail('unknown_transaction');
      const keys = t.transaction.message.accountKeys, before = new Map((t.meta.preTokenBalances || []).map((b) => [b.accountIndex, b]));
      const changes = (t.meta.postTokenBalances || []).map((b) => ({ owner: b.owner, mint: b.mint, change: (b.uiTokenAmount.uiAmount || 0) - (before.get(b.accountIndex)?.uiTokenAmount.uiAmount || 0) })).filter((c) => c.change);
      return {
        signature, ok: t.meta.err === null, error: t.meta.err, slot: t.slot, at: t.blockTime, feeSol: t.meta.fee / 1e9,
        signers: keys.filter((k) => k.signer).map((k) => k.pubkey), programs: [...new Set(t.transaction.message.instructions.map((i) => i.programId))],
        solChanges: keys.map((k, i) => ({ account: k.pubkey, change: (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9 })).filter((c) => c.change),
        tokenChanges: changes,
      };
    },
  },
  {
    slug: 'sol-fees', name: 'Solana Priority Fees', price: 0.01, summary: 'What recent blocks paid for priority, in micro-lamports per compute unit: median, 75th and 90th percentile.',
    input: [{ name: 'account', type: 'string', required: false, pattern: ADDRESS, description: 'A writable account your transaction touches, for fees local to it.' }],
    run: async (env, { account }) => {
      const rows = await rpc(env, 'getRecentPrioritizationFees', [account ? [account] : []]);
      const fees = rows.map((r) => r.prioritizationFee).sort((a, b) => a - b);
      if (!fees.length) throw new Error('no fee data');
      const at = (p) => fees[Math.min(fees.length - 1, Math.floor(fees.length * p))];
      return { slots: fees.length, median: at(0.5), p75: at(0.75), p90: at(0.9), max: fees.at(-1), unit: 'micro-lamports per compute unit' };
    },
  },
];

export const houseBy = (slug) => HOUSE.find((s) => s.slug === slug);

/// Checks a house item's input before any payment is asked for.
export function checkInput(item, body) {
  const input = {};
  for (const f of item.input) {
    const v = body?.[f.name];
    if (v === undefined || v === null || v === '') {
      if (f.required) return { error: `missing_${f.name}` };
      continue;
    }
    if (typeof v !== 'string' || v.length > 2000 || (f.pattern && !f.pattern.test(v))) return { error: `invalid_${f.name}` };
    input[f.name] = v;
  }
  return { input };
}
