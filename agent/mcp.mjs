// Local MCP server over stdio. It buys calls with the agent key, inside maxPrice and the on-chain allowance.
import readline from 'node:readline';
import { budget, buy, loadConfig, shelf } from './bodega.mjs';

const TOOLS = [
  { name: 'bodega_shelf', description: 'List the APIs on the shelf: price per call, what each one does, how many calls were paid and how many the seller failed.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bodega_budget', description: 'USDC balance of the paying wallet and the allowance the agent key has left.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bodega_buy', description: 'Call an item from the shelf and pay for it in USDC. Charged only when the call is answered.', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, input: { type: 'object' } }, required: ['slug'] } },
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

async function runTool(name, a) {
  const cfg = loadConfig();
  if (name === 'bodega_shelf') return shelf();
  if (name === 'bodega_budget') return budget(cfg);
  if (name === 'bodega_buy') return buy(cfg, a.slug, a.input || {});
  throw new Error('unknown_tool');
}

export function serve() {
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return;
    const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bodega', version: '0.1.0' } });
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: TOOLS });
    if (m.method === 'tools/call') {
      try { return ok(text(await runTool(m.params.name, m.params.arguments || {}))); } catch (e) {
        return ok({ ...text({ error: e.message }), isError: true });
      }
    }
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } });
  });
}
