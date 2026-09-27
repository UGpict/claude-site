-- カオス振り子ストップ ランキング用テーブル（Cloudflare D1）
-- 適用: wrangler d1 migrations apply chaos_pendulum
--   ローカル: wrangler d1 migrations apply chaos_pendulum --local
--   本番:     wrangler d1 migrations apply chaos_pendulum --remote

CREATE TABLE IF NOT EXISTS chaos_pendulum_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  score INTEGER NOT NULL,
  perfect_count INTEGER NOT NULL,
  average_distance REAL,
  rounds INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 並び順（score DESC, perfect_count DESC, average_distance ASC, created_at ASC）に沿ったインデックス
CREATE INDEX IF NOT EXISTS idx_cp_ranking
  ON chaos_pendulum_scores (score DESC, perfect_count DESC, average_distance ASC, created_at ASC);

-- 期間フィルタ（created_at >= 下限）用
CREATE INDEX IF NOT EXISTS idx_cp_created_at
  ON chaos_pendulum_scores (created_at);
