// 効果音（Web Audio API のみ・外部音源ファイル不要）。
// ゲームエンジン（chaos-pendulum.ts）はこのモジュールに依存しない。
// AudioContext はブラウザの Autoplay 制限に配慮し、最初のユーザー操作後に開始する。
// ミュート状態は localStorage に保持する。

import type { RoundKind } from './chaos-pendulum';

const MUTE_KEY = 'cp:muted';

export interface GameAudio {
	/** STOP 入力のごく短いクリック音 */
	stopClick(): void;
	/** ラウンド判定音（perfect / nice / miss / timeup） */
	judgment(kind: RoundKind): void;
	/** 自己ベスト更新の特別な音 */
	best(): void;
	/** ランキング上位入りの祝福音 */
	rankUp(): void;
	/** ミュート切り替え。切り替え後の muted を返す */
	toggleMute(): boolean;
	isMuted(): boolean;
}

function readMuted(): boolean {
	try {
		return localStorage.getItem(MUTE_KEY) === '1';
	} catch {
		return false;
	}
}
function writeMuted(muted: boolean): void {
	try {
		localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
	} catch {
		/* localStorage 不可の環境では保持しないだけ */
	}
}

export function createAudio(): GameAudio {
	let ctx: AudioContext | null = null;
	let muted = readMuted();

	const AC: typeof AudioContext | undefined =
		typeof window !== 'undefined'
			? window.AudioContext ||
				(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
			: undefined;

	function ensureCtx(): AudioContext | null {
		if (!AC) return null;
		if (!ctx) {
			try {
				ctx = new AC();
			} catch {
				return null;
			}
		}
		if (ctx.state === 'suspended') void ctx.resume();
		return ctx;
	}

	// 最初のユーザー操作で AudioContext を起こす（Autoplay 制限対策）
	if (typeof window !== 'undefined') {
		const unlock = () => ensureCtx();
		window.addEventListener('pointerdown', unlock, { once: true });
		window.addEventListener('keydown', unlock, { once: true });
	}

	/** 単音。freq→freqTo へスイープ可。start は ctx.currentTime からの相対秒 */
	function tone(
		freq: number,
		start: number,
		dur: number,
		type: OscillatorType,
		gain: number,
		freqTo?: number,
	): void {
		const c = ensureCtx();
		if (!c || muted) return;
		const t0 = c.currentTime + start;
		const osc = c.createOscillator();
		const g = c.createGain();
		osc.type = type;
		osc.frequency.setValueAtTime(freq, t0);
		if (freqTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + dur);
		// 軽いエンベロープ（クリックノイズを避ける）
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
		osc.connect(g).connect(c.destination);
		osc.start(t0);
		osc.stop(t0 + dur + 0.02);
	}

	return {
		stopClick() {
			// 短く控えめなクリック（主張しすぎない）
			tone(1200, 0, 0.04, 'triangle', 0.12);
		},
		judgment(kind: RoundKind) {
			switch (kind) {
				case 'perfect':
					// 高く短く気持ちいい2音上昇
					tone(880, 0, 0.09, 'triangle', 0.2);
					tone(1320, 0.08, 0.12, 'triangle', 0.2);
					break;
				case 'nice':
					// PERFECT より控えめな単音
					tone(660, 0, 0.12, 'triangle', 0.16);
					break;
				case 'miss':
					// 低く少し濁った音（不快すぎない）
					tone(180, 0, 0.16, 'sawtooth', 0.14, 150);
					break;
				case 'timeup':
					// 乾いた失敗音（下降）
					tone(220, 0, 0.22, 'square', 0.13, 110);
					break;
			}
		},
		best() {
			// 特別感のある3音アルペジオ
			tone(660, 0, 0.1, 'triangle', 0.18);
			tone(880, 0.1, 0.1, 'triangle', 0.18);
			tone(1320, 0.2, 0.18, 'triangle', 0.2);
		},
		rankUp() {
			// 短い祝福音
			tone(990, 0, 0.09, 'triangle', 0.18);
			tone(1480, 0.09, 0.14, 'triangle', 0.2);
		},
		toggleMute() {
			muted = !muted;
			writeMuted(muted);
			if (!muted) ensureCtx();
			return muted;
		},
		isMuted() {
			return muted;
		},
	};
}
