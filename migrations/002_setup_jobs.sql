CREATE TABLE setup_jobs (
 tx_hash text PRIMARY KEY CHECK(tx_hash ~ '^[a-f0-9]{64}$'),
 owner text NOT NULL, kind text NOT NULL CHECK(kind IN ('trustlines','deposit','faucet')),
 epoch text NOT NULL, signed_digest text NOT NULL, encrypted bytea,
 review jsonb, state text NOT NULL DEFAULT 'recorded' CHECK(state IN ('recorded','pending','unknown','succeeded','failed')),
 observation jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), next_check_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX setup_due ON setup_jobs(next_check_at) WHERE state NOT IN ('succeeded','failed');
CREATE INDEX faucet_owner ON setup_jobs(owner,created_at) WHERE kind='faucet';
