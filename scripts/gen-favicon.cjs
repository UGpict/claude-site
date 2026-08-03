// ロゴ画像を favicon 用に変換するスクリプト。
// 使い方: node scripts/gen-favicon.cjs "<元画像パス>"
const sharp = require('sharp');
const path = require('node:path');

const src =
	process.argv[2] ||
	'C:/Users/zeak2/Downloads/Gemini_Generated_Image_l1r4wxl1r4wxl1r4.png';
const outDir = path.join(__dirname, '..', 'public');

(async () => {
	// 周囲の白い余白を除去
	const trimmed = await sharp(src).trim({ threshold: 12 }).toBuffer();
	const meta = await sharp(trimmed).metadata();

	// 少し余白をつけて正方形の白背景に中央配置
	const side = Math.max(meta.width, meta.height);
	const pad = Math.round(side * 0.08);
	const canvas = side + pad * 2;
	const squared = await sharp({
		create: {
			width: canvas,
			height: canvas,
			channels: 4,
			background: '#ffffff',
		},
	})
		.composite([{ input: trimmed, gravity: 'center' }])
		.png()
		.toBuffer();

	await sharp(squared)
		.resize(512, 512)
		.webp({ quality: 90 })
		.toFile(path.join(outDir, 'favicon.webp'));
	await sharp(squared)
		.resize(512, 512)
		.png()
		.toFile(path.join(outDir, 'favicon-512.png'));
	await sharp(squared)
		.resize(180, 180)
		.png()
		.toFile(path.join(outDir, 'apple-touch-icon.png'));

	console.log('done. original', meta.width + 'x' + meta.height);
})();
