-- CHAOS BEAT 作り替え：最大コンボを記録する。
-- スコアの意味も変わる（5ラウンド合計 → 30秒合計）ため、切替時に既存行はクリアする（別途 DELETE 実行）。
-- 適用:
--   本番: wrangler d1 migrations apply chaos_pendulum --remote

ALTER TABLE chaos_pendulum_scores
  ADD COLUMN max_combo INTEGER NOT NULL DEFAULT 0;

-- 難易度別・スコア→最大コンボ順の並べ替え用
CREATE INDEX IF NOT EXISTS idx_cp_diff_score_combo
  ON chaos_pendulum_scores (difficulty, score DESC, max_combo DESC, created_at ASC);
