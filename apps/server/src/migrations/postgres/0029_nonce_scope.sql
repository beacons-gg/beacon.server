-- 0029_nonce_scope (postgres): a capability nonce is remembered per actor and op, not on its own.
--
-- Keyed on the nonce alone, a write that reused another write's nonce got that op's stored answer
-- back and was never applied, and one account could spend a nonce it saw another account use. The
-- key is now (actor, op, nonce), so two requests that differ in signer or op never share a memo.
--
-- The rows already here were recorded without an actor or op. They keep '' for both, and the
-- server still reads them by nonce for one retention window after it starts, so a request retried
-- across the upgrade is not applied twice. The sweep clears them minutes later.
ALTER TABLE capability_nonces ADD COLUMN IF NOT EXISTS actor TEXT COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE capability_nonces ADD COLUMN IF NOT EXISTS op TEXT COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE capability_nonces DROP CONSTRAINT IF EXISTS capability_nonces_pkey;
ALTER TABLE capability_nonces ADD PRIMARY KEY (actor, op, nonce);

-- A mailbox row's own send dedup, the same way: per sender. Keyed on the nonce alone, a second
-- account's send that reused a nonce got the first account's message id back and was dropped.
ALTER TABLE mailbox DROP CONSTRAINT IF EXISTS mailbox_nonce_key;
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_sender_nonce_idx ON mailbox (sender, nonce);
