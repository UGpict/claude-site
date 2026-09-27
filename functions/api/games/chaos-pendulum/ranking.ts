// Cloudflare Pages Function: ランキング取得 API
//   GET /api/games/chaos-pendulum/ranking?period=daily|weekly|all
//
// D1（binding 名: DB）から TOP10 を返す。並び順は
//   score DESC, perfect_count DESC, average_distance ASC, created_at ASC。

interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	all<T = unknown>(): Promise<{ results: T[] }>;
}
interface D1Database {
	prepare(query: string): D1PreparedStatement;
}
interface Env {
	DB: D1Database;
}
type Ctx = { request: Request; env: Env };

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});

function cutoff(period: 'daily' | 'weekly'): string {
	if (period === 'weekly') return new Date(Date.now() - 7 * 86400000).toISOString();
	const shifted = new Date(Date.now() + 9 * 3600000);
	shifted.setUTCHours(0, 0, 0, 0);
	return new Date(shifted.getTime() - 9 * 3600000).toISOString();
}

const DIFFICULTIES = ['easy', 'normal', 'hard', 'oni'];
const sanitizeDifficulty = (raw: string | null): string =>
	raw && DIFFICULTIES.includes(raw) ? raw : 'normal';

interface Row {
	nickname: string;
	score: number;
	perfect_count: number;
	difficulty: string;
	created_at: string;
}

export const onRequestGet = async (context: Ctx): Promise<Response> => {
	const { request, env } = context;
	if (!env || !env.DB) return json({ error: 'ranking backend not configured' }, 503);

	const url = new URL(request.url);
	const periodParam = url.searchParams.get('period') ?? 'daily';
	const period: 'daily' | 'weekly' | 'all' =
		periodParam === 'weekly' ? 'weekly' : periodParam === 'all' ? 'all' : 'daily';
	const difficulty = sanitizeDifficulty(url.searchParams.get('difficulty'));

	const cols = 'nickname, score, perfect_count, difficulty, created_at';
	const order =
		'ORDER BY score DESC, perfect_count DESC, average_distance ASC, created_at ASC LIMIT 10';

	try {
		// 難易度ごとの素点ランキング（易しい/普通/難しい/鬼を別々に集計）。
		let rows: Row[];
		if (period === 'all') {
			const r = await env.DB.prepare(
				`SELECT ${cols} FROM chaos_pendulum_scores WHERE difficulty = ?1 ${order}`,
			)
				.bind(difficulty)
				.all<Row>();
			rows = r.results;
		} else {
			const r = await env.DB.prepare(
				`SELECT ${cols} FROM chaos_pendulum_scores WHERE difficulty = ?1 AND created_at >= ?2 ${order}`,
			)
				.bind(difficulty, cutoff(period))
				.all<Row>();
			rows = r.results;
		}

		const top = rows.map((row, i) => ({
			rank: i + 1,
			nickname: row.nickname,
			difficulty: row.difficulty,
			score: row.score,
			perfectCount: row.perfect_count,
			createdAt: row.created_at,
		}));

		return json({ period, difficulty, top });
	} catch (e) {
		return json({ error: 'db error', detail: String(e) }, 500);
	}
};
