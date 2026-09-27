// オンラインランキングとの通信（fetch）。
// ゲームエンジンはこのモジュールに依存しない。失敗時は例外を投げるだけにする（呼び出し側がフォールバック）。

import type { Difficulty } from './chaos-pendulum';

export type RankingPeriod = 'daily' | 'weekly' | 'all';

export interface RankingEntry {
	rank: number;
	nickname: string;
	score: number;
	maxCombo: number;
	createdAt: string; // ISO8601
}

export interface ScoreSubmission {
	nickname: string;
	difficulty: Difficulty;
	score: number;
	maxCombo: number;
	hits: number;
	perfectCount: number;
}

export interface SubmitResult {
	rank: number;
	period: RankingPeriod;
	ranks?: Record<RankingPeriod, number>;
}

const BASE = '/api/games/chaos-pendulum';

export async function getRanking(
	period: RankingPeriod,
	difficulty: Difficulty,
): Promise<RankingEntry[]> {
	// 難易度ごとの素点ランキング。
	const res = await fetch(
		`${BASE}/ranking?period=${encodeURIComponent(period)}&difficulty=${encodeURIComponent(difficulty)}`,
		{ headers: { accept: 'application/json' } },
	);
	if (!res.ok) throw new Error(`ranking fetch failed: ${res.status}`);
	const data = (await res.json()) as { top?: RankingEntry[] };
	return Array.isArray(data.top) ? data.top : [];
}

export async function submitScore(payload: ScoreSubmission): Promise<SubmitResult> {
	const res = await fetch(`${BASE}/scores`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (!res.ok) throw new Error(`score submit failed: ${res.status}`);
	return (await res.json()) as SubmitResult;
}
