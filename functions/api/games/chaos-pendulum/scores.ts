// Cloudflare Pages Function: スコア登録 API（CHAOS BEAT）
//   POST /api/games/chaos-pendulum/scores
//
// D1（binding 名: DB）へ保存し、同じ難易度内の「今日 / 今週 / 歴代」順位を返す。
// 申告値はそのまま信用せず最低限の整合性チェックのみ（過剰なアンチチートはしない）。
// 個人情報（IP 等）は保存しない。

interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	first<T = unknown>(colName?: string): Promise<T | null>;
	all<T = unknown>(): Promise<{ results: T[] }>;
	run(): Promise<unknown>;
}
interface D1Database {
	prepare(query: string): D1PreparedStatement;
}
interface Env {
	DB: D1Database;
}
type Ctx = { request: Request; env: Env };

// 60秒1曲版：1ヒット最大 100×2.0(コンボ)×2(FEVER)=400点。拍どおりなら的は約1.4秒ごと（≒43個）で理論上限≒17,000、
// 最悪ケース（反応猶予0.5秒＋スロー0.2秒ごとに当て続ける）でも ≒85個×400≒34,000。
// 余裕を見て 40000（明らかな改ざん値だけ弾く緩い上限）。
const MAX_SCORE = 40000;
const MAX_HITS = 200;
const NICK_MAX = 20;
const DIFFICULTIES = ['easy', 'normal', 'hard', 'oni'];

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});

function sanitizeNickname(raw: unknown): string {
	if (typeof raw !== 'string') return '名無し';
	let out = '';
	for (const ch of raw) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 0x20 && code !== 0x7f) out += ch;
	}
	out = out.trim().slice(0, NICK_MAX);
	return out.length ? out : '名無し';
}
function sanitizeDifficulty(raw: unknown): string {
	return typeof raw === 'string' && DIFFICULTIES.includes(raw) ? raw : 'normal';
}
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function cutoff(period: 'daily' | 'weekly'): string {
	if (period === 'weekly') return new Date(Date.now() - 7 * 86400000).toISOString();
	const shifted = new Date(Date.now() + 9 * 3600000);
	shifted.setUTCHours(0, 0, 0, 0);
	return new Date(shifted.getTime() - 9 * 3600000).toISOString();
}

/** 同じ難易度・期間の中で、自分より上位の件数 +1 = 順位。並びは score→max_combo→created_at。 */
async function rankFor(
	db: D1Database,
	period: 'daily' | 'weekly' | 'all',
	difficulty: string,
	score: number,
	maxCombo: number,
	createdAt: string,
): Promise<number> {
	const args: unknown[] = [score, maxCombo, createdAt, difficulty];
	let where = 'difficulty = ?4';
	if (period !== 'all') {
		where += ' AND created_at >= ?5';
		args.push(cutoff(period));
	}
	const sql =
		`SELECT COUNT(*) AS c FROM chaos_pendulum_scores WHERE ${where} AND (` +
		`score > ?1 OR ` +
		`(score = ?1 AND max_combo > ?2) OR ` +
		`(score = ?1 AND max_combo = ?2 AND created_at < ?3))`;
	const row = await db.prepare(sql).bind(...args).first<{ c: number }>();
	return (row?.c ?? 0) + 1;
}

export const onRequestPost = async (context: Ctx): Promise<Response> => {
	const { request, env } = context;
	if (!env || !env.DB) return json({ error: 'ranking backend not configured' }, 503);

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'invalid json' }, 400);
	}

	const score = body.score;
	const maxCombo = body.maxCombo;
	const hits = body.hits;
	const perfectCount = body.perfectCount;

	// --- 検証（緩め・明らかにおかしい値だけ弾く） ---
	if (!isInt(score) || score < 0 || score > MAX_SCORE) return json({ error: 'invalid score' }, 400);
	if (!isInt(hits) || hits < 0 || hits > MAX_HITS) return json({ error: 'invalid hits' }, 400);
	if (!isInt(maxCombo) || maxCombo < 0 || maxCombo > hits)
		return json({ error: 'invalid maxCombo' }, 400);
	if (!isInt(perfectCount) || perfectCount < 0 || perfectCount > hits)
		return json({ error: 'invalid perfectCount' }, 400);

	const nickname = sanitizeNickname(body.nickname);
	const difficulty = sanitizeDifficulty(body.difficulty);
	const createdAt = new Date().toISOString();

	try {
		await env.DB.prepare(
			`INSERT INTO chaos_pendulum_scores
			 (nickname, score, perfect_count, average_distance, rounds, created_at, difficulty, max_combo)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
		)
			.bind(nickname, score, perfectCount, 0, hits, createdAt, difficulty, maxCombo)
			.run();

		const daily = await rankFor(env.DB, 'daily', difficulty, score, maxCombo, createdAt);
		const weekly = await rankFor(env.DB, 'weekly', difficulty, score, maxCombo, createdAt);
		const all = await rankFor(env.DB, 'all', difficulty, score, maxCombo, createdAt);

		return json({ rank: daily, period: 'daily', ranks: { daily, weekly, all } });
	} catch (e) {
		return json({ error: 'db error', detail: String(e) }, 500);
	}
};
