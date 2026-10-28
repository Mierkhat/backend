CREATE TABLE withdrawal_watches (
  id uuid PRIMARY KEY,
  capability_hash text NOT NULL CHECK (length(capability_hash)=64),
  owner text NOT NULL,
  epoch text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('exit','migration')),
  shares_raw text NOT NULL,
  minimum_raw text NOT NULL,
  movement_bps integer NOT NULL CHECK (movement_bps BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_eligible boolean NOT NULL DEFAULT false,
  cycle integer NOT NULL DEFAULT 0,
  observation jsonb
);
CREATE INDEX withdrawal_watches_due ON withdrawal_watches(next_check_at);
CREATE TABLE withdrawal_notifications (
  id uuid PRIMARY KEY,
  watch_id uuid NOT NULL REFERENCES withdrawal_watches(id) ON DELETE CASCADE,
  cycle integer NOT NULL,
  observation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  UNIQUE(watch_id,cycle)
);
