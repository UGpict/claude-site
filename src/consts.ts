// Place any global data in this file.
// You can import this data from anywhere in your site by using the `import` keyword.

export const SITE_TITLE = '0から始める優しいAI生活';
export const SITE_DESCRIPTION =
	'Claude（Anthropic の AI）の入門から Claude Code の使い方、実際の開発事例までを、初心者向けにやさしく解説するブログ。';

// アクセス解析・サーチコンソール。
// 値を入れると自動でタグが有効化され、空文字なら出力されません。
export const GOOGLE_ANALYTICS_ID = 'G-3HFJVRXQ2C'; // GA4 の測定 ID
export const GOOGLE_SITE_VERIFICATION = ''; // Search Console「HTMLタグ」方式の content 値

// 記事カテゴリ（スラッグ→ラベル）。新記事を足したらここに追記する。
export const CATEGORY: Record<string, string> = {
	'claude-toha-nanika': '入門',
	'claude-code-tsukaikata': '使い方',
	'prompt-no-kotsu': '使い方',
	'kangal-kaihatsu-jirei': '開発事例',
	'shoshinsha-hitokara-tsukutta': '制作記録',
	'ai-anzen-chuiten': '注意点',
	'trailing-slash-canonical': '技術メモ',
	'astro-nextjs-cms': '技術メモ',
};
export const categoryOf = (id: string): string => CATEGORY[id] ?? '記事';

// heroImage 未指定の記事は、ビルド時に自動生成したサムネ（public/thumb/<slug>.webp）を使う
export const thumbUrl = (slug: string): string => `/thumb/${slug}.webp`;

// SNS プロフィール（左シェアバーの Instagram など。未設定なら該当アイコンは非表示）
export const SOCIAL = {
	instagram: '', // 例: 'https://www.instagram.com/your_account/'
};

// 記事の著者名（構造化データ Article の author に使用。変更可）
export const AUTHOR_NAME = 'のこたけ';
