// 記事タイトル/カテゴリから、サムネの「背景イラスト」を画像生成AI（Google Gemini）で作る。
// ── 設計上の約束 ──
//  * ローカルで手動実行し、生成した PNG は public/thumb-bg/<slug>.png にコミットする。
//    （Cloudflare のビルドでは絶対に叩かない。毎回課金・毎回別の絵・ビルド不安定になるため）
//  * 文字は AI に描かせない（日本語が崩れる）。タイトルは genThumbnails.mjs が上に重ねる。
//  * 冪等：すでに背景がある記事はスキップ。--force で作り直し。
//
// 使い方:
//   GEMINI_API_KEY=xxxx node scripts/genThumbBg.mjs           # 背景の無い記事だけ生成
//   GEMINI_API_KEY=xxxx node scripts/genThumbBg.mjs <slug>    # 1 記事だけ
//   GEMINI_API_KEY=xxxx node scripts/genThumbBg.mjs --force   # 全記事を作り直し
//   IMAGE_MODEL=gemini-3-pro-image ... で使うモデルを上書き可
//
// 事前準備:
//   1. npm i @google/genai
//   2. Google AI Studio（aistudio.google.com）で API キーを取得
//   3. 環境変数 GEMINI_API_KEY にセット（Git には絶対に入れない）
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const dir = import.meta.dirname;
const BLOG = join(dir, '..', 'src', 'content', 'blog');
const CONSTS = join(dir, '..', 'src', 'consts.ts');
const BG_DIR = join(dir, '..', 'public', 'thumb-bg');

const W = 1200;
const H = 630;
const MODEL = process.env.IMAGE_MODEL || 'gemini-2.5-flash-image';

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlySlug = args.find((a) => !a.startsWith('--'));

// consts.ts の CATEGORY を単一の真実として読む（スラッグ→ラベル）
function loadCategories() {
	const src = readFileSync(CONSTS, 'utf-8');
	const block = src.match(/CATEGORY[^{]*\{([\s\S]*?)\}/);
	const map = {};
	if (block) {
		for (const m of block[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) map[m[1]] = m[2];
	}
	return map;
}

// カテゴリごとの絵の雰囲気（AI へのヒント）。ブランドは青系のやさしいパステル。
const CAT_MOOD = {
	入門: 'gentle open doorway and soft sunrise, welcoming beginner feeling',
	使い方: 'tidy desk tools and simple UI shapes, practical how-to feeling',
	開発事例: 'abstract building blocks and connected nodes, creative engineering feeling',
	制作記録: 'a growing plant and sketch lines, hand-made progress feeling',
	注意点: 'a calm shield and guard-rail shapes, safe and careful feeling',
	技術メモ: 'thin circuit lines and neat geometric grid, quiet technical feeling',
	記事: 'soft abstract shapes, calm editorial feeling',
};

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

function buildPrompt(category) {
	const mood = CAT_MOOD[category] || CAT_MOOD['記事'];
	return [
		'A soft, friendly, minimalist flat-illustration background for a blog thumbnail.',
		`Theme mood: ${mood}.`,
		'Gentle pastel palette centered on calm blue (#2337ff family) with plenty of white.',
		'Leave the LEFT HALF mostly empty and uncluttered for text overlay.',
		'Clean modern editorial style, subtle geometric shapes, soft gradients.',
		'ABSOLUTELY NO text, no letters, no words, no numbers, no logos, no watermark.',
		'Wide 16:9 composition.',
	].join(' ');
}

// ── ここが唯一「画像生成AIを叩く」部分。SDK のバージョンで戻り値の形が変わりうるので、
//    inlineData を探す実装にしてある。モデルは IMAGE_MODEL で上書き可。 ──
async function generateImage(prompt) {
	const { GoogleGenAI } = await import('@google/genai');
	const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
	const resp = await ai.models.generateContent({ model: MODEL, contents: prompt });

	const parts = resp?.candidates?.[0]?.content?.parts ?? [];
	for (const p of parts) {
		const data = p?.inlineData?.data;
		if (data) return Buffer.from(data, 'base64');
	}
	throw new Error('画像データが返りませんでした（モデル名や API 仕様を確認してください）');
}

async function main() {
	if (!process.env.GEMINI_API_KEY) {
		console.error('[thumb-bg] GEMINI_API_KEY が未設定です。中止します。');
		process.exit(1);
	}
	mkdirSync(BG_DIR, { recursive: true });
	const cats = loadCategories();

	let files = readdirSync(BLOG).filter((n) => n.endsWith('.md') || n.endsWith('.mdx'));
	if (onlySlug) files = files.filter((n) => n.replace(/\.(md|mdx)$/, '') === onlySlug);

	let made = 0;
	let skipped = 0;
	for (const f of files) {
		const slug = f.replace(/\.(md|mdx)$/, '');
		const fm = frontmatter(readFileSync(join(BLOG, f), 'utf-8'));
		if (/^heroImage:\s*\S/m.test(fm)) continue; // 手動ヒーロー画像がある記事は対象外
		const out = join(BG_DIR, `${slug}.png`);
		if (existsSync(out) && !force) {
			skipped++;
			continue;
		}

		const category = cats[slug] || '記事';
		const prompt = buildPrompt(category);
		try {
			console.log(`[thumb-bg] 生成中: ${slug}（${category}）`);
			const raw = await generateImage(prompt);
			// 1200x630 に整えて保存（合成側と同じ比率にそろえる）
			const png = await sharp(raw).resize(W, H, { fit: 'cover' }).png().toBuffer();
			writeFileSync(out, png);
			made++;
		} catch (e) {
			console.warn(`[thumb-bg] 失敗: ${slug} — ${e.message}`);
		}
	}
	console.log(`[thumb-bg] 生成 ${made} 件 / スキップ ${skipped} 件（既存）。`);
	console.log('[thumb-bg] 生成した背景は public/thumb-bg/ をコミットしてください。');
}

main().catch((e) => {
	console.error('[thumb-bg] 中断:', e.message);
	process.exit(1);
});
