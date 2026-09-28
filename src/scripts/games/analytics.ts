// ゲーム計測用の薄いラッパー。
// 既存サイトは GA4（gtag）を BaseHead.astro で読み込み済みなので、その window.gtag を叩くだけ。
// 新しい計測基盤は勝手に追加しない。gtag が無い環境（単体HTML・開発時など）では黙って何もしない。
//
// CHAOS BEAT のイベント名と params はエンジンの GameEventPayloads（chaos-pendulum.ts）が正。
// 例：game_over では score / maxCombo / 判定別件数 / averageAbsTimingOffsetMs などを送る。

type Gtag = (command: 'event', name: string, params?: Record<string, unknown>) => void;

export function trackGameEvent(name: string, params: Record<string, unknown> = {}): void {
	if (typeof window === 'undefined') return;
	const gtag = (window as unknown as { gtag?: Gtag }).gtag;
	if (typeof gtag === 'function') {
		gtag('event', name, params);
	}
	// 計測基盤が無い場合は何もしない（将来 CrazyGames 等では別 SDK に差し替える）。
}
