CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE reviews (
 id uuid PRIMARY KEY, environment text NOT NULL CHECK (environment IN ('local','testnet')), epoch text NOT NULL,
 owner text NOT NULL, intent_id text NOT NULL, revision integer NOT NULL CHECK (revision>0),
 intent_hash text NOT NULL, envelope_digest text NOT NULL, candidate jsonb NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_expiry ON reviews(expires_at);
CREATE TABLE attempts (
 environment text NOT NULL CHECK (environment IN ('local','testnet')), tx_hash text NOT NULL CHECK (tx_hash ~ '^[a-f0-9]{64}$'),
 epoch text NOT NULL, signed_envelope_digest text NOT NULL, owner text NOT NULL, intent_id text NOT NULL, intent_hash text NOT NULL,
 review_id uuid REFERENCES reviews(id) ON DELETE SET NULL,
 state text NOT NULL CHECK (state IN ('recorded','pending','unknown','succeeded','failed')) DEFAULT 'recorded',
 observation jsonb, version bigint NOT NULL DEFAULT 0, next_check_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (environment,tx_hash)
);
CREATE INDEX attempts_due ON attempts(next_check_at) WHERE state NOT IN ('succeeded','failed');
CREATE TABLE submission_keys (
 environment text NOT NULL, key_hash text NOT NULL, signed_envelope_digest text NOT NULL, tx_hash text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', PRIMARY KEY(environment,key_hash),
 FOREIGN KEY(environment,tx_hash) REFERENCES attempts(environment,tx_hash) ON DELETE CASCADE
);
CREATE TABLE signed_payloads (
 environment text NOT NULL, tx_hash text NOT NULL, encrypted bytea NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 PRIMARY KEY(environment,tx_hash), FOREIGN KEY(environment,tx_hash) REFERENCES attempts(environment,tx_hash) ON DELETE CASCADE
);
CREATE TABLE worker_leases (
 environment text NOT NULL, tx_hash text NOT NULL, worker_id uuid NOT NULL, lease_until timestamptz NOT NULL,
 PRIMARY KEY(environment,tx_hash), FOREIGN KEY(environment,tx_hash) REFERENCES attempts(environment,tx_hash) ON DELETE CASCADE
);
