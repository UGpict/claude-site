// 効果音（Web Audio API のみ・外部音源ファイル不要）。
// ゲームエンジン（chaos-pendulum.ts）はこのモジュールに依存しない。
// AudioContext はブラウザの Autoplay 制限に配慮し、最初のユーザー操作後に開始する。
// ミュート状態は localStorage に保持する。
//
// 共通トランスポート：startTransport() が「拍0の時刻 startTime」を1つだけ決め、
// BGM の拍頭・cue（タン/ドン）・エンジンの gameTime（now()）を全部 startTime + beatTime(beatIndex) で揃える。

import { BPM, SPB } from './beat-grid';
import type { CueSound, HitKind } from './chaos-pendulum';

const MUTE_KEY = 'cp:muted';

/** 共通トランスポート。startTime（拍0）を原点に、拍 n は startTime + n×secondsPerBeat。 */
export interface AudioTransport {
	/** 拍0（＝gameTime 0）の時刻。clock='audio' なら AudioContext.currentTime 基準、'performance' なら performance.now()/1000 基準 */
	startTime: number;
	bpm: number;
	secondsPerBeat: number;
	/** 時計の実体。AudioContext が動かない環境では performance 時計で進行だけ保証する（無音） */
	clock: 'audio' | 'performance';
}

/** cue の予約単位。time は transport 時刻（秒・拍0=0）＝ beatTime(beatIndex) */
export interface ScheduledCue {
	time: number;
	sound: CueSound;
}

export interface GameAudio {
	/** 叩いた瞬間のごく短いクリック音 */
	stopClick(): void;
	/** 判定音（PERFECT/GREAT/GOOD/near/miss のフィードバックのみ。BGMレイヤーは別担当） */
	judgment(kind: HitKind): void;
	/** リズム予告（タン・タン・ドン）を transport 時刻で先読み予約（startTime + time。fps非依存）。accent 前後は BGM をダッキング */
	scheduleRhythm(cues: ScheduledCue[]): void;
	/** CHAOS FEVER 突入の上昇音 */
	fever(): void;
	/** 自己ベスト更新の特別な音 */
	best(): void;
	/** ランキング上位入りの祝福音 */
	rankUp(): void;
	// --- 共通トランスポート＆持続BGM ---
	/**
	 * ユーザー操作の中で呼ぶ。① AudioContext.resume() を待つ → ② 拍0の時刻を決める
	 * （startTime = now + START_DELAY + leadBeats×SPB）→ ③ BGMスケジューラを拍0から開始＋カウントインを予約。
	 * 解決後にエンジンを開始すること（初回も retry も同じ経路）。
	 */
	startTransport(leadBeats: number): Promise<AudioTransport>;
	/** 現在の transport（未開始なら null） */
	getTransport(): AudioTransport | null;
	/** 現在の transport 時刻（秒。拍0で 0、カウントイン中は負）。エンジンの時計に渡す。 */
	now(): number;
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
	const perfNow = () => performance.now() / 1000;

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

