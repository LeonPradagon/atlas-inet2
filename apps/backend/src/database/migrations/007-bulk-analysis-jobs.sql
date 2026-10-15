CREATE TABLE IF NOT EXISTS analysis_bulk_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  history_id uuid NOT NULL UNIQUE REFERENCES analysis_history(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','COMPLETED_WITH_ERRORS','CANCELLED','FAILED')),
  total_rows integer NOT NULL CHECK (total_rows BETWEEN 1 AND 5000),
  processed_rows integer NOT NULL DEFAULT 0,
  succeeded_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_bulk_job_rows (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES analysis_bulk_jobs(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PROCESSING','OK','ERROR','CANCELLED')),
  result jsonb,
  error_message text,
  attempts integer NOT NULL DEFAULT 0,
  processing_started_at timestamptz,
  processed_at timestamptz,
  UNIQUE(job_id,row_number)
);

CREATE INDEX IF NOT EXISTS analysis_bulk_jobs_owner_created_idx ON analysis_bulk_jobs(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS analysis_bulk_job_rows_queue_idx ON analysis_bulk_job_rows(status,job_id,row_number);
CREATE INDEX IF NOT EXISTS analysis_bulk_job_rows_page_idx ON analysis_bulk_job_rows(job_id,row_number);
