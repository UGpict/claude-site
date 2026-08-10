// ビルド時に GA4 のページビュー上位を取得し、src/data/popular.json に
// 記事スラッグの人気順配列を書き出す。
// 環境変数が無い/失敗した場合は空配列を書き、サイドバーは新着順にフォールバックする。
//
// 必要な環境変数（Cloudflare Pages などのビルド環境に設定）:
//   GA_SERVICE_ACCOUNT_KEY … サービスアカウントの JSON 鍵（中身をそのまま貼る）
//   GA4_PROPERTY_ID         … GA4 プロパティ ID（未設定なら下記の既定値を使用）
import { mkdirSync, writeFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';

const OUT = new URL('../src/data/popular.json', import.meta.url);
const DATA_DIR = new URL('../src/data/', import.meta.url);
const propertyId = process.env.GA4_PROPERTY_ID || '540023048';
const keyJson = process.env.GA_SERVICE_ACCOUNT_KEY;

function write(arr) {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(OUT, JSON.stringify(arr, null, 2) + '\n');
}

async function main() {
	if (!keyJson) {
		console.log('[popular] GA_SERVICE_ACCOUNT_KEY 未設定 — 新着順にフォールバック');
		write([]);
		return;
	}

	let key;
	try {
		key = JSON.parse(keyJson);
	} catch {
		console.warn('[popular] 鍵 JSON のパースに失敗 — フォールバック');
		write([]);
		return;
	}

	const jwt = new JWT({
		email: key.client_email,
		key: key.private_key,
		scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
	});
	const { token } = await jwt.getAccessToken();

	const res = await fetch(
		`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
				dimensions: [{ name: 'pagePath' }],
				metrics: [{ name: 'screenPageViews' }],
				orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
				limit: 50,
			}),
		},
	);

	if (!res.ok) {
		console.warn('[popular] GA4 API エラー', res.status, await res.text());
		write([]);
		return;
	}

	const data = await res.json();
	const slugs = [];
	for (const row of data.rows ?? []) {
		const path = row.dimensionValues?.[0]?.value ?? '';
		const m = path.match(/^\/blog\/([^/]+)\/?$/);
		if (m) {
			const slug = decodeURIComponent(m[1]);
			if (!slugs.includes(slug)) slugs.push(slug);
		}
	}
	write(slugs);
	console.log(`[popular] ${slugs.length} 件の人気スラッグを書き出し`);
}

main().catch((e) => {
	console.warn('[popular] 失敗 — フォールバック:', e.message);
	write([]);
});
