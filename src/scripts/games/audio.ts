// 効果音（Web Audio API のみ・外部音源ファイル不要）。
// ゲームエンジン（chaos-pendulum.ts）はこのモジュールに依存しない。
// AudioContext はブラウザの Autoplay 制限に配慮し、最初のユーザー操作後に開始する。
// ミュート状態は localStorage に保持する。
//
// 共通トランスポート：startTransport() が「拍0の時刻 startTime」を1つだけ決め、
// BGM の拍頭・cue（タン/ドン）・エンジンの gameTime（now()）を全部 startTime + grid.beatTime(beatIndex) で揃える。

import { DEFAULT_GRID, type BeatGrid } from './beat-grid';
import type { HitKind } from './chaos-pendulum';
import { DEFAULT_SONG, gridOf, sectionIndexAt, sectionStart, type CueSound, type SongDefinition } from './song';

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

/** cue の予約単位。time は transport 時刻（秒・拍0=0）＝ grid.beatTime(beatIndex) */
export interface ScheduledCue {
	time: number;
	sound: CueSound;
}

export interface GameAudio {
	/** 叩いた瞬間のごく短いクリック音 */
	stopClick(): void;
	/**
	 * 判定音。GOOD 以上はコンボ数に応じて「今の小節の和音の構成音」を 根音→3度→5度→オクターブ→＋きらめき と上っていく
	 * （伴奏と濁らない）。コンボ（3以上）が切れた NEAR/MISS は「プツッ」＋BGM が一瞬抜ける。combo は判定後の値。
	 */
	judgment(kind: HitKind, combo?: number): void;
	/** リズム予告（タン・タン・ドン）を transport 時刻で先読み予約（startTime + time。fps非依存）。accent 前後は BGM をダッキング */
	scheduleRhythm(cues: ScheduledCue[], chaos?: { hitTime: number; tell: number }): void;
	/** CHAOS チャンスの予兆音を止める（叩いた瞬間に呼ぶ。鳴り途中のものも止める） */
	stopChaosTell(): void;
	/** ⚡ CHAOS PERFECT の炸裂音 */
	chaosPerfect(): void;
	/** CHAOS FEVER 突入の上昇音 */
	fever(): void;
	/** CHAOS FEVER 解除の短い「シュン…」（罰音ではなく、落差を作るための控えめな下降音） */
	feverEnd(): void;
	/** 結果発表：スコア高速加算の刻み（progress 0→1 で少しずつ音程が上がる） */
	resultTick(progress: number): void;
	/** 結果発表：項目が1つ出るたびの軽いポップ（index で少しずつ上がる） */
	resultPop(index: number): void;
	/** 結果発表：ランクのハンコ（S が一番派手） */
	rankStamp(rank: 'S' | 'A' | 'B' | 'C'): void;
	/** 自己ベスト更新の特別な音 */
	best(): void;
	/** ランキング上位入りの祝福音 */
	rankUp(): void;
	// --- 共通トランスポート＆持続BGM ---
	/**
	 * ユーザー操作の中で呼ぶ。① AudioContext.resume() を待つ → ② 拍0の時刻を決める
	 * （startTime = now + START_DELAY + leadBeats×grid.spb）→ ③ BGMスケジューラを拍0から開始＋カウントインを予約。
	 * 解決後にエンジンを開始すること（初回も retry も同じ経路）。
	 */
	startTransport(leadBeats: number, song?: SongDefinition): Promise<AudioTransport>;
	/** 現在の transport（未開始なら null） */
	getTransport(): AudioTransport | null;
	/**
	 * 外部音源の曲なら、音源ファイルの取得だけ先に始める（ユーザー操作の前でよい。デコードは初回スタート時）。
	 * 取得・デコードは src ごとにキャッシュし、再戦で取り直さない。
	 */
	preloadSong(song: SongDefinition): void;
	/** 今のゲームの音楽の出どころ：external=外部音源 / synth=合成BGM / silent=音なし（AudioContext が使えない） */
	audioMode(): 'external' | 'synth' | 'silent';
	/** ?debug=1 用の表示行（外部音源の再生位置など） */
	debugLines(): string[];
	/** 現在の transport 時刻（秒。拍0で 0、カウントイン中は負）。エンジンの時計に渡す。 */
	now(): number;
	/** BGM停止（ゲーム終了時。短くフェードアウト） */
	stopMusic(): void;
	/**
	 * コンボで解放される層（0=なし / 1=+bass / 2=+hihat / 3=+melody）。切替は次の拍に自然に反映。
	 * セクションの基本アレンジ（曲の進行）は transport と曲データから audio が拍ごとに決めるので別指示は不要。
	 */
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
		if (ctx.state === 'suspended') ctx.resume().catch(() => {}); // 失敗は startTransport 側で performance 時計へ
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
	/**
	 * 単音を AudioContext の絶対時刻 t0 に予約。freq→freqTo へスイープ可。track=true で取消対象に追跡。
	 * dest：出口のバス（既定＝判定音・SE の sfxBus。cue は cueBus）。
	 */
	function toneAt(
		c: AudioContext,
		freq: number,
		t0: number,
		dur: number,
		type: OscillatorType,
		gain: number,
		freqTo?: number,
		track = false,
		dest?: AudioNode,
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
		osc.connect(g).connect(dest ?? sfxBusOf(c));
		osc.start(t0);
		osc.stop(t0 + dur + 0.02);
		if (track) pending.push({ osc, startAt: t0 });
	}

