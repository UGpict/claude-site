// heroImage 未指定の記事に、記事タイトル＋カテゴリ＋ロゴを焼き込んだサムネを自動生成する。
// satori でフォントをパス化するため、ビルド環境のフォント有無に依存しない（文字化けしない）。
// 出力: public/thumb/<slug>.webp（1200x630, OG 兼用）
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import satori from 'satori';
import sharp from 'sharp';

const dir = import.meta.dirname;
const BLOG = join(dir, '..', 'src', 'content', 'blog');
const OUT = join(dir, '..', 'public', 'thumb');
const FONTS = join(dir, '..', 'src', 'assets', 'fonts');
const LOGO = join(dir, '..', 'src', 'assets', 'logo.png');

const W = 1200;
const H = 630;

// カテゴリ（src/consts.ts と対応。表示色を決めるのに使う）
const CATEGORY = {
	'claude-toha-nanika': '入門',
	'claude-code-tsukaikata': '使い方',
	'prompt-no-kotsu': '使い方',
	'kangal-kaihatsu-jirei': '開発事例',
	'shoshinsha-hitokara-tsukutta': '制作記録',
	'ai-anzen-chuiten': '注意点',
	'trailing-slash-canonical': '技術メモ',
	'astro-nextjs-cms': '技術メモ',
};
const CAT_COLOR = {
	入門: ['#e9f6ec', '#d3ecdb'],
	使い方: ['#e7eeff', '#d3dfff'],
	開発事例: ['#efe9ff', '#ded4ff'],
	制作記録: ['#e6f5f2', '#d0ece6'],
	注意点: ['#fdf1e3', '#f9e1c6'],
	技術メモ: ['#eaeef5', '#dae1ef'],
	記事: ['#eef1f6', '#dde3ee'],
};

function frontmatter(src) {
	const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	return m ? m[1] : '';
}
function getTitle(fm) {
	const m = fm.match(/^title:\s*(.+)$/m);
	if (!m) return '';
	let t = m[1].trim();
	if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
		t = t.slice(1, -1);
	}
	return t;
}
function titleFontSize(len) {
	if (len <= 14) return 66;
	if (len <= 22) return 54;
	if (len <= 32) return 44;
	return 38;
}

async function main() {
	mkdirSync(OUT, { recursive: true });

	const fonts = [
		{ name: 'Noto Sans JP', weight: 700, style: 'normal', data: readFileSync(join(FONTS, 'NotoSansJP-700.woff')) },
		{ name: 'Noto Sans JP', weight: 700, style: 'normal', data: readFileSync(join(FONTS, 'NotoSansJP-latin-700.woff')) },
		{ name: 'Noto Sans JP', weight: 400, style: 'normal', data: readFileSync(join(FONTS, 'NotoSansJP-400.woff')) },
		{ name: 'Noto Sans JP', weight: 400, style: 'normal', data: readFileSync(join(FONTS, 'NotoSansJP-latin-400.woff')) },
	];
	const logoDataUri = `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`;

	const files = readdirSync(BLOG).filter((n) => n.endsWith('.md') || n.endsWith('.mdx'));
	let made = 0;
	for (const f of files) {
		const slug = f.replace(/\.(md|mdx)$/, '');
		const src = readFileSync(join(BLOG, f), 'utf-8');
		const fm = frontmatter(src);
		if (/^heroImage:\s*\S/m.test(fm)) continue; // 手動指定はスキップ

		const title = getTitle(fm) || slug;
		const category = CATEGORY[slug] ?? '記事';
		const [c1, c2] = CAT_COLOR[category] ?? CAT_COLOR['記事'];

		const svg = await satori(
			{
				type: 'div',
				props: {
					style: {
						width: '100%',
						height: '100%',
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'space-between',
						padding: '70px',
						background: `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`,
						fontFamily: 'Noto Sans JP',
					},
					children: [
						{
							type: 'div',
							props: {
								style: { display: 'flex' },
								children: [
									{
										type: 'div',
										props: {
											style: {
												fontSize: 30,
												fontWeight: 700,
												color: '#000d8a',
												background: 'rgba(255,255,255,0.8)',
												padding: '10px 28px',
												borderRadius: '999px',
											},
											children: category,
										},
									},
								],
							},
						},
						{
							type: 'div',
							props: {
								style: {
									display: 'flex',
									fontSize: titleFontSize([...title].length),
									fontWeight: 700,
									color: '#14181f',
									lineHeight: 1.35,
									letterSpacing: '0.01em',
								},
								children: title,
							},
						},
						{
							type: 'div',
							props: {
								style: { display: 'flex', alignItems: 'center' },
								children: [
									{
										type: 'img',
										props: {
											src: logoDataUri,
											width: 60,
											height: 60,
											style: { borderRadius: 14, marginRight: 20 },
										},
									},
									{
										type: 'div',
										props: {
											style: { fontSize: 30, fontWeight: 700, color: '#3a4658' },
											children: '0から始める優しいAI生活',
										},
									},
								],
							},
						},
					],
				},
			},
			{ width: W, height: H, fonts },
		);

		await sharp(Buffer.from(svg)).webp({ quality: 84 }).toFile(join(OUT, `${slug}.webp`));
		made++;
	}
	console.log(`[thumb] ${made} 件のサムネを生成（タイトル入り）`);
}

main().catch((e) => {
	console.warn('[thumb] 失敗:', e.message);
});
