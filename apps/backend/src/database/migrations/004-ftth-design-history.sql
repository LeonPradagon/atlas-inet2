-- Rollback: only after removing FTTH_DESIGN history rows, restore the check to ('ADDRESS', 'BULK').
ALTER TABLE analysis_history
  DROP CONSTRAINT IF EXISTS analysis_history_analysis_type_check;

ALTER TABLE analysis_history
  ADD CONSTRAINT analysis_history_analysis_type_check
  CHECK (analysis_type IN ('ADDRESS', 'BULK', 'FTTH_DESIGN'));
