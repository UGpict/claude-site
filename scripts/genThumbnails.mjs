// heroImage 未指定の記事＋主要ページに、タイトル/ラベル入りのサムネ（OG兼用）を自動生成する。
// satori でフォントをパス化するため、ビルド環境のフォント有無に依存しない（文字化けしない）。
// 出力: public/thumb/<slug>.webp（記事） / _home,_blog,_about,_cat-<カテゴリ>.webp（ページ）
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
const SITE_TITLE = '0から始める優しいAI生活';

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
const DEFAULT_COLOR = ['#e7eeff', '#d3dfff'];

function frontmatter(src) {
	const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	return m ? m[1] : '';
}
function getTitle(fm) {
	const m = fm.match(/^title:\s*(.+)$/m);
	if (!m) return '';
	let t = m[1].trim();
	if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) t = t.slice(1, -1);
	return t;
}
function titleFontSize(len) {
	if (len <= 14) return 66;
	if (len <= 22) return 54;
	if (len <= 32) return 44;
	return 38;
}

let FONTS_DATA;
let LOGO_URI;

async function renderCard({ title, label, colors }) {
	const [c1, c2] = colors;
	const children = [];
	children.push({
		type: 'div',
		props: {
			style: { display: 'flex' },
			children: label
				? [
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
								children: label,
							},
						},
					]
				: [],
		},
	});
	children.push({
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
	});
	children.push({
		type: 'div',
		props: {
			style: { display: 'flex', alignItems: 'center' },
			children: [
				{ type: 'img', props: { src: LOGO_URI, width: 60, height: 60, style: { borderRadius: 14, marginRight: 20 } } },
				{ type: 'div', props: { style: { fontSize: 30, fontWeight: 700, color: '#3a4658' }, children: SITE_TITLE } },
			],
		},
	});

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
				children,
			},
		},
		{ width: W, height: H, fonts: FONTS_DATA },
	);
	return sharp(Buffer.from(svg)).webp({ quality: 84 }).toBuffer();
}

async function main() {
	mkdirSync(OUT, { recursive: true });
	FONTS_DATA = [
		{ name: 'Noto Sans JP', weight: 700, style: 'normal', data: readFileSync(join(FONTS, 'NotoSansJP-700.woff')) },
		{ name: 'Noto Sans JP', weight: 700, style: 'normal', data: readFileSync(join(FONTS, 'NotoSansJP-latin-700.woff')) },
		{ name: 'Noto Sans JP', weight: 400, style: 'normal', data: readFileSync(join(FONTS, 'NotoSansJP-400.woff')) },
		{ name: 'Noto Sans JP', weight: 400, style: 'normal', data: readFileSync(join(FONTS, 'NotoSansJP-latin-400.woff')) },
	];
	LOGO_URI = `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`;

	let made = 0;
	const write = async (name, buf) => {
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(OUT, name), buf);
		made++;
	};

	// 記事（heroImage 未指定のみ）
	const files = readdirSync(BLOG).filter((n) => n.endsWith('.md') || n.endsWith('.mdx'));
	for (const f of files) {
		const slug = f.replace(/\.(md|mdx)$/, '');
		const fm = frontmatter(readFileSync(join(BLOG, f), 'utf-8'));
		if (/^heroImage:\s*\S/m.test(fm)) continue;
		const category = CATEGORY[slug] ?? '記事';
		await write(`${slug}.webp`, await renderCard({ title: getTitle(fm) || slug, label: category, colors: CAT_COLOR[category] ?? CAT_COLOR['記事'] }));
	}

	// 主要ページ
	await write('_home.webp', await renderCard({ title: SITE_TITLE, label: '', colors: DEFAULT_COLOR }));
	await write('_blog.webp', await renderCard({ title: '記事一覧', label: '', colors: DEFAULT_COLOR }));
	await write('_about.webp', await renderCard({ title: 'このブログについて', label: '', colors: DEFAULT_COLOR }));
	for (const cat of [...new Set(Object.values(CATEGORY))]) {
		await write(`_cat-${cat}.webp`, await renderCard({ title: `「${cat}」の記事`, label: cat, colors: CAT_COLOR[cat] ?? CAT_COLOR['記事'] }));
	}

	console.log(`[thumb] ${made} 件のサムネを生成（記事＋ページ）`);
}

main().catch((e) => {
	console.warn('[thumb] 失敗:', e.message);
});
