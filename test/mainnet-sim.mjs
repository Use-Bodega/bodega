// Read-only check on mainnet: the payment the kit builds runs on the real token program.
// Nothing is signed or sent: the transaction is simulated with signature checks off, from a real USDC account to two others.
// node mainnet-sim.mjs
import { VersionedTransaction } from '@solana/web3.js';
import { USDC, buildPayment, inspectPayment, encodePayment } from '../core/bodega.mjs';

const RPC = process.env.SOL_RPC_URL || 'https://solana-rpc.publicnode.com';
const rpc = async (method, params) => {
  const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const parsed = async (address) => (await rpc('getAccountInfo', [address, { encoding: 'jsonParsed' }])).value?.data?.parsed?.info;

// well-known wallets (exchanges and our fee wallet): the first whose standard USDC account holds money pays, two others receive
const { ata } = await import('../core/bodega.mjs');
const WALLETS = ['5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', 'HELnQfJ9mtWX4eoyxQaQF1q53yBAjjxAhGLNYFJdMMxi'];
const infos = [];
for (const w of WALLETS) { const address = ata(w).toBase58(), i = await parsed(address); if (i?.mint === USDC && i.state === 'initialized') infos.push({ address, ...i }); }
const payer = infos.find((i) => BigInt(i.tokenAmount.amount) >= 10000n);
const [seller, fee] = infos.filter((i) => i !== payer);
const feePayer = payer.owner; // any account with SOL will do for a simulation
const quote = { feePayer, sellerAccount: seller.address, sellerAmount: '9700', feeAccount: fee.address, feeAmount: '300', ref: 'mainnet-sim' };
const { blockhash } = (await rpc('getLatestBlockhash', [])).value;
const tx = buildPayment({ quote, owner: payer.owner, authority: payer.owner, blockhash });

const sim = (await rpc('simulateTransaction', [encodePayment(tx), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'jsonParsed', addresses: [seller.address, fee.address] } }])).value;
if (sim.err) console.log(sim.logs);
const after = sim.err ? null : sim.accounts.map((a) => BigInt(a.data.parsed.info.tokenAmount.amount));
console.log('payer', payer.address, 'owner', payer.owner);
console.log('err', sim.err, '| units used', sim.unitsConsumed, 'of 30000');
console.log('seller +', after && after[0] - BigInt(seller.tokenAmount.amount), '| fee +', after && after[1] - BigInt(fee.tokenAmount.amount));
// and the gateway's own check accepts the same bytes (the signature check aside, since nobody signed)
const shape = inspectPayment(encodePayment(tx), quote).error;
console.log('gateway check without a signature says:', shape);
const good = sim.err === null && sim.unitsConsumed < 30000 && after?.[0] - BigInt(seller.tokenAmount.amount) === 9700n && after?.[1] - BigInt(fee.tokenAmount.amount) === 300n && shape === 'wrong_signers';
console.log(good ? 'PASS the split payment runs on mainnet' : 'FAIL');
process.exit(good ? 0 : 1);
