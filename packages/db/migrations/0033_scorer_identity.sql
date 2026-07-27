DELETE FROM _smithers_scorers
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY run_id, node_id, iteration, attempt, scorer_id, source
        ORDER BY scored_at_ms DESC, id DESC
      ) AS duplicate_rank
    FROM _smithers_scorers
  ) ranked
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS _smithers_scorers_identity_uidx
  ON _smithers_scorers (run_id, node_id, iteration, attempt, scorer_id, source);
