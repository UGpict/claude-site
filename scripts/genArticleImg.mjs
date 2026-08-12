// 記事本文に差し込む AI 画像を1枚生成する（サムネとは別。文字は重ねないので左空け不要）。
// 出力: public/img/<slug>-<index>.webp（webp で軽く）
// 認証は genThumbBg.mjs と同じ（Vertex AI の ADC か、GEMINI_API_KEY）。
//
// 使い方:
//   GOOGLE_GENAI_USE_VERTEXAI=true GOOGLE_CLOUD_PROJECT=ai-bridging \
//     node scripts/genArticleImg.mjs <slug> <index> "英語のプロンプト（何を描くか）"
//   例: ... node scripts/genArticleImg.mjs prompt-injection-toha 1 "a glowing AI robotic hand reaching to connected app icons"
//   既存があってもスキップしない（毎回 --force 相当。上書き）。--keep で既存はスキップ。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const dir = import.meta.dirname;
const OUT_DIR = join(dir, '..', 'public', 'img');
const W = 1200;
const H = 630;
const MODEL = process.env.IMAGE_MODEL || 'gemini-2.5-flash-image';

const USE_VERTEX =
	/^(1|true)$/i.test(process.env.GOOGLE_GENAI_USE_VERTEXAI || '') || (!process.env.GEMINI_API_KEY && !!process.env.GOOGLE_CLOUD_PROJECT);
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GCP_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const [slug, index, ...rest] = args.filter((a) => !a.startsWith('--'));
const subject = rest.join(' ');

function buildPrompt(subject) {
	return [
		'A striking photographic or high-quality 3D-render image for a friendly beginner AI blog.',
		`Subject: ${subject}.`,
		'Real materials, texture, lighting and soft depth of field — NOT a flat cartoon or vector illustration.',
		'Calm blue-leaning palette that fits a modern tech blog; tasteful and eye-catching.',
		'CRITICAL: absolutely NO text, no letters, words, numbers, labels, captions, signage, logos, watermarks, or UI screens with writing.',
		'Wide 16:9 composition, clear single subject.',
	].join(' ');
}

async function generateOnce(prompt) {
	const { GoogleGenAI } = await import('@google/genai');
	const ai = USE_VERTEX
		? new GoogleGenAI({ vertexai: true, project: GCP_PROJECT, location: GCP_LOCATION })
		: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
	const resp = await ai.models.generateContent({ model: MODEL, contents: prompt });
	for (const p of resp?.candidates?.[0]?.content?.parts ?? []) {
		if (p?.inlineData?.data) return Buffer.from(p.inlineData.data, 'base64');
	}
	throw new Error('画像データが返りませんでした');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function generate(prompt) {
	const backoffs = [15000, 30000, 60000];
	for (let i = 0; ; i++) {
		try {
			return await generateOnce(prompt);
		} catch (e) {
			if (/429|RESOURCE_EXHAUSTED|exhausted/i.test(e.message || '') && i < backoffs.length) {
				console.log(`  レート制限。${backoffs[i] / 1000}秒待って再試行`);
				await sleep(backoffs[i]);
				continue;
			}
			throw e;
		}
	}
}

async function main() {
	if (!slug || !index || !subject) {
		console.error('使い方: node scripts/genArticleImg.mjs <slug> <index> "英語で描く内容"');
		process.exit(1);
	}
	if (!USE_VERTEX && !process.env.GEMINI_API_KEY) {
		console.error('認証情報がありません（GEMINI_API_KEY か Vertex 用の env）。');
		process.exit(1);
	}
	mkdirSync(OUT_DIR, { recursive: true });
	const out = join(OUT_DIR, `${slug}-${index}.webp`);
	if (existsSync(out) && keep) {
		console.log(`スキップ（既存）: ${out}`);
		return;
	}
	console.log(`生成中: ${slug}-${index}（${USE_VERTEX ? 'Vertex' : 'API key'} / ${MODEL}）`);
	const raw = await generate(buildPrompt(subject));
	const img = await sharp(raw).resize(W, H, { fit: 'cover' }).webp({ quality: 88 }).toBuffer();
	writeFileSync(out, img);
	console.log(`保存: public/img/${slug}-${index}.webp — 本文から ![alt](/img/${slug}-${index}.webp) で参照`);
}

main().catch((e) => {
	console.error('中断:', e.message);
	process.exit(1);
});
