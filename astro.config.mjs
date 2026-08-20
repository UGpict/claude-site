// @ts-check

import { readdirSync, readFileSync } from 'node:fs';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';
import remarkMermaid from './src/plugins/remark-mermaid.mjs';

const SITE = 'https://yasashiibai.com';

// サイトマップに記事の更新日（lastmod）を出す。frontmatter の updatedDate（無ければ pubDate）を読む。
function blogLastmods() {
	const dir = new URL('./src/content/blog/', import.meta.url);
	const map = {};
	for (const file of readdirSync(dir)) {
		if (!/\.mdx?$/.test(file)) continue;
		const slug = file.replace(/\.mdx?$/, '');
		const src = readFileSync(new URL(file, dir), 'utf-8');
		const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
		const raw = (
			fm.match(/^updatedDate:\s*['"]?([^'"\r\n]+)/m)?.[1] ??
			fm.match(/^pubDate:\s*['"]?([^'"\r\n]+)/m)?.[1] ??
			''
		).trim();
		const d = raw ? new Date(raw) : null;
		if (d && !Number.isNaN(d.getTime())) map[`${SITE}/blog/${slug}/`] = d.toISOString();
	}
	return map;
}
const BLOG_LASTMOD = blogLastmods();

// https://astro.build/config
export default defineConfig({
	site: SITE,
	// URL は末尾スラッシュ付きに統一（canonical / sitemap / 内部リンクと一致させる）
	trailingSlash: 'always',
	// コードブロックは黒背景のダークテーマで表示
	markdown: {
		// ```mermaid は shiki より前に <pre class="mermaid"> へ変換して図として描画する
		remarkPlugins: [remarkMermaid],
		shikiConfig: {
			theme: 'github-dark',
			wrap: true,
		},
	},
	integrations: [
		mdx(),
		sitemap({
			serialize(item) {
				const lastmod = BLOG_LASTMOD[item.url];
				if (lastmod) item.lastmod = lastmod;
				return item;
			},
		}),
	],
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'Atkinson',
			cssVariable: '--font-atkinson',
			fallbacks: ['sans-serif'],
			options: {
				variants: [
					{
						src: ['./src/assets/fonts/atkinson-regular.woff'],
						weight: 400,
						style: 'normal',
						display: 'swap',
					},
					{
						src: ['./src/assets/fonts/atkinson-bold.woff'],
						weight: 700,
						style: 'normal',
						display: 'swap',
					},
				],
			},
		},
	],
});
