# BODEGA

https://usebodega.fun

The corner store for AI agents. APIs sold one call at a time, paid in USDC on Solana. The agent pays only when the call is answered, and the seller is paid in that same transaction. BODEGA never holds the money.

## How one call goes

1. The agent POSTs to `/v1/buy/<item>`. With no payment it gets `402` and a quote: the price, the seller's USDC account and amount, the fee account and amount, the fee payer and a fresh blockhash.
2. The agent builds one transaction from the quote (a compute limit, a USDC transfer to the seller, a USDC transfer of the fee, a memo), signs it and sends the same request again with the transaction in the `X-Payment` header. Nothing is on chain yet.
3. The gateway checks that the transaction is exactly the quoted payment and nothing else, reads the paying account, signs as fee payer and simulates it. Then it calls the seller.
4. Only when the seller answers with 2xx does the gateway send the transaction. The answer is released once the chain confirms it, with a receipt that names the transaction.

A seller error, a timeout or an unreachable seller means the transaction is never sent. It expires with its blockhash about a minute later.

## The rules we picked

- **The answer waits for the money.** If the transaction is sent but has not confirmed in about 20 seconds, the call returns `202` with a receipt URL. The answer is handed over there once the chain shows the payment. If it never lands, nothing was charged and no answer is given.
- **The seller carries one small risk.** A buyer can move their USDC away in the seconds between the simulation and the send. Then the seller did one call for nothing and the buyer gets no answer. The gateway simulates right before calling the seller and gives the seller 25 seconds, to keep that window short.
- **The fee payer signs only what is on the list.** A payment may contain a compute limit (up to 40,000 units), a compute price (up to 50,000 micro-lamports), the quoted USDC transfers and one memo. Anything else, any instruction that touches the fee payer, a third signer or an address table is refused.
- **Failed calls are counted, not hidden.** Each item shows calls paid on chain and calls the seller failed. A 4xx from the seller is the seller turning down an input: not charged, not counted.
- **The budget is the chain's, not ours.** The owner approves the agent's key as SPL delegate on their USDC account up to a limit. The token program refuses anything past it, and the owner can revoke it from their wallet.

## Fee

3% of the price, taken from the seller's part in the same transaction (`FEE_BPS`). A seller holding `HOLD_MIN` of the token pays no fee once `TOKEN_ADDRESS` is set.

## Agent kit

```bash
npm i -g github:Use-Bodega/bodega
bodega init                      # makes the agent key, prints its address
bodega owner <your wallet>       # pay from your wallet, inside the limit you set on the site
bodega limit 0.10                # the most it signs for one call
bodega shelf
bodega buy sol-wallet address=<wallet>
bodega mcp                       # stdio MCP server: bodega_shelf, bodega_budget, bodega_buy
```

Without `owner` the agent pays from its own wallet: send a few USDC to its address.

Sellers list from the site with a browser wallet, or with a keypair file:

```bash
bodega list payout.json slug=my-api url=https://api.example.com/run priceUsd=0.05 name="My API" summary="What it returns"
```

Every forwarded call carries `x-bodega-timestamp`, `x-bodega-call`, `x-bodega-buyer` and `x-bodega-signature` (`sha256=` plus HMAC-SHA256 of `timestamp.body` with the item's secret).

## Layout

- `core/bodega.mjs` builds the payment (agent side) and inspects it (gateway side).
- `worker/` is the Cloudflare Worker: gateway, shelf, ledger, D1 schema. `node worker/dev.mjs` runs it under Node with SQLite.
- `agent/` is the CLI, SDK and MCP server.
- `site/` is the site, served by the worker: home, shelf, agents, sell, register and docs pages with one `style.css` and `app.js`. The pages are built from `site-src/pages` by `node site-src/build.mjs`, which adds the shared header, nav and footer.

## Run your own

```bash
cd worker
npx wrangler d1 create bodega            # paste the id into wrangler.toml
npx wrangler d1 execute bodega --remote --file schema.sql
npx wrangler secret put FEE_PAYER_KEY     # a key holding a little SOL for network fees
npx wrangler secret put SOL_RPC_URL
npx wrangler deploy
```

Set `FEE_TO` and `HOUSE_PAY_TO` in `wrangler.toml` to wallets that already have a USDC account.

## Tests

```bash
node test/e2e.mjs          # 60 checks: the whole flow, worker in-process, a local seller API, a faked chain
node test/kit.mjs          # 11 checks: the agent kit against the same
node test/mainnet-sim.mjs  # read-only: the split payment simulated on mainnet's real token program
```

`test/fake-chain.mjs` is our own small model of USDC accounts, delegates, signatures and blockhash expiry. It is not the real token program; `mainnet-sim.mjs` covers that part without sending anything.
