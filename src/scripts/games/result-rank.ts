// CHAOS BEAT の結果ランク（結果発表で最後に押す S / A / B / C のハンコ）。
// 得点の満点は難易度に依らない（PERFECT は的の大きさに関係なく同じ点）が、取りやすさが大きく違うので、しきい値は難易度別。
// 人間らしい押しズレ（正規分布 σ=15/30/50ms）の自動プレイの得点から決めた：
//   S ≒ 上手い人（σ15）の典型的な得点を少し超える / A ≒ 上手い人〜平均の間 / B ≒ 平均（σ30）前後 / C それ未満。
//   （計測 2 ゲームずつ：easy 10.9k/8.4–9.1k/4.3–6.5k、normal 8.7–10k/4.9–7.5k/2.9–3.1k、
//    hard 5.7k/3.5–4.0k/1.4–2.6k、oni 1.8–4.1k/1.9–2.0k/0.9–1.2k）
// 実プレイの分布は GA4 の game_over.result_rank / score（difficulty 別）で見て調整する。

import type { Difficulty } from './chaos-pendulum';

export type ResultRank = 'S' | 'A' | 'B' | 'C';

type Thresholds = { rank: ResultRank; min: number }[];

/** 難易度ごと。上のランクから順に、min 点以上ならそのランク */
export const RANK_THRESHOLDS: Record<Difficulty, Thresholds> = {
	easy: [
		{ rank: 'S', min: 10000 },
		{ rank: 'A', min: 8000 },
		{ rank: 'B', min: 5000 },
		{ rank: 'C', min: 0 },
	],
	normal: [
		{ rank: 'S', min: 9000 },
		{ rank: 'A', min: 6500 },
		{ rank: 'B', min: 4000 },
		{ rank: 'C', min: 0 },
	],
	hard: [
		{ rank: 'S', min: 6000 },
		{ rank: 'A', min: 4200 },
		{ rank: 'B', min: 2500 },
		{ rank: 'C', min: 0 },
	],
	oni: [
		{ rank: 'S', min: 4000 },
		{ rank: 'A', min: 2500 },
		{ rank: 'B', min: 1500 },
		{ rank: 'C', min: 0 },
	],
};

/**
 * 曲ごとのしきい値（60秒版と尺も譜面も違う曲）。無い曲は RANK_THRESHOLDS。
 * Burning Heart FULL（約5分・的 約200）：仮値。60秒版と同じ方法（押しズレ σ=15/30/50ms の自動プレイ）で決めた。
 * 実プレイの分布（GA4 の game_over：song_id=burning-heart の score / result_rank）で調整する。
 */
export const SONG_RANK_THRESHOLDS: Record<string, Record<Difficulty, Thresholds>> = {
	// 計測（1ゲームずつ、σ15 / σ30 / σ50）：easy 60.3k / 48.6–52.5k / 28.6k、normal 52.3–53.8k / 26.1–34.1k / 17.7–24.2k、
	// hard 37.5k / 15.3–17.6k / 10.1k、oni 17.6k / 8.3–9.0k / 7.0k（的 約165〜173・パーフェクト演奏で約65k）
	'burning-heart': {
		easy: [
			{ rank: 'S', min: 57000 },
			{ rank: 'A', min: 46000 },
			{ rank: 'B', min: 27000 },
			{ rank: 'C', min: 0 },
		],
		normal: [
			{ rank: 'S', min: 50000 },
			{ rank: 'A', min: 28000 },
			{ rank: 'B', min: 18000 },
			{ rank: 'C', min: 0 },
		],
		hard: [
			{ rank: 'S', min: 34000 },
			{ rank: 'A', min: 16000 },
			{ rank: 'B', min: 9500 },
			{ rank: 'C', min: 0 },
		],
		oni: [
			{ rank: 'S', min: 16000 },
			{ rank: 'A', min: 8000 },
			{ rank: 'B', min: 6000 },
			{ rank: 'C', min: 0 },
		],
	},
};

const thresholdsOf = (difficulty: Difficulty, songId?: string): Thresholds =>
	(songId && SONG_RANK_THRESHOLDS[songId]?.[difficulty]) || RANK_THRESHOLDS[difficulty];

export function rankOf(score: number, difficulty: Difficulty, songId?: string): ResultRank {
	const t = thresholdsOf(difficulty, songId);
	return (t.find((x) => score >= x.min) ?? t[t.length - 1]).rank;
}

/** 1つ上のランクまであと何点か（S なら null）。「あと 820 点で S」の再戦導線に使う */
export function nextRank(score: number, difficulty: Difficulty, songId?: string): { rank: ResultRank; need: number } | null {
	const t = thresholdsOf(difficulty, songId);
	const i = t.findIndex((x) => score >= x.min);
	if (i <= 0) return null;
	return { rank: t[i - 1].rank, need: t[i - 1].min - score };
}

/** 「あと少し」とみなす点差（これ以下なら SO CLOSE! で強調・もう一回の文言も変える） */
export const SO_CLOSE_POINTS = 300;

export interface NextGoal {
	kind: 'rank' | 'best' | 'combo';
	text: string;
	/** 点差の目標なら残り点数（コンボ目標は null） */
	need: number | null;
	close: boolean;
}

/**
 * 結果画面の NEXT GOAL（次の1プレイで狙うことを1つだけ）。優先順：
 *   1. S 未満 → 次のランクまであと◯点
 *   2. S 取得・自己ベスト未更新 → BEST まであと◯点
 *   3. S 取得・自己ベスト更新 → 最大コンボ記録を超えろ
 */
export function nextGoal(p: {
	score: number;
	difficulty: Difficulty;
	isNewBest: boolean;
	bestScore: number;
	topCombo: number;
	/** 曲ごとのランク基準（無ければ60秒版） */
	songId?: string;
}): NextGoal {
	const fmt = (n: number) => n.toLocaleString('ja-JP');
	// フル尺の曲は点数の桁が大きいので「あと少し」の幅も広げる（的の数に比例して約3倍）
	const close = p.songId && SONG_RANK_THRESHOLDS[p.songId] ? SO_CLOSE_POINTS * 3 : SO_CLOSE_POINTS;
	const nx = nextRank(p.score, p.difficulty, p.songId);
	if (nx) return { kind: 'rank', text: `あと ${fmt(nx.need)} 点で ${nx.rank}`, need: nx.need, close: nx.need <= close };
	if (!p.isNewBest) {
		const gap = Math.max(1, p.bestScore - p.score);
		return { kind: 'best', text: `BEST まで あと ${fmt(gap)} 点`, need: gap, close: gap <= close };
	}
	return { kind: 'combo', text: `MAX COMBO ${p.topCombo} を超えろ`, need: null, close: false };
}
