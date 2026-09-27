// 自己ベストの保存（localStorage・ログイン不要・ブラウザ単位）。
// ゲームエンジンはこのモジュールに依存しない。難易度ごとに別々のベストを持つ。

type DiffKey = 'easy' | 'normal' | 'hard' | 'oni';
// CHAOS BEAT はスコア基準が変わったので旧キー(cp:best:*)とは別名にする。
// さらに曲の尺（60秒1曲版）ごとに分ける。30秒版の自己ベスト(cb:best:*)とは比較できないので読まない。
const SONG_KEY = '60';
const bestKey = (difficulty: DiffKey) => `cb:best:${SONG_KEY}:${difficulty}`;

export interface PersonalBest {
	bestScore: number;
	bestMaxCombo: number;
	bestRecordedAt: string; // ISO8601
}

export interface GameResultSummary {
	score: number;
	maxCombo: number;
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
		};
	} catch {
		return null;
	}
}

/** 今回の結果で自己ベストを更新する（スコアが上回ったときだけ NEW BEST 扱い）。 */
export function updateBest(
	result: GameResultSummary,
	difficulty: DiffKey = 'normal',
): { isNewBest: boolean; best: PersonalBest } {
	const prev = getBest(difficulty);
	const isNewBest = !prev || result.score > prev.bestScore;
	if (!isNewBest && prev) return { isNewBest: false, best: prev };
	const best: PersonalBest = {
		bestScore: result.score,
		bestMaxCombo: result.maxCombo,
		bestRecordedAt: new Date().toISOString(),
	};
	try {
		localStorage.setItem(bestKey(difficulty), JSON.stringify(best));
	} catch {
		/* 保存できなくても表示は行う */
	}
	return { isNewBest: true, best };
}
