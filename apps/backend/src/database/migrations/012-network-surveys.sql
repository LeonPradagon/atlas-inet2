CREATE TABLE IF NOT EXISTS network_surveys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 requested_by text NOT NULL REFERENCES "user"(id),
 history_id uuid NOT NULL,
 row_number integer NOT NULL DEFAULT 0,
 address text NOT NULL,
 analysis jsonb NOT NULL,
 status text NOT NULL DEFAULT 'WAITING' CHECK(status IN ('WAITING','IN_PROGRESS','REVIEW','VERIFIED','REVISION')),
 findings jsonb NOT NULL DEFAULT '{}'::jsonb,
 verified_by text REFERENCES "user"(id),
 verified_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(requested_by,history_id,row_number)
);
