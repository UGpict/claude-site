// ゲーム計測用の薄いラッパー。
// 既存サイトは GA4（gtag）を BaseHead.astro で読み込み済みなので、その window.gtag を叩くだけ。
// 新しい計測基盤は勝手に追加しない。gtag が無い環境（単体HTML・開発時など）では黙って何もしない。
//
// 送れるイベント: game_view / game_start / round_complete / game_complete / game_retry / score_share
// game_complete では score / rounds / duration を送る。

type Gtag = (command: 'event', name: string, params?: Record<string, unknown>) => void;

export function trackGameEvent(name: string, params: Record<string, unknown> = {}): void {
	if (typeof window === 'undefined') return;
	const gtag = (window as unknown as { gtag?: Gtag }).gtag;
	if (typeof gtag === 'function') {
		gtag('event', name, params);
	}
	// 計測基盤が無い場合は何もしない（将来 CrazyGames 等では別 SDK に差し替える）。
}
