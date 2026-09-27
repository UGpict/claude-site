-- 難易度（easy / normal / hard / oni）を記録し、難易度別ランキングを可能にする。
-- 既存行は normal 扱い（デフォルト値）。
-- 適用:
--   ローカル: wrangler d1 migrations apply chaos_pendulum --local
--   本番:     wrangler d1 migrations apply chaos_pendulum --remote

ALTER TABLE chaos_pendulum_scores
  ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'normal';

-- 難易度でしぼったうえで並べるためのインデックス
CREATE INDEX IF NOT EXISTS idx_cp_diff_ranking
  ON chaos_pendulum_scores (difficulty, score DESC, perfect_count DESC, average_distance ASC, created_at ASC);

-- 難易度＋期間フィルタ用
CREATE INDEX IF NOT EXISTS idx_cp_diff_created
  ON chaos_pendulum_scores (difficulty, created_at);
