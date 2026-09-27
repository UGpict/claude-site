// オンラインランキングとの通信（fetch）。
// ゲームエンジンはこのモジュールに依存しない（API の存在を知らない）。
// API が落ちていても呼び出し側がフォールバックできるよう、失敗時は例外を投げるだけにする。

import type { Difficulty } from './chaos-pendulum';

export type RankingPeriod = 'daily' | 'weekly' | 'all';

export interface RankingEntry {
	rank: number;
	nickname: string;
	score: number;
	perfectCount: number;
	createdAt: string; // ISO8601
}

export interface ScoreSubmission {
	nickname: string;
	difficulty: Difficulty;
	score: number;
	rounds: number;
	duration: number;
	perfectCount: number;
	averageDistance: number;
	roundScores: number[];
	roundDistances: number[];
}

export interface SubmitResult {
	/** 「今日」の順位 */
	rank: number;
	period: RankingPeriod;
	/** 各期間の順位（サーバーが返す場合） */
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
