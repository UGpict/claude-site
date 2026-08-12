// heroImage 未指定の記事＋主要ページに、タイトル/ラベル入りのサムネ（OG兼用）を自動生成する。
// satori でフォントをパス化するため、ビルド環境のフォント有無に依存しない（文字化けしない）。
// 出力: public/thumb/<slug>.webp（記事） / _home,_blog,_about,_cat-<カテゴリ>.webp（ページ）
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import satori from 'satori';
import sharp from 'sharp';

const dir = import.meta.dirname;
const BLOG = join(dir, '..', 'src', 'content', 'blog');
const OUT = join(dir, '..', 'public', 'thumb');
const BG_DIR = join(dir, '..', 'public', 'thumb-bg'); // 画像生成AIで作った背景（あれば使う）
const CONSTS = join(dir, '..', 'src', 'consts.ts');
const FONTS = join(dir, '..', 'src', 'assets', 'fonts');
const LOGO = join(dir, '..', 'src', 'assets', 'logo-lg.png');

const W = 1200;
const H = 630;
const SITE_TITLE = '0から始める優しいAI生活';

// カテゴリは consts.ts を単一の真実として読む（ここで二重管理するとラベルがずれるため）
function loadCategories() {
	try {
		const src = readFileSync(CONSTS, 'utf-8');
		const block = src.match(/CATEGORY[^{]*\{([\s\S]*?)\}/);
		const map = {};
		if (block) for (const m of block[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) map[m[1]] = m[2];
		return map;
	} catch {
		return {};
	}
}
const CATEGORY = loadCategories();
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
function hashStr(s) {
	let x = 2166136261;
	for (const ch of s) {
		x ^= ch.charCodeAt(0);
		x = Math.imul(x, 16777619);
	}
	return x >>> 0;
}
function titleFontSize(len) {
	if (len <= 12) return 60;
	if (len <= 20) return 50;
	if (len <= 30) return 40;
	return 34;
}
function circle(size, style) {
	return { type: 'div', props: { style: { position: 'absolute', width: size, height: size, borderRadius: 9999, ...style } } };
}

let FONTS_DATA;
let LOGO_URI;

async function renderCard({ title, label, colors, bg = null }) {
	const [c1, c2] = colors;
	const seed = hashStr(title);
	const off = (seed % 60) - 30; // -30..29 の揺らぎ
	const overlay = !!bg; // AI 背景の上に文字を重ねるモード

	// 文字色：AI 背景あり＝白（暗いスクリム前提）／なし＝従来の濃色
	const titleColor = overlay ? '#ffffff' : '#14181f';
	const footerColor = overlay ? '#eaf0fb' : '#3a4658';
	const pillTextColor = '#000d8a';
	const pillBg = overlay ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.85)';

	// 左：テキスト列（ピル / タイトル / フッター）
	const leftChildren = [];
	if (label) {
		leftChildren.push({
			type: 'div',
			props: {
				style: { display: 'flex' },
				children: [
					{
						type: 'div',
						props: {
							style: { fontSize: 28, fontWeight: 700, color: pillTextColor, background: pillBg, padding: '8px 26px', borderRadius: 9999 },
							children: label,
						},
					},
				],
			},
		});
	} else {
		leftChildren.push({ type: 'div', props: { style: { display: 'flex', height: 20 }, children: [] } });
	}
	leftChildren.push({
		type: 'div',
		props: {
			style: {
				display: 'flex',
				fontSize: titleFontSize([...title].length),
				fontWeight: 700,
				color: titleColor,
				lineHeight: 1.35,
				letterSpacing: '0.01em',
				textShadow: overlay ? '0 2px 12px rgba(10,15,30,0.55)' : 'none',
			},
			children: title,
		},
	});
	leftChildren.push({
		type: 'div',
		props: {
			style: { display: 'flex', alignItems: 'center' },
			children: [
				{ type: 'img', props: { src: LOGO_URI, width: 48, height: 48, style: { borderRadius: 12, marginRight: 16 } } },
				{ type: 'div', props: { style: { fontSize: 26, fontWeight: 700, color: footerColor }, children: SITE_TITLE } },
			],
		},
	});

	// 背景レイヤー：AI 背景ありなら透明ルート＋左を暗くするスクリム、なしなら従来のグラデ＋装飾円
	const bgChildren = overlay
		? [
				{
					type: 'div',
					props: {
						style: {
							position: 'absolute',
							top: 0,
							left: 0,
							width: '100%',
							height: '100%',
							backgroundImage:
								'linear-gradient(90deg, rgba(12,16,26,0.74) 0%, rgba(12,16,26,0.48) 46%, rgba(12,16,26,0.10) 100%)',
						},
					},
				},
			]
		: [
				circle(520, { top: -140 + off, right: -120, background: 'rgba(255,255,255,0.45)' }),
				circle(300, { bottom: -90, left: -70 + off, background: 'rgba(255,255,255,0.35)' }),
				circle(120, { top: 150 - off, left: 470, background: 'rgba(255,255,255,0.4)' }),
			];

	// AI 背景ありのときはマスコットバッジを出さない（AI の絵が主役なので）
	const contentChildren = [
		{
			type: 'div',
			props: {
				style: { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: overlay ? 820 : 660, height: '100%', paddingRight: 24 },
				children: leftChildren,
			},
		},
	];
	if (!overlay) {
		contentChildren.push({
			type: 'div',
			props: {
				style: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' },
				children: [
					{
						type: 'div',
						props: {
							style: {
								display: 'flex',
								width: 340,
								height: 340,
								borderRadius: 9999,
								background: '#ffffff',
								alignItems: 'center',
								justifyContent: 'center',
								boxShadow: '0 24px 60px rgba(20,30,60,0.18)',
							},
							children: [{ type: 'img', props: { src: LOGO_URI, width: 300, height: 300 } }],
						},
					},
				],
			},
		});
	}

	const svg = await satori(
		{
			type: 'div',
			props: {
				style: {
					width: '100%',
					height: '100%',
					display: 'flex',
					position: 'relative',
					overflow: 'hidden',
					background: overlay ? 'transparent' : `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`,
					fontFamily: 'Noto Sans JP',
				},
				children: [
					...bgChildren,
					{
						type: 'div',
						props: {
							style: { display: 'flex', position: 'relative', width: '100%', height: '100%', padding: '64px', alignItems: 'center' },
							children: contentChildren,
						},
					},
				],
			},
		},
		{ width: W, height: H, fonts: FONTS_DATA },
	);

	// AI 背景ありなら、背景 PNG の上に透明の文字レイヤーを合成
	if (overlay) {
		const base = sharp(bg).resize(W, H, { fit: 'cover' });
		return base.composite([{ input: Buffer.from(svg) }]).webp({ quality: 84 }).toBuffer();
	}
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
		const bgPath = join(BG_DIR, `${slug}.png`);
		const bg = existsSync(bgPath) ? readFileSync(bgPath) : null; // AI 背景があれば使う
		if (bg) console.log(`[thumb] AI 背景を使用: ${slug}`);
		await write(`${slug}.webp`, await renderCard({ title: getTitle(fm) || slug, label: category, colors: CAT_COLOR[category] ?? CAT_COLOR['記事'], bg }));
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
