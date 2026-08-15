// ```mermaid コードブロックを、shiki に渡す前に <pre class="mermaid"> へ変換する。
// こうすると shiki が構文ハイライトしようとして崩すのを防げ、
// クライアント側の mermaid.js がそのまま図として描画できる。
// （描画スクリプトは BlogPost.astro 側。図があるページだけ遅延ロードする）

function escapeHtml(str) {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function walk(node) {
	if (!node || !Array.isArray(node.children)) return;
	for (let i = 0; i < node.children.length; i++) {
		const child = node.children[i];
		if (child.type === 'code' && child.lang === 'mermaid') {
			node.children[i] = {
				type: 'html',
				value: `<pre class="mermaid" role="img">${escapeHtml(child.value)}</pre>`,
			};
		} else {
			walk(child);
		}
	}
}

export default function remarkMermaid() {
	return (tree) => walk(tree);
}