	// --- 出口のバス（優先順：cue ＞ 判定音・SE ＞ 曲）。曲は bgmGain（ダッキング）→ bgmOut（コンボ切れの瞬断）→ 出力 ---
	const CUE_LEVEL = 1; // タン・ドン・CHAOS 予兆（入力の合図＝最優先）
	const SFX_LEVEL = 0.85; // 判定音・FEVER・結果音
	let cueBus: GainNode | null = null;
	let sfxBus: GainNode | null = null;
	function cueBusOf(c: AudioContext): GainNode {
		if (!cueBus) {
			cueBus = c.createGain();
			cueBus.gain.value = CUE_LEVEL;
			cueBus.connect(c.destination);
		}
		return cueBus;
	}
	function sfxBusOf(c: AudioContext): GainNode {
		if (!sfxBus) {
			sfxBus = c.createGain();
			sfxBus.gain.value = SFX_LEVEL;
			sfxBus.connect(c.destination);
		}
		return sfxBus;
	}

	// --- 外部音源（AudioBufferSourceNode で transport に同期再生） ---
	// 取得（fetch→ArrayBuffer）はページ表示時に先行、デコードは初回スタート時（AudioContext が要る）。どちらも src ごとにキャッシュ。
	const bytesCache = new Map<string, Promise<ArrayBuffer | null>>();
	const bufferCache = new Map<string, Promise<AudioBuffer | null>>();
	const DECODE_TIMEOUT_MS = 4000; // これ以上かかる初回ロードは待たず、その回は合成BGMで遊ぶ（次回は読み込み済み）
	function fetchBytes(src: string): Promise<ArrayBuffer | null> {
		let p = bytesCache.get(src);
		if (!p) {
			p = fetch(src)
				.then((r) => (r.ok ? r.arrayBuffer() : null))
				.catch(() => null);
			bytesCache.set(src, p);
		}
		return p;
	}
	function loadBuffer(c: AudioContext, src: string): Promise<AudioBuffer | null> {
		let p = bufferCache.get(src);
		if (!p) {
			p = fetchBytes(src).then(async (bytes) => {
				if (!bytes) return null;
				try {
					// decodeAudioData は ArrayBuffer を手放すのでコピーを渡す（キャッシュの bytes は残す）
					return await c.decodeAudioData(bytes.slice(0));
				} catch {
					return null;
				}
			});
			bufferCache.set(src, p);
			p.then((b) => {
				if (!b) bufferCache.delete(src); // 失敗は次回やり直せるように
			});
		}
		return p;
	}
	let extSource: AudioBufferSourceNode | null = null;
	let extActive = false; // 今のゲームが外部音源モードか
	/** 外部音源を止める（再戦・時計停止・音なしへの切替時）。AudioBufferSourceNode は使い捨てなので次は作り直す */
	function stopExternal(c: AudioContext | null, fade = 0.05): void {
		if (!extSource) return;
		const src = extSource;
		extSource = null;
		try {
			if (c) src.stop(c.currentTime + fade);
		} catch {
			/* 停止済み */
		}
	}

