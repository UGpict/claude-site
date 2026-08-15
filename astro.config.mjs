// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';
import remarkMermaid from './src/plugins/remark-mermaid.mjs';

// https://astro.build/config
export default defineConfig({
	site: 'https://yasashiibai.com',
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
	integrations: [mdx(), sitemap()],
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
