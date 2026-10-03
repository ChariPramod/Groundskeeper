-- Versioned immutable projections keep legacy backfills and every writer identical.
-- Adding STORED generated columns calculates existing rows without modifying reports.
CREATE FUNCTION gk_analysis_summary_v1(report JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  field TEXT;
  candidate JSONB;
  amount DOUBLE PRECISION;
  counts JSONB := '{}'::jsonb;
BEGIN
  FOREACH field IN ARRAY ARRAY['total_claims', 'affected_claims'] LOOP
    candidate := report -> 'health' -> field;
    amount := 0;
    IF jsonb_typeof(candidate) = 'number' THEN
      BEGIN
        -- Match JavaScript's Number.isSafeInteger after JSON number decoding.
        amount := (candidate #>> '{}')::double precision;
        IF amount < 0 OR amount > 9007199254740991 OR amount <> trunc(amount) THEN
          amount := 0;
        END IF;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        amount := 0;
      END;
    END IF;
    counts := counts || jsonb_build_object(field, amount::bigint);
  END LOOP;
  RETURN jsonb_build_object(
    'version', 1,
    'totalClaims', counts -> 'total_claims',
    'affectedClaims', counts -> 'affected_claims'
  );
END;
$$;

CREATE FUNCTION gk_verification_summary_v1(report JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  item JSONB;
  outcome TEXT;
  outcomes JSONB := '[]'::jsonb;
  total BIGINT := 0;
  all_passed BOOLEAN := true;
  has_failed BOOLEAN := false;
BEGIN
  IF jsonb_typeof(report -> 'evidence') = 'array' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(report -> 'evidence') LOOP
      total := total + 1;
      outcome := CASE WHEN jsonb_typeof(item -> 'outcome') = 'string' THEN item ->> 'outcome' END;
      all_passed := all_passed AND coalesce(outcome = 'passed', false);
      has_failed := has_failed OR coalesce(outcome = 'failed', false);
      IF total <= 100 THEN
        outcomes := outcomes || jsonb_build_array(
          CASE WHEN outcome IN ('passed', 'failed', 'skipped', 'error') THEN outcome ELSE 'error' END
        );
      END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object(
    'version', 1,
    'evidenceCount', total,
    'outcomes', outcomes,
    'allPassed', total > 0 AND all_passed,
    'hasFailed', has_failed
  );
END;
$$;

ALTER TABLE "AnalysisRun" ADD COLUMN "summary" JSONB
  GENERATED ALWAYS AS (gk_analysis_summary_v1("report")) STORED NOT NULL;
ALTER TABLE "VerificationRun" ADD COLUMN "summary" JSONB
  GENERATED ALWAYS AS (gk_verification_summary_v1("report")) STORED NOT NULL;

CREATE INDEX "AnalysisRun_repositoryId_createdAt_id_idx" ON "AnalysisRun"("repositoryId", "createdAt", "id");
DROP INDEX "AnalysisRun_repositoryId_createdAt_idx";
CREATE INDEX "VerificationRun_analysisRunId_createdAt_id_idx" ON "VerificationRun"("analysisRunId", "createdAt", "id");
DROP INDEX "VerificationRun_analysisRunId_createdAt_idx";
-- Supports tenant queue ordering and unfinished-job scans; worker claim indexes remain intact.
CREATE INDEX "WebhookDelivery_installation_pending_idx"
  ON "WebhookDelivery"("installationId", "processedAt", "receivedAt", "id");
