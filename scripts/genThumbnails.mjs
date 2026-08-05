// heroImage を指定していない記事に、スラッグから色を決めた抽象サムネを自動生成する。
// 日本語テキストは画像に焼かない（ビルド環境のフォント有無に依存しないため）。
// 出力: public/thumb/<slug>.webp（1200x630, OG 兼用）
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const dir = import.meta.dirname;
const BLOG = join(dir, '..', 'src', 'content', 'blog');
const OUT = join(dir, '..', 'public', 'thumb');
const LOGO = join(dir, '..', 'src', 'assets', 'logo.png');

const W = 1200;
const H = 630;

function hash(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function card(hue) {
	const h2 = (hue + 32) % 360;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},66%,90%)"/>
      <stop offset="1" stop-color="hsl(${h2},58%,82%)"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <circle cx="1010" cy="120" r="220" fill="hsl(${h2},72%,95%)" opacity="0.55"/>
  <circle cx="180" cy="560" r="180" fill="hsl(${hue},64%,86%)" opacity="0.5"/>
  <circle cx="980" cy="540" r="90" fill="hsl(${h2},70%,92%)" opacity="0.5"/>
  <rect x="410" y="125" width="380" height="380" rx="44" fill="#ffffff" opacity="0.9"/>
</svg>`;
}

async function main() {
	mkdirSync(OUT, { recursive: true });

	const logo = await sharp(LOGO)
		.resize(300, 300, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png()
		.toBuffer();

	const files = readdirSync(BLOG).filter((n) => n.endsWith('.md') || n.endsWith('.mdx'));
	let made = 0;
	for (const f of files) {
		const slug = f.replace(/\.(md|mdx)$/, '');
		const src = readFileSync(join(BLOG, f), 'utf-8');
		// heroImage を明示している記事はスキップ（手動優先）。改行コードに依存しない判定。
		if (/^heroImage:\s*\S/m.test(src)) continue;

		const hue = hash(slug) % 360;
		const base = await sharp(Buffer.from(card(hue))).png().toBuffer();
		await sharp(base)
			.composite([{ input: logo, gravity: 'center' }])
			.webp({ quality: 82 })
			.toFile(join(OUT, `${slug}.webp`));
		made++;
	}
	console.log(`[thumb] ${made} 件の自動サムネを生成`);
}

main().catch((e) => {
	console.warn('[thumb] 失敗:', e.message);
});
