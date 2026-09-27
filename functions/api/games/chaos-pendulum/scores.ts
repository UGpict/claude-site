// Cloudflare Pages Function: スコア登録 API
//   POST /api/games/chaos-pendulum/scores
//
// D1（binding 名: DB）へ保存し、登録スコアの「今日 / 今週 / 歴代」順位を返す。
// クライアントの申告値をそのまま信用せず、最低限の整合性チェックを行う（過剰なアンチチートはしない）。
// IP アドレス等の個人情報は保存しない。

// --- D1 / Pages の最小型定義（@cloudflare/workers-types を追加せずに型を付ける） ---
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

const ROUNDS = 5;
const MAX_ROUND_SCORE = 100;
const MAX_TOTAL = 500;
const NICK_MAX = 20;

// 難易度ごとの的の半径（採点の PERFECT 判定に使う）。エンジンの DIFFICULTY_PRESETS と一致させる。
const TARGET_R_BY_DIFF: Record<string, number> = {
	easy: 0.4,
	normal: 0.26,
	hard: 0.18,
	oni: 0.12,
};
const DIFFICULTIES = Object.keys(TARGET_R_BY_DIFF);

function sanitizeDifficulty(raw: unknown): string {
	return typeof raw === 'string' && DIFFICULTIES.includes(raw) ? raw : 'normal';
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});

function sanitizeNickname(raw: unknown): string {
	if (typeof raw !== 'string') return '名無し';
	// 制御文字（0x00-0x1F, 0x7F）を除去。危険文字はそのまま保存せず、描画側でも textContent で扱う。
	let out = '';
	for (const ch of raw) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 0x20 && code !== 0x7f) out += ch;
	}
	out = out.trim().slice(0, NICK_MAX);
	return out.length ? out : '名無し';
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

/** 期間フィルタの下限（ISO文字列）。daily は日本時間の当日0時。 */
function cutoff(period: 'daily' | 'weekly'): string {
	if (period === 'weekly') {
		return new Date(Date.now() - 7 * 86400000).toISOString();
	}
	// 日本時間（UTC+9）の当日0時を UTC の ISO に変換
	const shifted = new Date(Date.now() + 9 * 3600000);
	shifted.setUTCHours(0, 0, 0, 0);
	return new Date(shifted.getTime() - 9 * 3600000).toISOString();
}

async function rankFor(
	db: D1Database,
	filterSql: string,
	filterArgs: unknown[],
	score: number,
	perfect: number,
	avg: number,
	createdAt: string,
): Promise<number> {
	const sql =
		`SELECT COUNT(*) AS c FROM chaos_pendulum_scores WHERE ${filterSql} AND (` +
		`score > ?1 OR ` +
		`(score = ?1 AND perfect_count > ?2) OR ` +
		`(score = ?1 AND perfect_count = ?2 AND average_distance < ?3) OR ` +
		`(score = ?1 AND perfect_count = ?2 AND average_distance = ?3 AND created_at < ?4))`;
	// ?1..?4 = score/perfect/avg/createdAt、?5.. = filterArgs（期間の下限など）
	const row = await db
		.prepare(sql)
		.bind(score, perfect, avg, createdAt, ...filterArgs)
		.first<{ c: number }>();
	return (row?.c ?? 0) + 1;
}

export const onRequestPost = async (context: Ctx): Promise<Response> => {
	const { request, env } = context;
	if (!env || !env.DB) {
		return json({ error: 'ranking backend not configured' }, 503);
	}

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'invalid json' }, 400);
	}

	const score = body.score;
	const rounds = body.rounds;
	const duration = body.duration;
	const perfectCount = body.perfectCount;
	const averageDistance = body.averageDistance;
	const roundScores = body.roundScores;
	const roundDistances = body.roundDistances;
	const difficulty = sanitizeDifficulty(body.difficulty);
	const targetR = TARGET_R_BY_DIFF[difficulty];

	// --- 検証 ---
	if (rounds !== ROUNDS) return json({ error: 'invalid rounds' }, 400);
	if (!Array.isArray(roundScores) || roundScores.length !== ROUNDS)
		return json({ error: 'invalid roundScores' }, 400);
	if (!Array.isArray(roundDistances) || roundDistances.length !== ROUNDS)
		return json({ error: 'invalid roundDistances' }, 400);

	let sum = 0;
	for (const rs of roundScores) {
		if (!isFiniteNumber(rs) || rs < 0 || rs > MAX_ROUND_SCORE || !Number.isInteger(rs))
			return json({ error: 'invalid round score' }, 400);
		sum += rs;
	}
	for (const rd of roundDistances) {
		if (!isFiniteNumber(rd) || rd < 0 || rd > 10)
			return json({ error: 'invalid round distance' }, 400);
	}
	if (!isFiniteNumber(score) || !Number.isInteger(score) || score < 0 || score > MAX_TOTAL)
		return json({ error: 'invalid score' }, 400);
	if (sum !== score) return json({ error: 'score/rounds mismatch' }, 400);

	if (!isFiniteNumber(perfectCount) || perfectCount < 0 || perfectCount > ROUNDS)
		return json({ error: 'invalid perfectCount' }, 400);
	// PERFECT はスコア80以上（100-round(d/TARGET_R*20), d<=TARGET_R）になるため、その整合を軽く確認
	const highRounds = (roundScores as number[]).filter((s) => s >= 80).length;
	if (perfectCount > highRounds) return json({ error: 'perfectCount inconsistent' }, 400);
	// distance と perfect の整合（緩め）。的の半径は難易度で変わる。
	const perfectByDist = (roundDistances as number[]).filter((d) => d <= targetR).length;
	if (perfectCount > perfectByDist) return json({ error: 'perfectCount vs distance' }, 400);

	if (!isFiniteNumber(duration) || duration < 0 || duration > 7200)
		return json({ error: 'invalid duration' }, 400);
	if (!isFiniteNumber(averageDistance) || averageDistance < 0 || averageDistance > 10)
		return json({ error: 'invalid averageDistance' }, 400);

	const nickname = sanitizeNickname(body.nickname);
	const createdAt = new Date().toISOString();

	try {
		await env.DB.prepare(
			`INSERT INTO chaos_pendulum_scores
			 (nickname, score, perfect_count, average_distance, rounds, created_at, difficulty)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
		)
			.bind(nickname, score, perfectCount as number, averageDistance, ROUNDS, createdAt, difficulty)
			.run();

		// 順位は同じ難易度の中だけで比べる（易しい/鬼のスコアを混ぜない）。
		const daily = await rankFor(
			env.DB,
			'difficulty = ?5 AND created_at >= ?6',
			[difficulty, cutoff('daily')],
			score,
			perfectCount as number,
			averageDistance,
			createdAt,
		);
		const weekly = await rankFor(
			env.DB,
			'difficulty = ?5 AND created_at >= ?6',
			[difficulty, cutoff('weekly')],
			score,
			perfectCount as number,
			averageDistance,
			createdAt,
		);
		const all = await rankFor(
			env.DB,
			'difficulty = ?5',
			[difficulty],
			score,
			perfectCount as number,
			averageDistance,
			createdAt,
		);

		return json({ rank: daily, period: 'daily', ranks: { daily, weekly, all } });
	} catch (e) {
		return json({ error: 'db error', detail: String(e) }, 500);
	}
};