	/** 単音。start は ctx.currentTime からの相対秒（即時の SE 用）。 */
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
		toneAt(c, freq, c.currentTime + start, dur, type, gain, freqTo);
	}
	/** 単音を AudioContext の絶対時刻 t0 に予約。freq→freqTo へスイープ可。track=true で取消対象に追跡。 */
	function toneAt(
		c: AudioContext,
		freq: number,
		t0: number,
		dur: number,
		type: OscillatorType,
		gain: number,
		freqTo?: number,
		track = false,
	): void {
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

	// --- 共通トランスポート＆持続BGM（拍同期ループ・先読みスケジューラ） ---
	// transport.startTime = 拍0（＝ゲームの gameTime=0）の時刻。BGM・cue・エンジンの時計を全部これに揃える。
	const START_DELAY = 0.3; // resume 直後の頭切れを避ける余白（秒）。カウントインの前に置く
	const BGM_LEVEL = 0.5; // BGM のマスター音量。cue（ドン）より明確に小さく
	const DUCK = 0.55; // accent 前後の BGM 倍率（約 -5dB）
	let transport: AudioTransport | null = null;
	let bgmGain: GainNode | null = null;
	let duckFrom = 0; // 予約済みダッキングが始まる audio 時刻（まだ始まっていなければ取り消せる）
	let musicTimer: ReturnType<typeof setInterval> | null = null;
	let bgmBeat = 0; // 通し拍カウンタ（拍0＝transport.startTime）
	let nextBeatTime = 0; // 次に予約する拍の audio 時刻
	let musicLevel = 0; // 0=drum / 1=+bass / 2=+perc / 3=+melody
	let feverOn = false;

	const musicVol = () => (muted ? 0 : BGM_LEVEL);
	function ensureBgmGain(c: AudioContext): GainNode {
		if (!bgmGain) {
			bgmGain = c.createGain();
			bgmGain.gain.value = musicVol();
			bgmGain.connect(c.destination);
		}
		return bgmGain;
	}
	/** 共通時計：拍番号 → AudioContext の絶対時刻 */
	const audioTimeOf = (transportTime: number) => (transport ? transport.startTime + transportTime : 0);

	/** accent（ドン）の -80ms〜+120ms だけ BGM を下げる（cue を最優先で聞かせる） */
	function duckAt(c: AudioContext, at: number): void {
		if (!bgmGain || muted) return;
		const g = bgmGain.gain;
		const t0 = Math.max(c.currentTime, at - 0.08);
		g.setValueAtTime(BGM_LEVEL, t0);
		g.linearRampToValueAtTime(BGM_LEVEL * DUCK, Math.max(t0 + 0.01, at - 0.03));
		g.setValueAtTime(BGM_LEVEL * DUCK, at + 0.12);
		g.linearRampToValueAtTime(BGM_LEVEL, at + 0.2);
		duckFrom = t0;
	}
	/** まだ始まっていないダッキングを取り消す（早押しで消えた的のドン用。進行中のものは自然に戻す） */
	function clearPendingDuck(c: AudioContext): void {
		if (!bgmGain || duckFrom <= c.currentTime) return;
		bgmGain.gain.cancelScheduledValues(c.currentTime);
		bgmGain.gain.setValueAtTime(musicVol(), c.currentTime);
		duckFrom = 0;
	}
	/** ドン（ここで押す合図）。低く太い音。BGM より明確に大きく、前後をダッキング。 */
	function accentAt(c: AudioContext, at: number): void {
		toneAt(c, 180, at, 0.14, 'sine', 0.3, 120, true);
		toneAt(c, 90, at, 0.16, 'triangle', 0.16, undefined, true);
		duckAt(c, at);
	}
	/** タン（予告クリック） */
	function tickAt(c: AudioContext, at: number): void {
		toneAt(c, 720, at, 0.05, 'square', 0.1, undefined, true);
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
		const c = ctx;
		if (!c || !transport || transport.clock !== 'audio') return;
		// currentTime + 0.12 秒先まで予約（fps に依存しない）
		// 拍 n の時刻は常に startTime + n×SPB（加算の誤差を溜めない＝cue/エンジンと同じ式）
		while (nextBeatTime < c.currentTime + 0.12) {
			scheduleBgmBeat(bgmBeat, nextBeatTime);
			bgmBeat++;
			nextBeatTime = audioTimeOf(bgmBeat * SPB);
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
			// cue.time は transport 時刻（=beatTime(beatIndex)）。BGM の拍と同じ startTime + time に予約する。
			const c = ctx;
			if (!c || muted || !transport || transport.clock !== 'audio') return;
			clearPendingCues(c); // 前パターンの未再生の予告（早押しで消えた的のドン等）を取り消す
			clearPendingDuck(c);
			for (const cue of cues) {
				const at = audioTimeOf(cue.time);
				if (at < c.currentTime - 0.005) continue; // 既に過ぎた cue は鳴らさない
				if (cue.sound === 'accent') accentAt(c, at);
				else tickAt(c, at);
			}
		},
		fever() {
			// 上昇するリザー（フィーバー突入）
			tone(330, 0, 0.28, 'sawtooth', 0.16, 990);
			tone(660, 0.06, 0.24, 'triangle', 0.14, 1320);
		},
		async startTransport(leadBeats: number) {
			// ユーザー操作の同期部分で ctx を作り resume を要求する（iOS Safari はジェスチャー内が必須）
			const c = ensureCtx();
			if (musicTimer) {
				clearInterval(musicTimer);
				musicTimer = null;
			}
			// ① resume を待つ（最大0.5秒）。動かない環境は performance 時計で無音進行
			let running = false;
			if (c) {
				if (c.state !== 'running') {
					try {
						await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 500))]);
					} catch {
						/* resume 失敗は無音扱い */
					}
				}
				running = c.state === 'running';
			}
			const lead = Math.max(0, Math.round(leadBeats));
			const base = running && c ? c.currentTime : perfNow();
			// ② 拍0（gameTime=0）の時刻をここで1回だけ決める。全時計の原点。
			transport = {
				startTime: base + START_DELAY + lead * SPB,
				bpm: BPM,
				secondsPerBeat: SPB,
				clock: running ? 'audio' : 'performance',
			};
			musicLevel = 0;
			feverOn = false;
			bgmBeat = 0;
			if (!running || !c) return transport;

			// ③ 前ゲームの残響（予約済みの拍・cue）を切り、新しい BGM バスで拍0から開始
			clearPendingCues(c);
			if (bgmGain) {
				const old = bgmGain;
				old.gain.cancelScheduledValues(c.currentTime);
				old.gain.setValueAtTime(old.gain.value, c.currentTime);
				old.gain.linearRampToValueAtTime(0, c.currentTime + 0.05);
				setTimeout(() => old.disconnect(), 400);
				bgmGain = null;
			}
			duckFrom = 0;
			ensureBgmGain(c);
			nextBeatTime = audioTimeOf(0); // BGM の拍0＝startTime
			// カウントイン：拍 -lead … -1 に「タン」、拍0 に「ドン（GO）」。同じ beatIndex 式で置く
			if (!muted) {
				for (let i = lead; i >= 1; i--) tickAt(c, audioTimeOf(-i * SPB));
				accentAt(c, audioTimeOf(0));
			}
			musicTimer = setInterval(bgmScheduler, 25);
			bgmScheduler();
			return transport;
		},
		getTransport() {
			return transport;
		},
		now() {
			if (!transport) return 0;
			if (transport.clock === 'audio' && ctx) return ctx.currentTime - transport.startTime;
			return perfNow() - transport.startTime;
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
				bgmGain.gain.setValueAtTime(musicVol(), ctx.currentTime);
				duckFrom = 0;
			}
			return muted;
		},
		isMuted() {
			return muted;
		},
	};
}
