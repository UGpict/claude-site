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
// 認証は 2 通り（どちらか）:
//   A) AI Studio の API キー（手軽）:
//        npm i @google/genai
//        aistudio.google.com で GEMINI_API_KEY を取得し、環境変数にセット
//   B) Vertex AI ＝ KangaL と同じ GCP を再利用（新しい鍵を作らない）:
//        npm i @google/genai
//        Vertex AI API を有効化し、SA に roles/aiplatform.user を付与
//        環境変数: GOOGLE_GENAI_USE_VERTEXAI=true
//                  GOOGLE_CLOUD_PROJECT=<プロジェクトID 例: ai-bridging>
//                  GOOGLE_CLOUD_LOCATION=us-central1（省略時この値）
//                  GOOGLE_APPLICATION_CREDENTIALS=<サービスアカウントJSONのパス>
//                  （または `gcloud auth application-default login` 済みならパス不要）
//   ※ 鍵・JSON は Git に絶対に入れない（環境変数で渡す）。
//   ※ 画像生成は GCP に実課金されます。
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
// Vertex AI（KangaL の GCP 再利用）を使うか、AI Studio の API キーを使うか
const USE_VERTEX =
	/^(1|true)$/i.test(process.env.GOOGLE_GENAI_USE_VERTEXAI || '') || (!process.env.GEMINI_API_KEY && !!process.env.GOOGLE_CLOUD_PROJECT);
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GCP_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

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
function unquote(s) {
	let t = s.trim();
	if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) t = t.slice(1, -1);
	return t;
}
function getField(fm, key) {
	const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
	return m ? unquote(m[1]) : '';
}
const getTitle = (fm) => getField(fm, 'title');
const getDescription = (fm) => getField(fm, 'description');

// 記事の内容（タイトル＋要約）を渡し、「一目で主題が分かる象徴的なイラスト」を作らせる。
// 文字は描かせない（日本語が崩れる）。左側は satori のタイトル用に空ける。
function buildPrompt({ title, description, category }) {
	const mood = CAT_MOOD[category] || CAT_MOOD['記事'];
	return [
		'A striking blog thumbnail image that instantly communicates the article topic at a glance.',
		`Article title (Japanese): "${title}".`,
		description ? `Article summary (Japanese): "${description}".` : '',
		'Show ONE clear hero object or an atmospheric real-world scene that represents this specific topic,',
		'so a viewer immediately understands the subject even without reading any text.',
		'Prefer a photographic look or a high-quality 3D render with real materials, texture, lighting and soft depth of field —',
		'NOT a flat cartoon or vector illustration.',
		`Subject/mood hint: ${mood}.`,
		'Composition: place the main subject on the RIGHT two-thirds; keep the LEFT third calm, simple and softly out-of-focus for a text overlay.',
		'Palette: tasteful and eye-catching, leaning on calm blue that fits a modern tech blog.',
		'CRITICAL: the image must contain absolutely NO text of any kind — no letters, words, numbers, labels, captions, signage, logos, watermarks, or UI screens with writing. Represent everything visually, never with written words.',
		'Wide 16:9 composition.',
	]
		.filter(Boolean)
		.join(' ');
}

// ── ここが唯一「画像生成AIを叩く」部分。SDK のバージョンで戻り値の形が変わりうるので、
//    inlineData を探す実装にしてある。モデルは IMAGE_MODEL で上書き可。 ──
let _ai;
async function getClient() {
	if (_ai) return _ai;
	const { GoogleGenAI } = await import('@google/genai');
	_ai = USE_VERTEX
		? new GoogleGenAI({ vertexai: true, project: GCP_PROJECT, location: GCP_LOCATION }) // ADC で認証（KangaL の GCP）
		: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
	return _ai;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateOnce(prompt) {
	const ai = await getClient();
	const resp = await ai.models.generateContent({ model: MODEL, contents: prompt });
	const parts = resp?.candidates?.[0]?.content?.parts ?? [];
	for (const p of parts) {
		const data = p?.inlineData?.data;
		if (data) return Buffer.from(data, 'base64');
	}
	throw new Error('画像データが返りませんでした（モデル名や API 仕様を確認してください）');
}

// 429（レート制限）は指数バックオフでリトライ。それ以外は即失敗。
async function generateImage(prompt) {
	const backoffs = [15000, 30000, 60000, 90000];
	for (let attempt = 0; ; attempt++) {
		try {
			return await generateOnce(prompt);
		} catch (e) {
			const is429 = /429|RESOURCE_EXHAUSTED|exhausted/i.test(e.message || '');
			if (is429 && attempt < backoffs.length) {
				const wait = backoffs[attempt];
				console.log(`[thumb-bg]   レート制限。${wait / 1000}秒待って再試行（${attempt + 1}/${backoffs.length}）`);
				await sleep(wait);
				continue;
			}
			throw e;
		}
	}
}

async function main() {
	if (!USE_VERTEX && !process.env.GEMINI_API_KEY) {
		console.error('[thumb-bg] 認証情報がありません。GEMINI_API_KEY か、Vertex 用の GOOGLE_CLOUD_PROJECT 等を設定してください。');
		process.exit(1);
	}
	if (USE_VERTEX && !GCP_PROJECT) {
		console.error('[thumb-bg] Vertex モードには GOOGLE_CLOUD_PROJECT が必要です。');
		process.exit(1);
	}
	console.log(`[thumb-bg] 認証: ${USE_VERTEX ? `Vertex AI（project=${GCP_PROJECT}, location=${GCP_LOCATION}）` : 'AI Studio API キー'} / モデル: ${MODEL}`);
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
		const out = join(BG_DIR, `${slug}.webp`);
		if (existsSync(out) && !force) {
			skipped++;
			continue;
		}

		const category = cats[slug] || '記事';
		const prompt = buildPrompt({ title: getTitle(fm), description: getDescription(fm), category });
		try {
			console.log(`[thumb-bg] 生成中: ${slug}（${category}）`);
			const raw = await generateImage(prompt);
			// 1200x630 に整えて webp で保存（合成側と同じ比率・リポジトリを軽く）
			const img = await sharp(raw).resize(W, H, { fit: 'cover' }).webp({ quality: 90 }).toBuffer();
			writeFileSync(out, img);
			made++;
			await sleep(Number(process.env.THUMB_DELAY_MS || 4000)); // 分あたり上限に当たりにくくする
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
