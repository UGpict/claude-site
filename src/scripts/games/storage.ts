// 自己ベストの保存（localStorage・ログイン不要・ブラウザ単位）。
// ゲームエンジンはこのモジュールに依存しない。
// 難易度ごとに別々のベストを持つ（易しいと鬼を混ぜない）。

// 難易度キー。'' は旧仕様（難易度なし）の後方互換キー。
type DiffKey = 'easy' | 'normal' | 'hard' | 'oni';
const bestKey = (difficulty: DiffKey) => `cp:best:${difficulty}`;

export interface PersonalBest {
	bestScore: number;
	bestPerfectCount: number;
	bestAverageDistance: number;
	bestRecordedAt: string; // ISO8601
}

export interface GameResultSummary {
	score: number;
	perfectCount: number;
	averageDistance: number;
}

export function getBest(difficulty: DiffKey = 'normal'): PersonalBest | null {
	try {
		const raw = localStorage.getItem(bestKey(difficulty));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<PersonalBest>;
		if (typeof parsed.bestScore !== 'number') return null;
		return {
			bestScore: parsed.bestScore,
			bestPerfectCount: parsed.bestPerfectCount ?? 0,
			bestAverageDistance: parsed.bestAverageDistance ?? 0,
			bestRecordedAt: parsed.bestRecordedAt ?? '',
		};
	} catch {
		return null;
	}
}

/**
 * 今回の結果で自己ベストを更新する。
 * スコアが従来ベストを上回ったときだけ NEW BEST 扱いで保存する。
 */
export function updateBest(
	result: GameResultSummary,
	difficulty: DiffKey = 'normal',
): {
	isNewBest: boolean;
	best: PersonalBest;
} {
	const prev = getBest(difficulty);
	const isNewBest = !prev || result.score > prev.bestScore;
	if (!isNewBest && prev) {
		return { isNewBest: false, best: prev };
	}
	const best: PersonalBest = {
		bestScore: result.score,
		bestPerfectCount: result.perfectCount,
		bestAverageDistance: result.averageDistance,
		bestRecordedAt: new Date().toISOString(),
	};
	try {
		localStorage.setItem(bestKey(difficulty), JSON.stringify(best));
	} catch {
		/* 保存できなくても表示は行う */
	}
	return { isNewBest: true, best };
}
