// 効果音（Web Audio API のみ・外部音源ファイル不要）。
// ゲームエンジン（chaos-pendulum.ts）はこのモジュールに依存しない。
// AudioContext はブラウザの Autoplay 制限に配慮し、最初のユーザー操作後に開始する。
// ミュート状態は localStorage に保持する。

import type { CueSound, HitKind } from './chaos-pendulum';

const MUTE_KEY = 'cp:muted';

export interface GameAudio {
	/** 叩いた瞬間のごく短いクリック音 */
	stopClick(): void;
	/** 判定音（PERFECT/GREAT/GOOD/near/miss のフィードバックのみ。BGMレイヤーは別担当） */
	judgment(kind: HitKind): void;
	/** リズム予告（タン・タン・ドン）を AudioContext.currentTime で先読みスケジュール（fps非依存） */
	scheduleRhythm(cues: { offset: number; sound: CueSound }[]): void;
	/** CHAOS FEVER 突入の上昇音 */
	fever(): void;
	/** 自己ベスト更新の特別な音 */
	best(): void;
	/** ランキング上位入りの祝福音 */
	rankUp(): void;
	// --- 持続BGM（拍に同期したループ。コンボで層が増え、MISSで減る） ---
	/** BGM開始（ゲーム開始時。拍頭からドラムのみ） */
	startMusic(): void;
	/** BGM停止（ゲーム終了時。短くフェードアウト） */
	stopMusic(): void;
	/** レイヤーの厚さ（0=drum / 1=+bass / 2=+perc / 3=+melody）。切替は次の拍に自然に反映 */
	setMusicLevel(level: number): void;
	/** FEVER レイヤーの ON/OFF */
	setFever(active: boolean): void;
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

	// --- 持続BGM（拍同期ループ・先読みスケジューラ） ---
	const BGM_BPM = 130;
	const SPB = 60 / BGM_BPM; // 1拍の秒数（＝エンジンの BEAT と一致）
	let bgmGain: GainNode | null = null;
	let musicTimer: ReturnType<typeof setInterval> | null = null;
	let bgmBeat = 0; // 通し拍カウンタ
	let nextBeatTime = 0; // 次に予約する拍の audio 時刻
	let musicLevel = 0; // 0=drum / 1=+bass / 2=+perc / 3=+melody
	let feverOn = false;

