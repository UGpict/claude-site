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

export function rankOf(score: number, difficulty: Difficulty): ResultRank {
	const t = RANK_THRESHOLDS[difficulty];
	return (t.find((x) => score >= x.min) ?? t[t.length - 1]).rank;
}

/** 1つ上のランクまであと何点か（S なら null）。「あと 820 点で S」の再戦導線に使う */
export function nextRank(score: number, difficulty: Difficulty): { rank: ResultRank; need: number } | null {
	const t = RANK_THRESHOLDS[difficulty];
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
}): NextGoal {
	const fmt = (n: number) => n.toLocaleString('ja-JP');
	const nx = nextRank(p.score, p.difficulty);
	if (nx) return { kind: 'rank', text: `あと ${fmt(nx.need)} 点で ${nx.rank}`, need: nx.need, close: nx.need <= SO_CLOSE_POINTS };
	if (!p.isNewBest) {
		const gap = Math.max(1, p.bestScore - p.score);
		return { kind: 'best', text: `BEST まで あと ${fmt(gap)} 点`, need: gap, close: gap <= SO_CLOSE_POINTS };
	}
	return { kind: 'combo', text: `MAX COMBO ${p.topCombo} を超えろ`, need: null, close: false };
}
