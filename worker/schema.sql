-- One row per payment a call is being run for, so the same signed transaction can never buy two results.
-- Dropped again when the call fails before the transaction is sent.
CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, at INTEGER NOT NULL);

-- Settled payments only. Every row is a confirmed transaction. value and fee are USDC units.
CREATE TABLE IF NOT EXISTS payments (
  tx TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  house INTEGER NOT NULL,
  seller TEXT NOT NULL,
  buyer TEXT NOT NULL,
  value INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  own INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_at ON payments (at DESC);

-- A sent transaction that had not confirmed when the call returned. The answer waits here for ten minutes,
-- and is handed over on /v1/receipt/:tx once the chain shows the payment.
CREATE TABLE IF NOT EXISTS held (tx TEXT PRIMARY KEY, row TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL);

-- Per item: calls that were paid, and calls the seller failed (error, timeout, no answer). Failed calls are never charged.
CREATE TABLE IF NOT EXISTS counts (item TEXT PRIMARY KEY, paid INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0);

-- Items listed by sellers. pay_to signed the listing and is the only wallet that can change it.
CREATE TABLE IF NOT EXISTS items (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  docs TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  value INTEGER NOT NULL,
  pay_to TEXT NOT NULL,
  secret TEXT NOT NULL,
  open INTEGER NOT NULL DEFAULT 1,
  hidden INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS uses (day TEXT NOT NULL, who TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, who, kind));
