ALTER TABLE setup_jobs DROP CONSTRAINT setup_jobs_kind_check;
ALTER TABLE setup_jobs ADD CONSTRAINT setup_jobs_kind_check CHECK(kind IN ('trustlines','deposit','faucet','restore'));
