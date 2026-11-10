// BODEGA site: one script for every page. Each part runs only on the page that has its elements.
(() => {
  // filled in at launch
  const CONFIG = { contract: '', repo: 'Use-Bodega/bodega', x: 'https://x.com/usebodega_x' };
  const $ = (id) => document.getElementById(id);
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const short = (s) => `${s.slice(0, 4)}…${s.slice(-4)}`;
  const api = async (path, init) => { const r = await fetch(path, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const say = (id, html) => { $(id).hidden = false; $(id).innerHTML = html; };
  const base58 = (bytes) => {
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', d = [0];
    for (const b of bytes) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
    let out = ''; for (const b of bytes) { if (b) break; out += '1'; }
    return out + d.reverse().map((i) => A[i]).join('');
  };

  // ---------- every page: the nav, the links, the token ----------
  const here = location.pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
  document.querySelectorAll('.sign nav a').forEach((a) => { if ((a.getAttribute('href').replace(/\.html$/, '') || '/') === here) a.setAttribute('aria-current', 'page'); });
  document.querySelectorAll('[data-x]').forEach((a) => { if (CONFIG.x) { a.hidden = false; a.href = CONFIG.x; } });
  document.querySelectorAll('[data-repo]').forEach((a) => { if (CONFIG.repo) { a.hidden = false; a.href = `https://github.com/${CONFIG.repo}`; } });
  document.querySelectorAll('[data-repo-text]').forEach((el) => { el.textContent = CONFIG.repo; });
  if (CONFIG.contract && $('ca')) {
    $('ca').hidden = false; $('ca-text').textContent = CONFIG.contract; $('ca-pump').href = `https://pump.fun/coin/${CONFIG.contract}`;
    $('ca-copy').onclick = () => { navigator.clipboard.writeText(CONFIG.contract); $('ca-copy').textContent = 'Copied'; };
  }
  api('/v1').then((v) => { if (v.body.feeBps !== undefined) document.querySelectorAll('[data-fee]').forEach((el) => { el.textContent = v.body.feeBps / 100; }); }).catch(() => {});

  // ---------- the shelf and the counter ----------
  let shelf = [];
  function drawShelf(limit) {
    if (!$('items')) return;
    const list = limit ? shelf.slice(0, limit) : shelf;
    const cards = list.map((s) => `<div class="item"><span class="tag">$${s.priceUsd}</span><h3>${esc(s.name)}</h3><p>${esc(s.summary)}</p>
      <div class="meta"><span class="who ${s.house ? '' : 'out'}">${s.house ? 'house' : esc(short(s.seller || ''))}</span><span>paid ${s.paidCalls} · failed ${s.failedCalls}</span></div>
      ${s.house ? `<button class="plain" data-sample="${esc(s.slug)}">Free sample</button>` : ''}</div>`);
    if (!limit) cards.push('<div class="empty"><b>Your API here.</b><span style="font-size:14px;color:var(--muted)">List it in two minutes and get paid per call.</span><a href="/sell" style="margin-top:8px;font-weight:800">Sell here</a></div>');
    $('items').innerHTML = cards.join('');
  }
  const current = () => shelf.find((s) => s.slug === $('c-item').value);
  function drawFields() {
    const s = current();
    $('c-fields').innerHTML = s ? s.input.map((f) => `<label for="f-${esc(f.name)}">${esc(f.name)}${f.required ? '' : ' (optional)'}</label><input id="f-${esc(f.name)}" value="${esc(f.example || '')}" placeholder="${esc(f.description || '')}" autocomplete="off">`).join('') : '';
  }
  const input = () => Object.fromEntries(current().input.map((f) => [f.name, $(`f-${f.name}`).value.trim()]).filter(([, v]) => v));
  async function run(kind) {
    const s = current(), out = $('c-out');
    if (!s) return;
    out.innerHTML = '<span class="dim">Asking…</span>';
    const t = Date.now(), r = await post(`/v1/${kind}/${s.slug}`, input()).catch(() => ({ status: 0, body: { error: { code: 'offline' } } }));
    const note = kind === 'buy' && r.status === 402 ? 'HTTP 402: this is what the agent signs. sellerAmount goes to the seller, feeAmount to the fee wallet.' : `HTTP ${r.status} in ${Date.now() - t} ms${kind === 'sample' && r.status === 200 ? ', free sample' : ''}`;
    out.innerHTML = `<span class="dim">${esc(note)}</span>\n\n${esc(JSON.stringify(r.body, null, 2))}`;
  }
  async function loadShelf() {
    if (!$('items')) return;
    const r = await api('/v1/shelf').catch(() => null);
    if (!r?.body.data) { $('items').innerHTML = '<div class="empty">The shelf could not be loaded. Try again in a moment.</div>'; return; }
    shelf = r.body.data;
    drawShelf(Number($('items').dataset.limit) || 0);
    if ($('c-item')) {
      $('c-item').innerHTML = shelf.filter((s) => s.house).map((s) => `<option value="${esc(s.slug)}">${esc(s.name)} · $${s.priceUsd}</option>`).join('');
      const want = new URLSearchParams(location.search).get('item');
      if (want && shelf.some((s) => s.slug === want && s.house)) $('c-item').value = want;
      drawFields();
    }
  }
  if ($('items')) {
    $('items').addEventListener('click', (e) => {
      const slug = e.target.dataset?.sample;
      if (!slug) return;
      if (!$('c-item')) { location.href = `/shelf?item=${encodeURIComponent(slug)}#counter`; return; }
      $('c-item').value = slug; drawFields(); $('counter').scrollIntoView(); run('sample');
    });
  }
  if ($('c-item')) {
    $('c-item').addEventListener('change', drawFields);
    $('c-sample').addEventListener('click', () => run('sample'));
    $('c-quote').addEventListener('click', () => run('buy'));
  }
  loadShelf();

  // ---------- the register ----------
  const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
  async function drawRegister() {
    const limit = Number($('ledger')?.dataset.limit) || 50;
    const [s, l] = await Promise.all([api('/v1/stats'), $('ledger') ? api(`/v1/ledger?limit=${limit}`) : null]);
    if (s.status === 200 && $('n-paid')) {
      $('n-paid').textContent = s.body.paidCalls; $('n-failed').textContent = s.body.failedCallsNotCharged;
      $('n-vol').textContent = `$${s.body.paidToSellersUsd.toFixed(2)}`; $('n-out').textContent = s.body.outsideCalls;
    }
    if (l?.body.data?.length) $('ledger').innerHTML = l.body.data.map((r) => `<tr><td>${ago(r.at)}</td><td>${esc(r.item)}</td><td>$${r.paidUsd}</td><td>${esc(short(r.buyer))}${r.own ? ' (ours)' : ''}</td><td>${r.house ? 'house' : esc(short(r.seller))}</td><td><a href="${esc(r.explorer)}" target="_blank" rel="noopener">${esc(short(r.tx))}</a></td></tr>`).join('');
  }
  if ($('n-paid') || $('ledger')) drawRegister().catch(() => {});

  // ---------- the wallet ----------
  let owner = null;
  async function connect() {
    if (!window.solana?.isPhantom) throw new Error('Phantom was not found in this browser.');
    owner = (await window.solana.connect()).publicKey.toString();
    return owner;
  }
  const walletError = (e, fallback) => esc(e.message?.includes('Phantom') ? e.message : fallback);

  // ---------- the budget ----------
  const describe = (b) => (b.usdcAccount ? `USDC ${b.balanceUsd}<br>Agent key: ${b.delegate ? esc(b.delegate) : 'none'}<br>Limit left: ${b.allowanceUsd} USDC` : 'This wallet has no USDC account yet. Receive any USDC first, then set the budget.');
  const readBudget = async (w) => (await api(`/v1/budget?owner=${encodeURIComponent(w)}`)).body;
  async function refresh() {
    if (!owner) return null;
    const b = await readBudget(owner);
    if (b.error) { say('b-state', '<span class="bad">Could not read the chain. Try again.</span>'); return null; }
    say('b-state', `Wallet ${esc(short(owner))}<br>${describe(b)}`);
    $('b-approve').disabled = !b.usdcAccount; $('b-revoke').disabled = !b.delegate;
    return b;
  }
  // ApproveChecked is SPL instruction 13, Revoke is 5.
  function approveIx(w3, source, delegate, units) {
    const data = new Uint8Array(10);
    data[0] = 13; new DataView(data.buffer).setBigUint64(1, units, true); data[9] = 6;
    return new w3.TransactionInstruction({ programId: new w3.PublicKey(TOKEN), data, keys: [
      { pubkey: new w3.PublicKey(source), isSigner: false, isWritable: true }, { pubkey: new w3.PublicKey(USDC), isSigner: false, isWritable: false },
      { pubkey: new w3.PublicKey(delegate), isSigner: false, isWritable: false }, { pubkey: new w3.PublicKey(owner), isSigner: true, isWritable: false },
    ] });
  }
  const revokeIx = (w3, source) => new w3.TransactionInstruction({ programId: new w3.PublicKey(TOKEN), data: new Uint8Array([5]), keys: [
    { pubkey: new w3.PublicKey(source), isSigner: false, isWritable: true }, { pubkey: new w3.PublicKey(owner), isSigner: true, isWritable: false },
  ] });
  async function send(ix) {
    const w3 = window.solanaWeb3, { blockhash, lastValidBlockHeight } = (await api('/v1/blockhash')).body;
    const tx = new w3.Transaction({ feePayer: new w3.PublicKey(owner), blockhash, lastValidBlockHeight }).add(ix);
    const { signature } = await window.solana.signAndSendTransaction(tx);
    $('b-state').innerHTML += `<br><span class="good">Sent.</span> <a href="https://solscan.io/tx/${esc(signature)}" target="_blank" rel="noopener">View transaction</a>`;
    setTimeout(refresh, 6000);
  }
  if ($('b-connect')) {
    $('b-connect').addEventListener('click', async () => {
      try { await connect(); $('b-connect').textContent = 'Connected'; await refresh(); } catch (e) { say('b-state', `<span class="bad">${walletError(e, 'The connection was declined.')}</span>`); }
    });
    $('b-approve').addEventListener('click', async () => {
      const agent = $('b-agent').value.trim(), usd = Number($('b-usd').value);
      if (!ADDRESS.test(agent)) return say('b-state', '<span class="bad">Paste the agent address first.</span>');
      if (agent === owner) return say('b-state', '<span class="bad">The agent needs its own key, not your wallet.</span>');
      if (!(usd > 0)) return say('b-state', '<span class="bad">Pick a limit above zero.</span>');
      try { const b = await readBudget(owner); await send(approveIx(window.solanaWeb3, b.usdcAccount, agent, BigInt(Math.round(usd * 1e6)))); } catch { say('b-state', '<span class="bad">The transaction was not sent.</span>'); }
    });
    $('b-revoke').addEventListener('click', async () => {
      try { const b = await readBudget(owner); await send(revokeIx(window.solanaWeb3, b.usdcAccount)); } catch { say('b-state', '<span class="bad">The transaction was not sent.</span>'); }
    });
  }
  if ($('b-read')) {
    $('b-read').addEventListener('click', async () => {
      const w = $('b-check').value.trim();
      if (!ADDRESS.test(w)) return say('b-read-out', '<span class="bad">That is not a wallet address.</span>');
      const b = await readBudget(w);
      say('b-read-out', b.error ? '<span class="bad">Could not read the chain. Try again.</span>' : describe(b));
    });
  }

  // ---------- a seller's listing ----------
  const WHY = { chain_busy: 'Could not read the chain just now. Try again in a moment.', invalid_slug: 'The short name needs 3 to 32 characters: a-z, 0-9 and dashes.', slug_taken: 'That name is taken by a house item.', invalid_text: 'Fill in the title and the one-line summary.', invalid_price: 'The price is outside the allowed range.', invalid_url: 'The endpoint must be https on a public host.', no_usdc_account: 'This wallet has no USDC account yet. Receive any USDC once, then list again.', not_yours: 'That name belongs to another wallet.', too_many: 'Too many new items from here today.', bad_signature: 'The signature did not match the wallet.' };
  if ($('s-list')) {
    $('s-list').addEventListener('click', async () => {
      try {
        const payTo = owner || await connect();
        const s = { slug: $('s-slug').value.trim(), url: $('s-url').value.trim(), priceUsd: Number($('s-price').value), payTo, open: true, at: Math.floor(Date.now() / 1000) };
        // the same text the gateway rebuilds and checks the signature against
        const message = `BODEGA listing\nslug: ${s.slug}\nurl: ${s.url}\nprice: ${s.priceUsd} USDC per call\npay to: ${s.payTo}\nopen: yes\nat: ${s.at}`;
        const signed = await window.solana.signMessage(new TextEncoder().encode(message), 'utf8');
        const r = await post('/v1/shelf', { ...s, name: $('s-name').value.trim(), summary: $('s-summary').value.trim(), docs: $('s-docs').value.trim(), signature: base58(signed.signature) });
        if (r.body.error) return say('s-state', `<span class="bad">${esc(WHY[r.body.error.code] || r.body.error.message)}</span>`);
        say('s-state', `<span class="good">${r.status === 201 ? 'Listed.' : 'Updated.'}</span> Agents call it at<br>${esc(r.body.buy)}${r.body.signingSecret ? `<br><br>Signing secret, shown once:<br><b>${esc(r.body.signingSecret)}</b>` : ''}`);
      } catch (e) { say('s-state', `<span class="bad">${walletError(e, 'Nothing was signed.')}</span>`); }
    });
  }
})();