	// --- 共通トランスポート＆持続BGM（拍同期ループ・先読みスケジューラ） ---
	// transport.startTime = 拍0（＝ゲームの gameTime=0）の時刻。BGM・cue・エンジンの時計を全部これに揃える。
	const START_DELAY = 0.3; // resume 直後の頭切れを避ける余白（秒）。カウントインの前に置く
	const BGM_LEVEL = 0.5; // 合成BGM のマスター音量。cue（ドン）より明確に小さく
	const DUCK = 0.55; // accent 前後の合成BGM 倍率（約 -5dB）
	const DUCK_EXTERNAL = 0.42; // 外部音源は音が厚いので深めに（約 -7.5dB）
	let grid: BeatGrid = DEFAULT_GRID; // 今の曲の拍グリッド（BPM は曲ごと）
	const barSec = () => 4 * grid.spb; // 1小節（4拍）の秒数
	let transport: AudioTransport | null = null;
	// --- 音の時計が本当に進んでいるかの監視（スマホ対策） ---
	// iOS Safari などでは、AudioContext が 'interrupted' になったり、state が 'running' のまま currentTime が
	// 止まったりすることがある。止まった時計を拍の原点にするとカウントインが永遠に終わらない（再戦できない）。
	// → 開始時に「進んでいること」を確かめ、プレイ中も止まったら performance 時計へ継ぎ目なく切り替える。
	const RESUME_TIMEOUT_MS = 400; // resume() がこれ以上返らなければ待たない
	const ADVANCE_CHECK_MS = 250; // currentTime が進むのを確かめる最大時間
	const CLOCK_STALL_SEC = 0.3; // プレイ中、これ以上 currentTime が進まなければ止まったとみなす
	let lastAudioT = -1;
	let lastAudioAdvanceAt = 0; // perfNow() 基準
	let lastTransportT = 0;
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	/** currentTime が実際に進むか（'running' 以外＝interrupted/suspended/closed は不可） */
	async function clockAdvances(c: AudioContext): Promise<boolean> {
		if (c.state !== 'running') return false;
		const t0 = c.currentTime;
		const deadline = perfNow() + ADVANCE_CHECK_MS / 1000;
		while (perfNow() < deadline) {
			await sleep(15);
			if (c.state !== 'running') return false;
			if (c.currentTime !== t0) return true;
		}
		return false;
	}
	/** プレイ中の監視：進んでいれば true。state が running 以外、または CLOCK_STALL_SEC 以上止まっていれば false */
	function audioClockAlive(c: AudioContext): boolean {
		if (c.state !== 'running') return false;
		const t = c.currentTime;
		const pn = perfNow();
		if (t !== lastAudioT) {
			lastAudioT = t;
			lastAudioAdvanceAt = pn;
			return true;
		}
		return pn - lastAudioAdvanceAt < CLOCK_STALL_SEC;
	}
	/** 音の時計が止まった：transport を performance 時計へ切り替える（いまの transport 時刻から継ぎ目なく続ける）。以後は無音 */
	function fallbackToPerformance(): void {
		if (!transport || transport.clock !== 'audio') return;
		transport = { ...transport, startTime: perfNow() - lastTransportT, clock: 'performance' };
		stopExternal(ctx); // 時計が止まった音源はずれるので止める（その回は無音で続行）
		extActive = false;
		if (musicTimer) {
			clearInterval(musicTimer);
			musicTimer = null;
		}
		if (ctx) clearPendingCues(ctx);
	}
	let bgmGain: GainNode | null = null;
	let duckFrom = 0; // 予約済みダッキングが始まる audio 時刻（まだ始まっていなければ取り消せる）
	let musicTimer: ReturnType<typeof setInterval> | null = null;
	let bgmBeat = 0; // 通し拍カウンタ（拍0＝transport.startTime）
	let nextBeatTime = 0; // 次に予約する拍の audio 時刻
	let musicLevel = 0; // コンボ層 0=なし / 1=+bass / 2=+hihat / 3=+melody
	let song: SongDefinition = DEFAULT_SONG; // 今の transport で鳴らす曲（セクション構成・尺）
	let feverOn = false;
	let feverCrashPending = false; // FEVER 突入後、次に予約する拍頭にクラッシュ＋インパクト（拍に同期した「解放」）

	/** 曲の基準音量（外部音源なら曲ごとの volume、合成BGMなら BGM_LEVEL） */
	const musicBase = () => (extActive && song.audio ? song.audio.volume : BGM_LEVEL);
	const musicVol = () => (muted ? 0 : musicBase());
	// BGM の出口（ずっと1つ）。コンボ切れの「プツッ」で一瞬だけ抜くための専用ノード。
	// cue のダッキング（bgmGain 側の自動化）とは別ノードなので互いの予約を壊さない。
	let bgmOut: GainNode | null = null;
	function ensureBgmOut(c: AudioContext): GainNode {
		if (!bgmOut) {
			bgmOut = c.createGain();
			bgmOut.gain.value = 1;
			bgmOut.connect(c.destination);
		}
		return bgmOut;
	}
	function ensureBgmGain(c: AudioContext): GainNode {
		if (!bgmGain) {
			bgmGain = c.createGain();
			bgmGain.gain.value = musicVol();
			bgmGain.connect(ensureBgmOut(c));
		}
		return bgmGain;
	}
	/** 共通時計：拍番号 → AudioContext の絶対時刻 */
	const audioTimeOf = (transportTime: number) => (transport ? transport.startTime + transportTime : 0);