	function ensureBgmGain(c: AudioContext): GainNode {
		if (!bgmGain) {
			bgmGain = c.createGain();
			bgmGain.gain.value = muted ? 0 : 0.9;
			bgmGain.connect(c.destination);
		}
		return bgmGain;
	}
	// BGM 用の単音（bgmGain 経由。cue/judgment より控えめにして予告を埋もれさせない）
	function bgmTone(
		c: AudioContext,
		dest: AudioNode,
		freq: number,
		at: number,
		dur: number,
		type: OscillatorType,
		gain: number,
		freqTo?: number,
	): void {
		const osc = c.createOscillator();
		const g = c.createGain();
		osc.type = type;
		osc.frequency.setValueAtTime(freq, at);
		if (freqTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), at + dur);
		g.gain.setValueAtTime(0.0001, at);
		g.gain.exponentialRampToValueAtTime(gain, at + 0.005);
		g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
		osc.connect(g).connect(dest);
		osc.start(at);
		osc.stop(at + dur + 0.02);
	}
	// ハイハット/スネア風のノイズ
	function bgmNoise(c: AudioContext, dest: AudioNode, at: number, dur: number, hp: number, gain: number): void {
		const len = Math.max(1, Math.floor(c.sampleRate * dur));
		const buf = c.createBuffer(1, len, c.sampleRate);
		const data = buf.getChannelData(0);
		for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
		const src = c.createBufferSource();
		src.buffer = buf;
		const filt = c.createBiquadFilter();
		filt.type = 'highpass';
		filt.frequency.value = hp;
		const g = c.createGain();
		g.gain.value = gain;
		src.connect(filt).connect(g).connect(dest);
		src.start(at);
		src.stop(at + dur);
	}
	// 1拍分のBGMを予約。レイヤーは「その拍を予約する瞬間の musicLevel/feverOn」を読むので、切替は拍に同期する。
	function scheduleBgmBeat(beat: number, time: number): void {
		const c = ctx;
		if (!c || !bgmGain) return;
		const dest = bgmGain;
		const b = ((beat % 4) + 4) % 4; // 小節内の拍 0..3
		// Layer1 Drum：キック(0,2)＋スネア風(1,3)
		if (b === 0 || b === 2) bgmTone(c, dest, 52, time, 0.16, 'sine', 0.5, 30);
		if (b === 1 || b === 3) bgmNoise(c, dest, time, 0.08, 1800, 0.09);
		// Layer2 Bass（level>=1）：D2/D2/A1
		if (musicLevel >= 1) {
			const bass = b === 0 ? 73.42 : b === 2 ? 73.42 : b === 3 ? 55 : 0;
			if (bass) bgmTone(c, dest, bass, time, 0.22, 'triangle', 0.16);
		}
		// Layer3 Percussion（level>=2）：8分でハイハット
		if (musicLevel >= 2) {
			bgmNoise(c, dest, time, 0.03, 7000, 0.05);
			bgmNoise(c, dest, time + SPB / 2, 0.03, 7000, 0.035);
		}
		// Layer4 Melody（level>=3）：D5 - E5 G5 の簡単なモチーフ
		if (musicLevel >= 3) {
			const mel = [587.33, 0, 659.25, 783.99][b];
			if (mel) bgmTone(c, dest, mel, time, 0.18, 'triangle', 0.1);
		}
		// Layer5 FEVER：高音リード＋オープンハット
		if (feverOn) {
			const lead = [1174.66, 1174.66, 1567.98, 1174.66][b];
			bgmTone(c, dest, lead, time, 0.14, 'sawtooth', 0.075);
			bgmNoise(c, dest, time + SPB / 2, 0.05, 6000, 0.045);
		}
	}
	function bgmScheduler(): void {
		const c = ensureCtx();
		if (!c) return;
		// currentTime + 0.12 秒先まで予約（fps に依存しない）
		while (nextBeatTime < c.currentTime + 0.12) {
			scheduleBgmBeat(bgmBeat, nextBeatTime);
			nextBeatTime += SPB;
			bgmBeat++;
		}
	}

	return {
		stopClick() {
			// 短く控えめなクリック（主張しすぎない）
			tone(1200, 0, 0.04, 'triangle', 0.12);
		},
		judgment(kind: HitKind) {
			// 判定フィードバックのみ（曲の層は持続BGM側が担当）。
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
		startMusic() {
			const c = ensureCtx();
			if (!c) return;
			const gain = ensureBgmGain(c);
			gain.gain.cancelScheduledValues(c.currentTime);
			gain.gain.setValueAtTime(muted ? 0 : 0.9, c.currentTime);
			musicLevel = 0;
			feverOn = false;
			bgmBeat = 0;
			nextBeatTime = c.currentTime + 0.1; // gameTime≈0 の直後に拍頭を置く（エンジンの拍と揃う）
			if (musicTimer) clearInterval(musicTimer);
			musicTimer = setInterval(bgmScheduler, 25);
		},
		stopMusic() {
			if (musicTimer) {
				clearInterval(musicTimer);
				musicTimer = null;
			}
			if (ctx && bgmGain) {
				const t = ctx.currentTime;
				bgmGain.gain.cancelScheduledValues(t);
				bgmGain.gain.setValueAtTime(Math.max(0.0001, bgmGain.gain.value), t);
				bgmGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3); // 短くフェードアウト
			}
		},
		setMusicLevel(level: number) {
			// 予約は拍ごとに level を読むので、ここは値をセットするだけで切替が次の拍に自然に反映される。
			musicLevel = Math.max(0, Math.min(3, level | 0));
		},
		setFever(active: boolean) {
			feverOn = active;
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
			// 再生中のBGMも即座に反映
			if (bgmGain && ctx) {
				bgmGain.gain.cancelScheduledValues(ctx.currentTime);
				bgmGain.gain.setValueAtTime(muted ? 0 : 0.9, ctx.currentTime);
			}
			return muted;
		},
		isMuted() {
			return muted;
		},
	};
}
