// 効果音（Web Audio API のみ・外部音源ファイル不要）。
// ゲームエンジン（chaos-pendulum.ts）はこのモジュールに依存しない。
// AudioContext はブラウザの Autoplay 制限に配慮し、最初のユーザー操作後に開始する。
// ミュート状態は localStorage に保持する。

import type { CueSound, HitKind } from './chaos-pendulum';

const MUTE_KEY = 'cp:muted';

export interface GameAudio {
	/** 叩いた瞬間のごく短いクリック音 */
	stopClick(): void;
	/** 判定音（combo が続くほど層が厚く／fever でさらに）。 */
	judgment(kind: HitKind, combo?: number, fever?: boolean): void;
	/** リズム予告（タン・タン・ドン）を AudioContext.currentTime で先読みスケジュール（fps非依存） */
	scheduleRhythm(cues: { offset: number; sound: CueSound }[]): void;
	/** CHAOS FEVER 突入の上昇音 */
	fever(): void;
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

	// 先読み予約した予告音のうち「まだ鳴り始めていない」ものを、次のパターン開始時に取り消すため追跡する。
	let pending: { osc: OscillatorNode; startAt: number }[] = [];
	function clearPendingCues(c: AudioContext): void {
		const now = c.currentTime;
		for (const p of pending) {
			if (p.startAt > now) {
				try {
					p.osc.stop(now);
				} catch {
					/* 既に停止済みなどは無視 */
				}
			}
		}
		pending = [];
	}

	/** 単音。freq→freqTo へスイープ可。start は ctx.currentTime からの相対秒。track=true で取消対象に追跡。 */
	function tone(
		freq: number,
		start: number,
		dur: number,
		type: OscillatorType,
		gain: number,
		freqTo?: number,
		track = false,
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
		if (track) pending.push({ osc, startAt: t0 });
	}

	return {
		stopClick() {
			// 短く控えめなクリック（主張しすぎない）
			tone(1200, 0, 0.04, 'triangle', 0.12);
		},
		judgment(kind: HitKind, combo = 0, fever = false) {
			// 成功時はコンボが続くほど層を足す（0→kick/3→bass/5→hihat/10→melody/FEVER→lead）。
			// MISS でコンボが 0 に戻ると層も自然に剥がれる＝「切りたくない」を音で作る。
			if (kind === 'perfect' || kind === 'great' || kind === 'good') {
				if (combo >= 3) tone(146, 0, 0.14, 'triangle', 0.1); // bass D3
				if (combo >= 5) tone(3136, 0.0, 0.03, 'square', 0.05); // hi-hat 風
				if (combo >= 10) tone(880, 0.02, 0.12, 'triangle', 0.09); // melody 風
				if (fever) tone(1174, 0.0, 0.16, 'sawtooth', 0.09); // lead
			}
			switch (kind) {
				case 'perfect':
					// 駆け上がる明るいアルペジオ＋高音のきらめき（最高の祝福音）
					tone(784, 0, 0.09, 'triangle', 0.2); // G5
					tone(988, 0.06, 0.09, 'triangle', 0.2); // B5
					tone(1319, 0.12, 0.11, 'triangle', 0.22); // E6
					tone(1976, 0.2, 0.2, 'triangle', 0.22); // B6
					tone(2637, 0.22, 0.16, 'sine', 0.12); // E7 きらめき
					break;
				case 'great':
					// 気持ちよく上がる2音
					tone(660, 0, 0.1, 'triangle', 0.16); // E5
					tone(988, 0.08, 0.13, 'triangle', 0.17); // B5
					break;
				case 'good':
					// 軽い単音
					tone(587, 0, 0.1, 'triangle', 0.14); // D5
					break;
				case 'near':
					// 惜しい（軽く濁る）
					tone(300, 0, 0.12, 'sawtooth', 0.12, 240);
					break;
				case 'miss':
					// 低く少し濁った失敗音（不快すぎない）
					tone(180, 0, 0.16, 'sawtooth', 0.14, 150);
					break;
			}
		},
		scheduleRhythm(cues) {
			// tone() は ctx.currentTime + start に予約するので、offset を渡すだけで fps 非依存に先読みできる。
			const c = ensureCtx();
			if (!c || muted) return;
			clearPendingCues(c); // 前パターンの未再生の予告（早押しで消えた的のドン等）を取り消す
			for (const cue of cues) {
				if (cue.sound === 'accent') {
					// ドン：ここで押す合図。低く太い音＋クリック。
					tone(180, cue.offset, 0.14, 'sine', 0.22, 120, true);
					tone(90, cue.offset, 0.16, 'triangle', 0.13, undefined, true);
				} else {
					// タン：軽い予告クリック。
					tone(720, cue.offset, 0.05, 'square', 0.08, undefined, true);
				}
			}
		},
		fever() {
			// 上昇するリザー（フィーバー突入）
			tone(330, 0, 0.28, 'sawtooth', 0.16, 990);
			tone(660, 0.06, 0.24, 'triangle', 0.14, 1320);
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
