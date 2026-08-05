import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			// アフィリエイト広告・PR を含む記事は true にすると開示バナーを表示
			sponsored: z.boolean().default(false),
			// FAQ 構造化データ（生成AI/検索向け）。設定した記事だけ FAQPage を出力
			faq: z
				.array(z.object({ q: z.string(), a: z.string() }))
				.optional(),
		}),
});

export const collections = { blog };
