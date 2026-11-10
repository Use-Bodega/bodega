#!/usr/bin/env node
import { BASE_URL, approve, budget, buy, initAgent, keyFromFile, list, loadConfig, saveConfig, shelf } from './bodega.mjs';
import { serve } from './mcp.mjs';

const [cmd, ...args] = process.argv.slice(2);
const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

const parseArgs = (rest) => Object.fromEntries(rest.map((a) => {
  const i = a.indexOf('=');
  const v = a.slice(i + 1);
  return [a.slice(0, i), v !== '' && !Number.isNaN(Number(v)) && !/^[1-9A-HJ-NP-Za-km-z]{32,}$/.test(v) ? Number(v) : v];
}));

const commands = {
  init() {
    const c = initAgent();
    print(`Agent address: ${c.agent}\n\nTwo ways to give it money:\n1. A budget: open ${BASE_URL}, connect your wallet, paste this address, set a USDC limit and sign once. Then run: bodega owner <your wallet>\n2. Its own wallet: send a few USDC to the address above. Nothing else to set.`);
  },
  owner([wallet]) {
    const c = loadConfig() || initAgent();
    saveConfig({ ...c, owner: wallet || null });
    print(wallet ? `Paying from ${wallet}, inside the allowance it gave this key.` : 'Paying from the agent\'s own wallet.');
  },
  limit([usd]) {
    const c = loadConfig() || initAgent();
    saveConfig({ ...c, maxPrice: Number(usd) });
    print(`Most the agent signs for one call: $${usd}`);
  },
  async budget() { print(await budget(loadConfig() || initAgent())); },
  async shelf() { print((await shelf()).map((s) => `${s.slug.padEnd(16)} $${String(s.priceUsd).padEnd(6)} paid ${s.paidCalls} / failed ${s.failedCalls}  ${s.summary}`).join('\n')); },
  async buy([slug, ...rest]) { print(await buy(loadConfig(), slug, parseArgs(rest))); },
  // for an owner with a keypair file; browser wallets set the budget on the site
  async approve([usd, file]) { print(`Budget set: ${await approve(loadConfig() || initAgent(), keyFromFile(file), Number(usd))}`); },
  // a seller lists an item: bodega list <payout keypair file> slug=.. url=.. priceUsd=.. name=.. summary=..
  async list([file, ...rest]) { print(await list(keyFromFile(file), parseArgs(rest))); },
  mcp() { serve(); },
};

if (!commands[cmd]) {
  print('bodega init | owner <wallet> | limit <usd> | budget | shelf | buy <slug> key=value | approve <usd> <owner keypair file> | list <payout keypair file> slug= url= priceUsd= name= summary= | mcp');
} else {
  Promise.resolve(commands[cmd](args)).catch((e) => { console.error(e.message); process.exit(1); });
}
