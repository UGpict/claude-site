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

interface Row {
	nickname: string;
	score: number;
	perfect_count: number;
	created_at: string;
}

export const onRequestGet = async (context: Ctx): Promise<Response> => {
	const { request, env } = context;
	if (!env || !env.DB) return json({ error: 'ranking backend not configured' }, 503);

	const url = new URL(request.url);
	const periodParam = url.searchParams.get('period') ?? 'daily';
	const period: 'daily' | 'weekly' | 'all' =
		periodParam === 'weekly' ? 'weekly' : periodParam === 'all' ? 'all' : 'daily';

	const order =
		'ORDER BY score DESC, perfect_count DESC, average_distance ASC, created_at ASC LIMIT 10';

	try {
		let rows: Row[];
		if (period === 'all') {
			const r = await env.DB.prepare(
				`SELECT nickname, score, perfect_count, created_at FROM chaos_pendulum_scores ${order}`,
			).all<Row>();
			rows = r.results;
		} else {
			const r = await env.DB.prepare(
				`SELECT nickname, score, perfect_count, created_at FROM chaos_pendulum_scores WHERE created_at >= ?1 ${order}`,
			)
				.bind(cutoff(period))
				.all<Row>();
			rows = r.results;
		}

		const top = rows.map((row, i) => ({
			rank: i + 1,
			nickname: row.nickname,
			score: row.score,
			perfectCount: row.perfect_count,
			createdAt: row.created_at,
		}));

		return json({ period, top });
	} catch (e) {
		return json({ error: 'db error', detail: String(e) }, 500);
	}
};