	/** accent（ドン）の -80ms〜+120ms だけ BGM を下げる（cue を最優先で聞かせる） */
	function duckAt(c: AudioContext, at: number): void {
		if (!bgmGain || muted) return;
		const g = bgmGain.gain;
		const base = musicBase();
		const duck = extActive ? DUCK_EXTERNAL : DUCK;
		const t0 = Math.max(c.currentTime, at - 0.08);
		g.setValueAtTime(base, t0);
		g.linearRampToValueAtTime(base * duck, Math.max(t0 + 0.01, at - 0.03));
		g.setValueAtTime(base * duck, at + 0.12);
		g.linearRampToValueAtTime(base, at + 0.2);
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
		toneAt(c, 180, at, 0.14, 'sine', 0.3, 120, true, cueBusOf(c));
		toneAt(c, 90, at, 0.16, 'triangle', 0.16, undefined, true, cueBusOf(c));
		duckAt(c, at);
	}
	// CHAOS 予兆音：加速する高いチッ・チッ＋かすかに上昇するサイン。ドン（180Hz）とは帯域が離れていて埋もれさせない。
	let tellOscs: OscillatorNode[] = [];
	function toneTell(c: AudioContext, freq: number, at: number, dur: number, type: OscillatorType, gain: number, freqTo?: number): void {
		const osc = c.createOscillator();
		const g = c.createGain();
		osc.type = type;
		osc.frequency.setValueAtTime(freq, at);
		if (freqTo != null) osc.frequency.exponentialRampToValueAtTime(freqTo, at + dur);
		g.gain.setValueAtTime(0.0001, at);
		g.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.01, dur / 3));
		g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
		osc.connect(g).connect(cueBusOf(c));
		osc.start(at);
		osc.stop(at + dur + 0.02);
		tellOscs.push(osc);
	}
	function scheduleChaosTell(c: AudioContext, hitAudio: number, tell: number): void {
		const from = Math.max(c.currentTime, hitAudio - tell);
		if (hitAudio - from < 0.05) return;
		toneTell(c, 1800, from, hitAudio - from - 0.01, 'sine', 0.018, 3600); // 上昇するかすかな唸り
		for (const k of [1, 0.69, 0.46, 0.29, 0.17, 0.09]) {
			const at = hitAudio - tell * k;
			if (at >= c.currentTime) toneTell(c, 3136, at, 0.025, 'sine', 0.03 + 0.03 * (1 - k)); // 加速する「チッ」
		}
	}
	/** タン（予告クリック） */
	function tickAt(c: AudioContext, at: number): void {
		toneAt(c, 720, at, 0.05, 'square', 0.1, undefined, true, cueBusOf(c));
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
	// 1拍分のBGMを予約。2層構造：
	//   ① セクションの基本アレンジ（曲の進行。拍の transport 時刻 → 曲データの section から決まる。コンボ無関係）
	//   ② コンボ層（musicLevel/feverOn。その拍を予約する瞬間の値を読むので切替は拍に同期）
	// CLIMAX でも combo 0 なら melody は鳴らさない（②は①に左右されない）。
	// 伴奏の進行（Dm → B♭ → C → A）。pad と、pad のあるセクションの bass ルートに使う
	const CHORDS = [
		[293.66, 349.23, 440.0],
		[233.08, 293.66, 349.23],
		[261.63, 329.63, 392.0],
		[220.0, 277.18, 329.63],
	];
	const MOTIFS: Record<'main' | 'variation' | 'finale', number[][]> = {
		main: [[587.33, 0, 659.25, 783.99]], // D5 - E5 G5
		variation: [
			[587.33, 0, 659.25, 783.99],
			[880.0, 783.99, 659.25, 587.33], // 下降の応答
		],
		finale: [[587.33, 739.99, 880.0, 1174.66]], // D F# A D：長調へ持ち上げて締める
	};
	// 判定音の音階：今の小節の和音（伴奏パッドのあるセクション＝CLIMAX/FINAL は進行に追従、それ以外は Dm）
	let lastCombo = 0;
	function chordNow(): number[] {
		if (!transport) return CHORDS[0];
		const t = Math.max(0, api.now());
		// 曲に和音の指定（harmony）があればそれを小節ごとに循環（外部音源の曲はキーに合わせる）
		if (song.harmony?.length) {
			const hb = Math.floor(t / barSec());
			return song.harmony[((hb % song.harmony.length) + song.harmony.length) % song.harmony.length];
		}
		const secIdx = sectionIndexAt(song, t);
		if (!song.sections[secIdx].arrangement.pad) return CHORDS[0];
		const bar = Math.floor(t / barSec());
		return CHORDS[((bar % 4) + 4) % 4];
	}
	/** コンボ切れ：短いクリック＋下降ブリップ（テープが止まる感じ）＋BGM が一瞬抜けて戻る。罰音ではなく「切れた」合図 */
	function comboBreak(): void {
		const c = ensureCtx();
		if (!c || muted) return;
		const now = c.currentTime;
		const g = c.createGain();
		g.gain.value = 1;
		g.connect(sfxBusOf(c));
		bgmNoise(c, g, now, 0.012, 2500, 0.12); // プツッ
		toneAt(c, 520, now + 0.005, 0.09, 'square', 0.06, 90);
		setTimeout(() => g.disconnect(), 300);
		const out = ensureBgmOut(c);
		out.gain.cancelScheduledValues(now);
		out.gain.setValueAtTime(out.gain.value, now);
		out.gain.linearRampToValueAtTime(0.15, now + 0.015);
		out.gain.setValueAtTime(0.15, now + 0.12);
		out.gain.linearRampToValueAtTime(1, now + 0.45);
	}
	/**
	 * 外部音源を拍0（transport.startTime）ちょうどに、ファイル位置 startAt + offset から鳴らす。
	 * ＝ファイル上の拍頭がそのまま transport の拍0。以降の拍 n はファイル位置 startAt + offset + n×spb（曲の BPM が正しい前提）。
	 * 曲は srcGain（頭の 8ms フェードイン・終わりのフェードアウト）→ bgmGain（cue 前後のダッキング・ミュート）→ bgmOut（コンボ切れの瞬断）。
	 * 終わり：duration で終止、tail 秒かけてフェードアウトして停止。
	 */
	function startExternal(c: AudioContext, buffer: AudioBuffer, songDef: SongDefinition): void {
		const a = songDef.audio!;
		const t0 = audioTimeOf(0);
		const src = c.createBufferSource();
		src.buffer = buffer;
		const g = c.createGain();
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.exponentialRampToValueAtTime(1, t0 + 0.008);
		const end = audioTimeOf(songDef.duration);
		const tail = Math.max(0.05, a.tail ?? 1.5);
		g.gain.setValueAtTime(1, end);
		g.gain.linearRampToValueAtTime(0.0001, end + tail);
		src.connect(g).connect(ensureBgmGain(c));
		src.start(t0, Math.max(0, a.startAt + a.offset));
		src.stop(end + tail + 0.05);
		src.onended = () => g.disconnect();
		extSource = src;
	}
	/**
	 * 外部音源モードの拍ごとの追加音。原曲とキーがぶつからないよう音程のない音だけ・ごく控えめ：
	 * コンボ5+ ハイハット8分 / 10+ シェイカー16分を少し / FEVER オープンハット＋突入のクラッシュ。
	 */
	function scheduleExternalBeat(c: AudioContext, dest: AudioNode, time: number): void {
		if (musicLevel >= 2) {
			bgmNoise(c, dest, time, 0.025, 8000, 0.03);
			bgmNoise(c, dest, time + grid.spb / 2, 0.025, 8000, 0.022);
		}
		if (musicLevel >= 3) {
			bgmNoise(c, dest, time + grid.spb / 4, 0.018, 10000, 0.012);
			bgmNoise(c, dest, time + (grid.spb * 3) / 4, 0.018, 10000, 0.012);
		}
		if (feverOn) {
			if (feverCrashPending) {
				feverCrashPending = false;
				bgmNoise(c, dest, time, 1.0, 3500, 0.07);
			}
			bgmNoise(c, dest, time + grid.spb / 2, 0.05, 6000, 0.035);
		}
	}
	function scheduleBgmBeat(beat: number, time: number): void {
		const c = ctx;
		if (!c || !bgmGain) return;
		const dest = bgmGain;
		if (extActive) {
			scheduleExternalBeat(c, dest, time);
			return;
		}
		const tt = grid.beatTime(beat); // この拍の transport 時刻（cue/hitAt と同じ式）
		const secIdx = sectionIndexAt(song, tt);
		const arr = song.sections[secIdx].arrangement;
		const b = ((beat % 4) + 4) % 4; // 小節内の拍 0..3
		const bar = Math.floor(beat / 4);
		const chord = CHORDS[((bar % 4) + 4) % 4];

		// --- ① セクションの基本アレンジ ---
		// セクション頭のクラッシュ（小節頭に丸めた境界＝section_change と同じ拍）
		if (arr.crash && secIdx > 0 && Math.abs(tt - sectionStart(song, secIdx)) < 1e-6) {
			bgmNoise(c, dest, time, 0.9, 4500, 0.08);
		}
		// ドラム
		const kick = arr.drums === 'four' ? true : b === 0 || b === 2;
		if (kick) bgmTone(c, dest, 52, time, 0.16, 'sine', 0.5, 30);
		if (arr.drums === 'sparse') {
			if (b === 3) bgmNoise(c, dest, time, 0.05, 3000, 0.05); // 音数少なめ：4拍目に軽いリムだけ
		} else if (b === 1 || b === 3) {
			bgmNoise(c, dest, time, 0.08, 1800, 0.09); // スネア
		}
		if (arr.drums === 'drive' || arr.drums === 'four') {
			bgmNoise(c, dest, time + grid.spb / 2, 0.025, 9000, 0.03); // 裏の8分シェイカー（密度UP）
		}
		// 次セクションへのフィル：最後の1小節を16分スネアでクレッシェンド
		if (arr.fill && secIdx < song.sections.length - 1) {
			const next = sectionStart(song, secIdx + 1);
			if (tt >= next - barSec() - 1e-6) {
				const prog = (tt - (next - barSec())) / barSec(); // 0→0.75
				for (let k = 0; k < 4; k++) bgmNoise(c, dest, time + (k * grid.spb) / 4, 0.05, 1500, 0.025 + 0.06 * (prog + k / 16));
			}
		}
		// 伴奏パッド（小節頭で和音をのばす）
		if (arr.pad && b === 0) {
			for (const f of chord) bgmTone(c, dest, f, time, barSec() * 0.95, 'triangle', 0.025);
		}
		// FINAL の締めモチーフ（基本アレンジとして小さく。コンボ melody とは別）
		if (arr.motif === 'finale') {
			const f = MOTIFS.finale[0][b];
			bgmTone(c, dest, f * 2, time, 0.2, 'sine', 0.035);
		}

		// --- ② コンボ層 ---
		// bass（level>=1）：pad のあるセクションは和音のルート、それ以外は D2/D2/A1
		if (musicLevel >= 1) {
			const root = chord[0] / 4;
			const bass = arr.pad
				? [root, 0, root, root * 1.5][b]
				: b === 0 || b === 2
					? 73.42
					: b === 3
						? 55
						: 0;
			if (bass) bgmTone(c, dest, bass, time, 0.22, 'triangle', 0.16);
		}
		// hihat（level>=2）：8分
		if (musicLevel >= 2) {
			bgmNoise(c, dest, time, 0.03, 7000, 0.05);
			bgmNoise(c, dest, time + grid.spb / 2, 0.03, 7000, 0.035);
		}
		// melody（level>=3）：セクションのモチーフ（main / variation / finale）と音量
		if (musicLevel >= 3) {
			const bars = MOTIFS[arr.motif];
			const mel = bars[((bar % bars.length) + bars.length) % bars.length][b];
			if (mel) bgmTone(c, dest, mel, time, 0.18, 'triangle', arr.melodyGain);
		}
		// FEVER：曲を明確に「解放」する。すべて BGM バス経由なので cue 前後のダッキングはそのまま効く。
		//   lead ＋ オープンハット ＋ 伴奏パッド（セクションに無くても）＋ オクターブ上のメロディ ＋ 突入後の次の拍頭にクラッシュ
		if (feverOn) {
			if (feverCrashPending) {
				feverCrashPending = false;
				bgmNoise(c, dest, time, 1.1, 3500, 0.1);
				bgmTone(c, dest, 48, time, 0.3, 'sine', 0.45, 28);
			}
			const lead = [1174.66, 1174.66, 1567.98, 1174.66][b];
			bgmTone(c, dest, lead, time, 0.14, 'sawtooth', 0.075);
			bgmTone(c, dest, lead * 1.5, time + grid.spb / 2, 0.1, 'triangle', 0.035); // 裏で5度上の合いの手
			bgmNoise(c, dest, time + grid.spb / 2, 0.05, 6000, 0.045);
			if (!arr.pad && b === 0) {
				for (const f of chord) bgmTone(c, dest, f, time, barSec() * 0.95, 'triangle', 0.022);
			}
			const bars = MOTIFS[arr.motif];
			const oct = bars[((bar % bars.length) + bars.length) % bars.length][b];
			if (oct) bgmTone(c, dest, oct * 2, time, 0.16, 'sine', 0.045);
		}
	}
	/** 曲の終止（最終拍＝transport 時刻 song.duration）。BGM バスを通さず鳴らす（game_over のフェードで切れない） */
	function scheduleFinish(time: number): void {
		const c = ctx;
		if (!c || muted) return;
		const g = c.createGain();
		g.gain.value = 0.9;
		g.connect(sfxBusOf(c));
		if (extActive) {
			// 外部音源：曲のキーとぶつからないよう音程のない終止（クラッシュ＋衝撃）。曲自体は tail の間にフェード
			bgmTone(c, g, 52, time, 0.35, 'sine', 0.45, 28);
			bgmNoise(c, g, time, feverOn ? 1.8 : 1.2, 4000, feverOn ? 0.1 : 0.08);
			setTimeout(() => g.disconnect(), (time - c.currentTime + 2) * 1000);
			return;
		}
		bgmTone(c, g, 52, time, 0.4, 'sine', 0.55, 28);
		bgmNoise(c, g, time, feverOn ? 2.2 : 1.4, 4000, feverOn ? 0.12 : 0.09);
		for (const f of [293.66, 369.99, 440.0, 587.33]) bgmTone(c, g, f, time, 1.6, 'triangle', 0.08); // D major
		bgmTone(c, g, 1174.66, time + 0.02, 1.2, 'sine', 0.05);
		if (feverOn) {
			// FEVER のまま終止：1オクターブ上の和音＋きらめきの駆け上がり＋長いクラッシュ（いちばん派手な終わり）
			for (const f of [587.33, 739.99, 880.0, 1174.66]) bgmTone(c, g, f, time, 2.0, 'triangle', 0.05);
			[1174.66, 1479.98, 1760.0, 2349.32, 2959.96].forEach((f, i) => bgmTone(c, g, f, time + 0.05 + i * 0.06, 0.5, 'sine', 0.045));
			bgmTone(c, g, 36.71, time, 0.9, 'sine', 0.4, 30); // 深いサブ
		}
		setTimeout(() => g.disconnect(), (time - c.currentTime + 2) * 1000);
	}
	function bgmScheduler(): void {
		const c = ctx;
		if (!c || !transport || transport.clock !== 'audio') return;
		// currentTime + 0.12 秒先まで予約（fps に依存しない）
		// 拍 n の時刻は常に startTime + n×grid.spb（加算の誤差を溜めない＝cue/エンジンと同じ式）
		while (nextBeatTime < c.currentTime + 0.12) {
			if (grid.beatTime(bgmBeat) >= song.duration - 1e-6) {
				// 曲の終わり（transport 時刻 song.duration。拍頭に揃えた尺なら最終拍）：ループではなく終止音を鳴らしてスケジューラを止める
				scheduleFinish(audioTimeOf(song.duration));
				if (musicTimer) clearInterval(musicTimer);
				musicTimer = null;
				return;
			}
			scheduleBgmBeat(bgmBeat, nextBeatTime);
			bgmBeat++;
			nextBeatTime = audioTimeOf(bgmBeat * grid.spb);
		}
	}

	const api: GameAudio = {
		stopClick() {
			// 短く控えめなクリック（主張しすぎない）
			tone(1200, 0, 0.04, 'triangle', 0.12);
		},
		judgment(kind: HitKind, combo = 0) {
			// 判定フィードバックのみ（曲の層は持続BGM側が担当）。
			const prev = lastCombo;
			lastCombo = combo;
			if (kind === 'perfect' || kind === 'great' || kind === 'good') {
				// 音が育つ：コンボ 1-2 根音 / 3-4 3度 / 5-6 5度 / 7-9 オクターブ / 10+ オクターブ＋きらめき
				const [root, third, fifth] = chordNow();
				const step = combo >= 10 ? 4 : combo >= 7 ? 3 : combo >= 5 ? 2 : combo >= 3 ? 1 : 0;
				const f = [root, third, fifth, root * 2, root * 2][step] * 2; // 5〜6 オクターブ帯（BGM より上で抜ける）
				if (kind === 'perfect') {
					tone(f, 0, 0.16, 'triangle', 0.22);
					tone(f * 2, 0.012, 0.12, 'sine', 0.07); // 倍音の艶
					if (step === 4) [root, third, fifth, root * 2].forEach((x, i) => tone(x * 4, 0.05 + i * 0.035, 0.1, 'sine', 0.06)); // きらめき
				} else if (kind === 'great') {
					tone(f, 0, 0.14, 'triangle', 0.17);
				} else {
					tone(f, 0, 0.1, 'triangle', 0.12); // GOOD：同じ音程で控えめ（コンボは繋がっている）
				}
				return;
			}
			if (prev >= 3) {
				comboBreak(); // 育てた音が「プツッ」と剥がれる
				return;
			}
			if (kind === 'near') tone(300, 0, 0.12, 'sawtooth', 0.12, 240); // 惜しい（軽く濁る）
			else tone(180, 0, 0.16, 'sawtooth', 0.14, 150); // 低く少し濁った失敗音（不快すぎない）
		},
		scheduleRhythm(cues, chaos) {
			// cue.time は transport 時刻（=grid.beatTime(beatIndex)）。BGM の拍と同じ startTime + time に予約する。
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
			if (chaos) scheduleChaosTell(c, audioTimeOf(chaos.hitTime), chaos.tell);
		},
		stopChaosTell() {
			const c = ctx;
			if (!c) return;
			for (const o of tellOscs) {
				try {
					o.stop(c.currentTime);
				} catch {
					/* 停止済み */
				}
			}
			tellOscs = [];
		},
		chaosPerfect() {
			// 振り子が最も荒れた瞬間を叩き抜いた：クラック＋ザップ（下降）＋低い衝撃＋和音のきらめき
			const c = ensureCtx();
			if (!c || muted) return;
			const now = c.currentTime;
			const g = c.createGain();
			g.gain.value = 1;
			g.connect(sfxBusOf(c));
			bgmNoise(c, g, now, 0.08, 4000, 0.14); // バチッ
			setTimeout(() => g.disconnect(), 600);
			toneAt(c, 2400, now, 0.14, 'sawtooth', 0.08, 180); // ザップ
			toneAt(c, 62, now, 0.28, 'sine', 0.3, 34); // ドスッ
			const [r, t3, f5] = chordNow();
			[r, t3, f5, r * 2, t3 * 2].forEach((x, i) => toneAt(c, x * 4, now + 0.04 + i * 0.03, 0.12, 'sine', 0.055));
		},
		fever() {
			// 突入SE＝3層：低音インパクト ＋ 上昇ライザー ＋ 高音スパークル（約0.5秒で収まる。次の cue を覆わない長さ）
			const c = ensureCtx();
			if (!c || muted) return;
			const now = c.currentTime;
			toneAt(c, 70, now, 0.35, 'sine', 0.32, 32); // インパクト
			const g = c.createGain(); // ノイズの一撃
			g.gain.value = 0.9;
			g.connect(sfxBusOf(c));
			bgmNoise(c, g, now, 0.18, 800, 0.12);
			setTimeout(() => g.disconnect(), 800);
			toneAt(c, 330, now + 0.02, 0.32, 'sawtooth', 0.12, 1320); // ライザー
			toneAt(c, 660, now + 0.06, 0.28, 'triangle', 0.12, 1760);
			[2093.0, 2637.02, 3135.96, 4186.01].forEach((f, i) => toneAt(c, f, now + 0.18 + i * 0.05, 0.14, 'sine', 0.07)); // スパークル
		},
		feverEnd() {
			// 「シュン…」：短い下降＋フィルタ感の弱いノイズ。罰ではなく「切れた」ことが分かるだけ
			tone(900, 0, 0.22, 'sine', 0.07, 220);
			tone(450, 0.01, 0.2, 'triangle', 0.04, 110);
		},
		async startTransport(leadBeats: number, songDef: SongDefinition = DEFAULT_SONG) {
			song = songDef;
			grid = gridOf(songDef);
			// ユーザー操作の同期部分で ctx を作り resume を要求する（iOS Safari はジェスチャー内が必須）
			const c = ensureCtx();
			if (musicTimer) {
				clearInterval(musicTimer);
				musicTimer = null;
			}
			// ① resume を待つ（最大 RESUME_TIMEOUT_MS）→ currentTime が実際に進むか確認（最大 ADVANCE_CHECK_MS）。
			//    どちらかダメなら performance 時計で無音進行。どの経路でも有限時間で必ず resolve する（ゲーム開始を止めない）。
			let running = false;
			if (c) {
				try {
					if (c.state !== 'running') {
						await Promise.race([c.resume().catch(() => {}), sleep(RESUME_TIMEOUT_MS)]);
					}
					running = await clockAdvances(c);
				} catch {
					running = false; // resume 失敗・closed などは無音扱い
				}
			}
			// ②' 外部音源：デコード（初回のみ。以後キャッシュ）を待ってから拍0を決める（拍0が必ず未来になる）。
			//     読めない・遅すぎる・音が使えないなら、その回は同じ拍グリッドの合成BGMで遊ぶ（ゲームは止めない）
			let buffer: AudioBuffer | null = null;
			stopExternal(c);
			if (running && c && songDef.audio) {
				buffer = await Promise.race([loadBuffer(c, songDef.audio.src), sleep(DECODE_TIMEOUT_MS).then(() => null)]);
			}
			extActive = !!buffer;
			const lead = Math.max(0, Math.round(leadBeats));
			const base = running && c ? c.currentTime : perfNow();
			// ② 拍0（gameTime=0）の時刻をここで1回だけ決める。全時計の原点。
			transport = {
				startTime: base + START_DELAY + lead * grid.spb,
				bpm: grid.bpm,
				secondsPerBeat: grid.spb,
				clock: running ? 'audio' : 'performance',
			};
			musicLevel = 0;
			feverOn = false;
			feverCrashPending = false;
			lastCombo = 0;
			bgmBeat = 0;
			lastTransportT = -(START_DELAY + lead * grid.spb);
			if (!running || !c) return transport;
			lastAudioT = c.currentTime;
			lastAudioAdvanceAt = perfNow();

			// ③ 前ゲームの残響（予約済みの拍・cue）を切り、新しい BGM バスで拍0から開始。
			//    ここで例外が出ても（壊れた AudioContext 等）ゲームは performance 時計で始められるようにする。
			try {
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
				if (buffer && songDef.audio) startExternal(c, buffer, songDef);
				// カウントイン：拍 -lead … -1 に「タン」、拍0 に「ドン（GO）」。同じ beatIndex 式で置く
				if (!muted) {
					for (let i = lead; i >= 1; i--) tickAt(c, audioTimeOf(-i * grid.spb));
					accentAt(c, audioTimeOf(0));
				}
				musicTimer = setInterval(bgmScheduler, 25);
				bgmScheduler();
			} catch {
				if (musicTimer) {
					clearInterval(musicTimer);
					musicTimer = null;
				}
				transport = { ...transport, startTime: perfNow() + START_DELAY + lead * grid.spb, clock: 'performance' };
				stopExternal(c);
				extActive = false;
			}
			return transport;
		},
		preloadSong(songDef: SongDefinition) {
			if (songDef.audio) void fetchBytes(songDef.audio.src);
		},
		audioMode() {
			if (!transport || transport.clock !== 'audio') return 'silent';
			return extActive ? 'external' : 'synth';
		},
		debugLines() {
			const lines = [`audio: ${api.audioMode()}${muted ? ' (muted)' : ''}  clock: ${transport?.clock ?? '-'}`];
			if (song.audio) {
				lines.push(`src: ${song.audio.src.split('/').pop()}`);
				lines.push(`startAt: ${song.audio.startAt}  offset: ${song.audio.offset}`);
				if (extActive && ctx && transport) {
					// 今鳴っている音源ファイル内の位置（拍0 = startAt + offset）
					lines.push(`file pos: ${(song.audio.startAt + song.audio.offset + ctx.currentTime - transport.startTime).toFixed(3)}`);
				}
			}
			return lines;
		},
		getTransport() {
			return transport;
		},
		now() {
			if (!transport) return 0;
			if (transport.clock === 'audio' && ctx) {
				if (audioClockAlive(ctx)) {
					lastTransportT = ctx.currentTime - transport.startTime;
					return lastTransportT;
				}
				fallbackToPerformance(); // 音の時計が止まった：ゲームは止めずに performance 時計で続ける
			}
			return perfNow() - transport.startTime;
		},
		stopMusic() {
			if (musicTimer) {
				clearInterval(musicTimer);
				musicTimer = null;
			}
			// 外部音源は終止時刻から tail 秒のフェードを予約済み（原曲の自然な終わりを優先）。ここでは切らない
			if (extActive) return;
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
			if (active && !feverOn) feverCrashPending = true;
			if (!active) feverCrashPending = false;
			feverOn = active;
		},
		resultTick(progress: number) {
			tone(1200 + 900 * progress, 0, 0.025, 'square', 0.025);
		},
		resultPop(index: number) {
			const f = [659.25, 739.99, 880, 987.77, 1174.66][Math.max(0, Math.min(4, index))];
			tone(f, 0, 0.09, 'triangle', 0.1);
			tone(f * 2, 0.02, 0.07, 'sine', 0.04);
		},
		rankStamp(rank) {
			// ハンコ：低い衝撃＋和音。S は駆け上がるきらめき付き、C は控えめ
			const c = ensureCtx();
			if (!c || muted) return;
			const strong = rank === 'S' ? 1 : rank === 'A' ? 0.8 : rank === 'B' ? 0.6 : 0.45;
			tone(70, 0, 0.3, 'sine', 0.32 * strong, 34);
			const g = c.createGain();
			g.gain.value = 1;
			g.connect(sfxBusOf(c));
			bgmNoise(c, g, c.currentTime, 0.06, 1500, 0.1 * strong);
			setTimeout(() => g.disconnect(), 400);
			const chord = rank === 'C' ? [293.66, 349.23, 440] : [293.66, 369.99, 440, 587.33]; // C は短調、それ以外は長調
			chord.forEach((f) => tone(f, 0.02, 0.6, 'triangle', 0.07 * strong));
			if (rank === 'S') [1174.66, 1479.98, 1760, 2349.32].forEach((f, i) => tone(f, 0.08 + i * 0.05, 0.14, 'sine', 0.06));
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
	return api;
}
