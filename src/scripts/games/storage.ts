// 自己ベストの保存（localStorage・ログイン不要・ブラウザ単位）。
// ゲームエンジンはこのモジュールに依存しない。難易度ごとに別々のベストを持つ。

type DiffKey = 'easy' | 'normal' | 'hard' | 'oni';
// CHAOS BEAT はスコア基準が変わったので旧キー(cp:best:*)とは別名にする。
// さらに曲の尺（60秒1曲版）ごとに分ける。30秒版の自己ベスト(cb:best:*)とは比較できないので読まない。
const SONG_KEY = '60';
const bestKey = (difficulty: DiffKey) => `cb:best:${SONG_KEY}:${difficulty}`;

export interface PersonalBest {
	bestScore: number;
	/** 自己ベスト（スコア）を出したゲームの最大コンボ */
	bestMaxCombo: number;
	bestRecordedAt: string; // ISO8601
	/** この難易度で出した最大コンボの記録（スコアと別に更新。古いデータは bestMaxCombo で代用） */
	topCombo: number;
	/** この難易度で S ランクを取ったことがあるか（FIRST S RANK! 用） */
	gotS: boolean;
}

export interface GameResultSummary {
	score: number;
	maxCombo: number;
	/** 今回のランク（S なら gotS を立てる） */
	rank?: string;
}

export interface BestUpdate {
	isNewBest: boolean;
	best: PersonalBest;
	/** 更新前の自己ベスト（初回は null） */
	prevBestScore: number | null;
	/** 最大コンボ記録の更新（初回は false） */
	isNewTopCombo: boolean;
	prevTopCombo: number;
	/** この難易度で初めての S */
	isFirstS: boolean;
}

export function getBest(difficulty: DiffKey = 'normal'): PersonalBest | null {
	try {
		const raw = localStorage.getItem(bestKey(difficulty));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<PersonalBest>;
		if (typeof parsed.bestScore !== 'number') return null;
		return {
			bestScore: parsed.bestScore,
			bestMaxCombo: parsed.bestMaxCombo ?? 0,
			bestRecordedAt: parsed.bestRecordedAt ?? '',
			topCombo: parsed.topCombo ?? parsed.bestMaxCombo ?? 0,
			gotS: parsed.gotS ?? false,
		};
	} catch {
		return null;
	}
}

/**
 * 今回の結果で自己ベストを更新する（スコアが上回ったときだけ NEW BEST 扱い）。
 * 最大コンボの記録と「S を取ったことがあるか」はスコアとは別に更新する。
 */
export function updateBest(result: GameResultSummary, difficulty: DiffKey = 'normal'): BestUpdate {
	const prev = getBest(difficulty);
	const isNewBest = !prev || result.score > prev.bestScore;
	const prevTopCombo = prev?.topCombo ?? 0;
	const isNewTopCombo = !!prev && result.maxCombo > prevTopCombo;
	const isS = result.rank === 'S';
	const isFirstS = isS && !(prev?.gotS ?? false);
	const best: PersonalBest = {
		bestScore: isNewBest ? result.score : prev!.bestScore,
		bestMaxCombo: isNewBest ? result.maxCombo : prev!.bestMaxCombo,
		bestRecordedAt: isNewBest ? new Date().toISOString() : prev!.bestRecordedAt,
		topCombo: Math.max(prevTopCombo, result.maxCombo),
		gotS: (prev?.gotS ?? false) || isS,
	};
	try {
		localStorage.setItem(bestKey(difficulty), JSON.stringify(best));
	} catch {
		/* 保存できなくても表示は行う */
	}
	return { isNewBest, best, prevBestScore: prev ? prev.bestScore : null, isNewTopCombo, prevTopCombo, isFirstS };
}
