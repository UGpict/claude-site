// CHAOS BEAT — ゲームエンジン（旧「カオス振り子ストップ」を作り替え）
//
// 【重要】物理計算・RK4 数値積分（deriv/rk4/tips）は単一HTML版から変更しない。
// 変えるのはゲーム体験（1曲60秒のセクション進行・的の寿命・判定・コンボ・スロー・BPM脈動）だけ。
// 物理そのものを変える場合は明示的な指示が必要。
//
// spec: docs/specs/chaos-beat.md / design: docs/design/chaos-beat.md
// このファイルは Astro / GA4 / 広告 / 音 に依存しない純粋なエンジン。
// 外へは onEvent(name, payload) だけで通知する（送信先はこのファイルの外で決める）。
//
// 時計：gameTime は外から注入される共通トランスポート時計（options.now。拍0=0）。
// 拍の時刻は beat-grid.ts の grid.beatTime(beatIndex) だけで決め、BGM・cue・hitAt・アプローチリングが同じ拍を見る。

import {
	DEFAULT_SONG,
	PATTERN_BY_ID,
	gridOf,
	RHYTHM_PATTERNS,
	SEQUENCE_BY_ID,
	sectionIndexAt,
	sectionStart,
	type CueSound,
	type GameSection,
	type RhythmPattern,
	type RhythmSequence,
	type SectionId,
	type SongDefinition,
} from './song';

export type GameEventName =
	| 'game_view'
	| 'game_start'
	| 'hit'
	| 'rhythm_pattern'
	| 'section_change'
	| 'fever_start'
	| 'fever_end'
	| 'game_over'
	| 'game_retry';

/** 判定の種類。得点対象は perfect/great/good のみ（near/miss は 0 点）。 */
export type HitKind = 'perfect' | 'great' | 'good' | 'near' | 'miss';

// 譜面（パターン・シーケンス）と曲構成（セクション）は song.ts（audio と共有するデータ）。
export type { CueSound, RhythmPattern, RhythmSequence, GameSection, SectionId, SongDefinition } from './song';

/** 難易度。カオス（激しい挙動）は全段維持。差は的の大きさ・初期条件・譜面（物理の速度は全段同じ＝timeScale 1）。 */
export type Difficulty = 'easy' | 'normal' | 'hard' | 'oni';

interface DifficultyPreset {
	/** 的の半径（大きいほど易しい）。リズム同期のため速度差・アシストは廃止し、差は的の大きさのみ */
	targetR: number;
	/** θ1 初期角の絶対値レンジ（大きいほど暴れる） */
	a1: [number, number];
	/** θ2 初期角の絶対値レンジ */
	a2: [number, number];
	/** 的を置く距離レンジ（軸からの距離。先端の可動域は最大 2） */
	dist: [number, number];
}

export const DIFFICULTY_PRESETS: Record<Difficulty, DifficultyPreset> = {
	easy: { targetR: 0.55, a1: [1.9, 3.0], a2: [1.6, 3.1], dist: [0.5, 1.4] },
	normal: { targetR: 0.34, a1: [1.9, 3.0], a2: [1.5, 3.1], dist: [0.6, 1.6] },
	hard: { targetR: 0.2, a1: [1.9, 3.0], a2: [1.4, 3.1], dist: [0.7, 1.8] },
	oni: { targetR: 0.13, a1: [2.2, 3.3], a2: [2.0, 3.3], dist: [0.8, 1.9] },
};

export interface GameEventPayloads {
	game_view: undefined;
	game_start: undefined;
	hit: {
		kind: HitKind;
		/** 内部の距離スコア（0〜100・分析用。得点=加算値ではない） */
		pts: number;
		/** 加点対象なら加算後の合計、そうでなければ据え置き合計 */
		score: number;
		combo: number;
		comboMult: number;
		maxCombo: number;
		/** 的中心までの距離（画面px換算） */
		distancePx: number;
		/** near のときの「あと◯px」。それ以外は 0 */
		nearMissPx: number;
		/** 予定入力時刻とのズレ（ms）。負=早押し／正=遅押し。寿命切れ（expired）は 0 */
		timingOffsetMs: number;
		/** 寿命切れの MISS（押していない）なら true */
		expired: boolean;
		/** この的が CHAOS チャンス（hitAt に先端が最も荒れている＝速い瞬間）だったか */
		chaos: boolean;
		/** CHAOS チャンスを PERFECT で叩き抜いた（⚡ CHAOS PERFECT）。得点は通常の PERFECT と同じ（ランキングの尺度を変えない） */
		chaosPerfect: boolean;
	};
	/**
	 * リズム予告のスケジュール。時刻は全部 transport 時刻（秒・拍0=0）＝ grid.beatTime(beatIndex)。
	 * audio は startTime + time に予約する（「今から何秒後」の相対値は使わない＝位相がズレない）。
	 */
	rhythm_pattern: {
		patternId: string;
		/** 入力拍の拍番号（小数=裏拍）。target.hitAt = grid.beatTime(hitBeat) */
		hitBeat: number;
		/** 入力拍の transport 時刻（= target.hitAt） */
		hitTime: number;
		cues: { beat: number; time: number; sound: CueSound }[];
		/** CHAOS チャンスの的か（audio は hitTime の直前に予兆音を予約する） */
		chaos: boolean;
		/** 予兆を hitTime の何秒前から出すか（映像の予兆と同じ長さ） */
		chaosTell: number;
	};
	/** 曲のセクションが変わった（小節頭。INTRO は拍0で通知） */
	section_change: {
		section: SectionId;
		/** 経過秒（transport 時刻＝拍0からの秒。小節頭に丸めた境界） */
		elapsed: number;
		/** 0..4 の盛り上がり度 */
		musicIntensity: number;
	};
	fever_start: undefined;
	/** reason: miss=MISS/NEAR・寿命切れで解除 / timeout=時間切れ / finish=曲の終止まで維持（解除扱いにしない） */
	fever_end: { reason: 'miss' | 'timeout' | 'finish'; duration: number; hits: number };
	/** 1ゲーム分の集計（実機調整用）。hits = 全判定数（寿命切れ MISS を含む） */
	game_over: {
		score: number;
		maxCombo: number;
		hits: number;
		perfectCount: number;
		greatCount: number;
		goodCount: number;
		nearCount: number;
		/** 押した MISS＋寿命切れ MISS */
		missCount: number;
		/** うち寿命切れ（押さなかった）MISS */
		expiredCount: number;
		/** 押した判定の |timingOffsetMs| 平均（寿命切れは除く。押していなければ 0） */
		averageAbsTimingOffsetMs: number;
		/** 押した判定の timingOffsetMs 平均（符号付き。負=早押し傾向＝遅延補正の目安） */
		averageTimingOffsetMs: number;
		/** FEVER に入った回数 */
		feverCount: number;
		/** FEVER だった合計秒数（0.1秒単位） */
		feverDuration: number;
		/** FEVER 中（×2 適用）に取った GOOD 以上の数 */
		feverHits: number;
		/** うち PERFECT */
		feverPerfects: number;
		/** CHAOS チャンスの的の数と、そのうち CHAOS PERFECT で叩き抜いた数 */
		chaosChances: number;
		chaosPerfectCount: number;
	};
	game_retry: undefined;
}

export interface GameElements {
	/** 合計スコアの表示先 */
	score: HTMLElement;
	/** 現在コンボの表示先 */
	combo: HTMLElement;
	/** 残り時間バー（width % を設定する内側要素） */
	time: HTMLElement;
	/** 残り秒数の表示先（任意） */
	timeText?: HTMLElement | null;
	/** 判定の詳細（+240 / あと6px！ など）の表示先 */
	msg: HTMLElement;
}

/** 入力イベントの時刻を transport 時刻にしたもの（mode は換算方法：outputTimestamp / audioClock / performance） */
export interface EventClockTime {
	t: number;
	mode: string;
	/** AudioContext の時刻に直した値（音の時計のときだけ） */
	contextTime?: number | null;
}
/** 押した瞬間の時刻の内訳（resolvePress の結果） */
export interface PressInfo {
	/** 判定に使う押下時刻（transport 秒） */
	t: number;
	/** ハンドラ実行時の時計による押下時刻（従来の方式。比較用） */
	handlerT: number;
	/** event = イベントの時刻を使った / handler = 使えなかったので従来の時計 */
	source: 'event' | 'handler';
	mode: string;
	/** event.timeStamp（ms）と、ハンドラ実行時の performance.now()（ms） */
	eventMs: number | null;
	handlerMs: number;
	/** イベント発生 → ハンドラ実行の遅れ（ms。計測用） */
	queueLagMs: number | null;
	contextTime: number | null;
}
export interface InputDebugInfo extends PressInfo {
	hitAt: number;
	/** 判定に使った押下時刻 − hitAt（ms） */
	offsetMs: number;
	/** 従来方式（ハンドラ実行時）だった場合の押下時刻 − hitAt（ms） */
	handlerOffsetMs: number;
	/** 押下時刻の物理：固定ステップのあとに端数で進めた量（ms、0〜3.33） */
	remainderMs: number;
	/** 巻き戻せる状態より前だったので打ち切った量（ms。通常 0） */
	clampedMs: number;
}

export interface InitGameOptions {
	canvas: HTMLCanvasElement;
	elements: GameElements;
	difficulty?: Difficulty;
	/**
	 * 共通トランスポート時計（秒）。拍0で 0・カウントイン中は負。audio.now() を渡す（エンジンは AudioContext を知らない）。
	 * 省略時は start() 時点から COUNTIN なしの performance.now 基準。
	 */
	now?: () => number;
	/** false なら初期化時に自動開始しない（TAP TO START で start() を待つ）。既定 true。 */
	autostart?: boolean;
	/** 曲（尺とセクション）。既定は 60 秒の DEFAULT_SONG。audio にも同じものを渡すこと */
	song?: SongDefinition;
	/** 同期確認用のデバッグ表示（?debug=1）。追加で表示する行を返す。本番では渡さない */
	debugInfo?: () => string[];
	/**
	 * 入力イベントの時刻（event.timeStamp：performance.now と同じ基準のミリ秒）→ transport 時刻（秒）。audio.eventTimeToTransport を渡す。
	 * 省略時：now も省略なら performance 時計で換算、now だけ渡したなら換算しない（ハンドラ実行時の時計で判定）。
	 */
	eventTime?: (eventTimeStamp: number) => EventClockTime | null;
	/** ?debug=1：押すたびに入力時刻の内訳を受け取る（検証用。本番では渡さない） */
	onInputDebug?: (info: InputDebugInfo) => void;
	onEvent?: <K extends GameEventName>(name: K, payload: GameEventPayloads[K]) => void;
}

export interface GameHandle {
	destroy(): void;
	/**
	 * ゲーム開始（初回・retry・難易度変更すべて同じ経路）。呼ぶ前に transport を張り直しておくこと。
	 * gameTime<0（カウントイン中）なら拍0まで待ってから最初の的を出す。retry=true なら game_retry を先に通知。
	 */
	start(opts?: { difficulty?: Difficulty; retry?: boolean }): void;
}

type Vec = number[];

export function initGame(options: InitGameOptions): GameHandle {
	// --- ルール定数 ---
	// 1ゲームの尺とセクションは曲データから（GAME_DURATION を直書きしない＝将来 30/90 秒モードに広げられる）
	const song: SongDefinition = options.song ?? DEFAULT_SONG;
	// 拍グリッドは曲の BPM から（外部音源の曲は曲ごとのテンポ）。以降の拍計算はすべてこの grid
	const grid = gridOf(song);
	const duration = song.duration;
	const finalIdx = song.sections.length - 1;
	const hasFinalCount = song.finalCountdown !== false; // フル尺の曲はアウトロを聞かせる（5→1 のカウントを出さない）
	// 最後のセクション（FINAL）を5カウントに等分（60秒版は10拍＝2拍ごとに 5→1。最終拍＝終止）
	const FINAL_COUNT = 5;
	const finalStart = sectionStart(song, finalIdx);
	const countStep = (duration - finalStart) / FINAL_COUNT;
	const LAST_HIT_MARGIN = grid.spb; // 最後の入力拍は終止拍の1拍以上前（終止の拍で押させない）
	const BEAT = grid.spb; // 1拍の秒数（曲の BPM）
	const SLOWMO_TIME = 0.2; // 叩いた後のスロー時間（実秒）
	const SLOWMO_SCALE = 0.15; // スロー中の物理倍率
	const FEVER_STREAK = 3; // PERFECT 連続でフィーバー発火
	const FEVER_TIME = 5; // フィーバー継続（実秒）
	const FEVER_MULT = 2; // フィーバー中の得点倍率（速度は変えない＝リズム整合のため）
	// 目押し封じ：位置判定に「拍精度（pressT と hitAt のズレ ms）」を段階的に AND する。
	// 一気に厳しくしない：的の中(d<=R)なら拍が外れても GOOD は残す（救済）。位置が的の外なら位置どおり。
	const BEAT_PERFECT_MS = 45; // これ以内でないと PERFECT にしない
	const BEAT_GREAT_MS = 90; // 拍が強く効く範囲
	const BEAT_GOOD_MS = 170;
	const BEAT_NEAR_MS = 260;
	// 案A：入力拍の直前±この時間だけ的の「正確な瞬間」を示す表示を弱める（音で合わせる価値を出す）。FEVERはさらに広げる。
	const HIDE_MS = 95;
	const HIDE_MS_FEVER = 175;
	// 目押し封じの肝：的の中心＝「拍(hitAt)ではなく hitAt+DECOUPLE の先端位置」に置く。
	// こうすると「距離最小の瞬間」と「拍」がずれ、視覚だけ（距離最小で押す）だと拍が外れて PERFECT にならない。
	// BOT検証（scripts/bot-test.mjs）：0ms→視覚BOT100%PERFECT ／ 60ms→視覚0%・拍だけ11%・両方87%。
	const JUDGE_DECOUPLE = 0.06;
	// CHAOS PERFECT：hitAt の瞬間に先端が速い（＝振り子が最も荒れている）的は「チャンス」。PERFECT で叩き抜くと特別な報酬。
	// 速さは的の生成時に物理から確定するので、予兆は本当の情報（ランダム演出ではない）。
	// 7.5 u/s ≒ 的の約15%（鬼は約20%）。INTRO には出さず、2連続では出さない → 1曲に 3〜4 回。
	// 先端が速いほど PERFECT の時間幅（0.35R ÷ 速さ）が狭くなる＝判定を厳しくしなくても自然に「上手い人なら拾える」。
	const CHAOS_SPEED = 7.5;
	const CHAOS_TELL = 0.35; // hitAt の何秒前から予兆（軌跡が太る・円が震える・高い予兆音）を出すか

	// --- FEVER 演出（表示のみ。物理・判定・target/hitAt・beat grid・timeScale には一切触れない） ---
	const FX = {
		/** 突入演出の長さ（秒）。この後ふつうの FEVER 表示へ移る */
		ENTRY_TIME: 0.7,
		/** 突入フラッシュの最大不透明度（最初の約0.2秒） */
		ENTRY_FLASH_ALPHA: 0.6,
		/** 突入時のズーム量（描画だけ。1+ZOOM から戻る） */
		ENTRY_ZOOM: 0.05,
		/** 拍頭の背景フラッシュ */
		BEAT_FLASH_ALPHA: 0.12,
		/** 背景オーバーレイ合計の上限（FINAL の枠・カウントと重なっても的が見えるように） */
		OVERLAY_ALPHA_MAX: 0.2,
		/** 通常の軌跡の点数と、FEVER 中の倍率 */
		TRAIL_LEN: 140,
		FEVER_TRAIL_MULT: 1.8,
		/** 軌跡をまとめて描く区間数（描画コール数の上限） */
		TRAIL_CHUNKS: 28,
		/** FEVER 中の粒子倍率と、同時に存在できる粒子数の上限（低スペック対策） */
		FEVER_PARTICLE_MULT: 2,
		MAX_PARTICLES: 320,
		/** FEVER 中 PERFECT のカメラシェイク（描画の translate のみ） */
		SHAKE_PX: 6,
		SHAKE_TIME: 0.1,
		/** FEVER 解除の「落差」演出（暗転＋FEVER END）の長さ */
		DROP_TIME: 0.45,
	};
	/** 虹色（拍ごとに yellow → pink → cyan → purple → yellow と循環） */
	const RAINBOW = ['#F2D06B', '#EE93A8', '#7FE3F0', '#B79CF2'];

	const g = 9.81,
		L1 = 1,
		L2 = 1,
		m1 = 1,
		m2 = 1;

	let preset: DifficultyPreset = DIFFICULTY_PRESETS[options.difficulty ?? 'normal'];
	let TARGET_R = preset.targetR;
	// 共通トランスポート時計（BGM/cue と同じ原点）。全部これで gameTime を測る。
	let perfOrigin = performance.now() / 1000;
	const clock = options.now ?? (() => performance.now() / 1000 - perfOrigin);
	// 入力イベントの時刻 → transport 時刻（時計を渡されていなければ同じ performance 時計で換算）
	const eventTimeOf: (ts: number) => EventClockTime | null =
		options.eventTime ?? (options.now ? () => null : (ts) => ({ t: ts / 1000 - perfOrigin, mode: 'performance' }));
	let lastInput: InputDebugInfo | null = null; // ?debug=1 の表示用
	let lastJudge: { kind: string; beatMs: number; posPx: number; g: number } | null = null; // 複合判定の内訳（debug）
	let started = options.autostart !== false;
	let lastClock = 0;

	const cv = options.canvas;
	const ctx = cv.getContext('2d');
	if (!ctx) throw new Error('2D context is not available');
	const $score = options.elements.score;
	const $combo = options.elements.combo;
	const $time = options.elements.time;
	const $timeText = options.elements.timeText ?? null;
	const $msg = options.elements.msg;

	const emit = <K extends GameEventName>(name: K, payload: GameEventPayloads[K]) => {
		try {
			options.onEvent?.(name, payload);
		} catch {
			/* 計測の失敗はゲーム進行に影響させない */
		}
	};

	// 色は CSS カスタムプロパティから読む（単体HTMLでもフォールバックで動く）。
	const css = getComputedStyle(cv);
	const C = (k: string, fallback: string) => css.getPropertyValue(k).trim() || fallback;
	const col = {
		board: C('--board', '#2F3E37'),
		chalk: C('--chalk', '#ECE8DC'),
		dim: C('--chalk-dim', 'rgba(236,232,220,.25)'),
		yellow: C('--yellow', '#F2D06B'),
		pink: C('--pink', '#EE93A8'),
		blue: C('--blue', '#8CC7E0'),
	};

	let W = 0,
		H = 0,
		scale = 1,
		cx = 0,
		cy = 0;
	function resize() {
		const r = cv.getBoundingClientRect(),
			dpr = window.devicePixelRatio || 1;
		W = r.width;
		H = r.height;
		cv.width = Math.round(W * dpr);
		cv.height = Math.round(H * dpr);
		ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
		cx = W / 2;
		cy = H / 2;
		scale = Math.min(W, H) / 2 / 2.25;
	}
	const ro = new ResizeObserver(resize);
	ro.observe(cv);

	// --- 状態 ---
	interface Target {
		x: number;
		y: number;
		r: number;
		bornAt: number;
		/** 入力拍の拍番号（beat grid 上。小数=裏拍） */
		hitBeat: number;
		/** 入力すべき時刻（gameTime）= grid.beatTime(hitBeat)。先端がここでターゲットへ来る＝ドン・リング収束と一致 */
		hitAt: number;
		/** この時刻を過ぎたら見逃し */
		expireAt: number;
		/** CHAOS チャンス（hitAt での先端速度 ≥ CHAOS_SPEED） */
		chaos: boolean;
		/** 曲の最後の一打（beatmap の final）。叩けたら FINAL PERFECT / FINAL HIT! */
		final: boolean;
	}
	let s: Vec; // [θ1, θ2, ω1, ω2]
	let trail: [number, number][] = [];
	let target: Target | null = null; // 曲の終わり（最後の入力拍の後）は的なし
	let state: 'idle' | 'countin' | 'playing' | 'slowmo' | 'over' = 'idle';
	let sectionIdx = -1; // 通知済みのセクション（-1=未開始）
	let sectionFlashT = 0; // セクション名の表示（1秒フェード）
	let finishT = 0; // FINISH! 表示
	let gameTime = 0; // 経過（実秒）
	let slowmoT = 0;
	let acc = 0; // 固定タイムステップ用の時間アキュムレータ
	let score = 0;
	let combo = 0;
	let maxCombo = 0;
	let hits = 0;
	let perfectCount = 0;
	// 実機調整用の集計（判定ロジックには使わない）
	const counts: Record<HitKind, number> = { perfect: 0, great: 0, good: 0, near: 0, miss: 0 };
	let expiredCount = 0;
	let pressCount = 0;
	let sumAbsOffsetMs = 0;
	let sumOffsetMs = 0;
	let perfectStreak = 0;
	let fever = false;
	let feverT = 0;
	// FEVER 演出・集計（表示と計測のみ）
	let feverEntryT = 0; // 突入演出 1→0
	let feverDropT = 0; // 解除演出 1→0
	let feverStreak = 0; // 今回の FEVER 中に GOOD 以上を取った数（表示用「FEVER ×N」。倍率ではない）
	let feverStartedAt = 0;
	let feverFinish = false; // FEVER のまま曲が終わった（最も派手な FINISH）
	let feverCount = 0;
	let feverTime = 0;
	let feverHits = 0;
	let feverPerfects = 0;
	let shakeT = 0;
	let scorePop: { text: string; big: boolean; t: number; sub?: string } | null = null;
	// CHAOS PERFECT（表示・集計のみ）
	let lastWasChaos = false;
	// 手書き譜面（曲ごと・任意）
	const beatmap = song.beatmap ?? [];
	let mapIdx = 0;
	let waitingForMap = false; // 的を出さずに待っている（手書き譜面のエントリ・休符・「聞く」区間）。ループが毎フレーム newTarget を呼ぶ
	let lastHitBeat: number | null = null; // 直前の的の入力拍（休符の起点）
	let chaosChances = 0;
	let chaosPerfectCount = 0;
	let chaosFlashT = 0; // 叩き抜いた瞬間の白い閃光＋電撃（1→0）
	let pendingBursts: { t: number; x: number; y: number }[] = [];
	// 譜面シーケンス：今のセクションの sequencePool から1つ選び順番に消化 → 別のを選ぶ（直前と同じは避ける）。
	// セクションが変わってプール外になったシーケンスは途中でも切り上げ、新セクションの譜面に替える。
	let curSeq: RhythmSequence | null = null;
	let seqIdx = 0;
	let lastSeqId = '';
	function pickSequence(sec: GameSection): RhythmSequence {
		const pool = sec.sequencePool.map((id) => SEQUENCE_BY_ID[id]).filter(Boolean);
		if (!pool.length) return SEQUENCE_BY_ID.e1;
		let pick = pool[(Math.random() * pool.length) | 0];
		let guard = 0;
		while (pool.length > 1 && pick.id === lastSeqId && guard++ < 8) {
			pick = pool[(Math.random() * pool.length) | 0];
		}
		lastSeqId = pick.id;
		return pick;
	}
	/** 次に出すパターン（消費しない）。手書き譜面のエントリの前に収まるかを見るため */
	function peekPattern(sec: GameSection): RhythmPattern {
		if (!curSeq || seqIdx >= curSeq.patterns.length || !sec.sequencePool.includes(curSeq.id)) {
			curSeq = pickSequence(sec);
			seqIdx = 0;
		}
		return PATTERN_BY_ID[curSeq.patterns[seqIdx]] ?? RHYTHM_PATTERNS[0];
	}
	function nextPattern(sec: GameSection): RhythmPattern {
		const p = peekPattern(sec);
		seqIdx++;
		return p;
	}

	// 演出（表示のみ・物理/スコアに干渉しない）
	let flash = 0;
	let popT = 0;
	let resultLabel = '';
	let lastHit: { d: number; kind: HitKind } | null = null;
	let milestoneLabel = ''; // コンボ節目の演出：上部の COMBO 表示が一瞬大きく黄色に＋「♪ BASS IN ×1.2」
	let milestoneT = 0;
	let resultSub = ''; // 判定ラベルの下の一言（PERFECT ×2 / COMBO KEEP / STILL ALIVE / ⚡ CHAOS おしい！）
	// FEVER が終わった瞬間に「ここまで行けた」を短く残す（miss=暗転＋FEVER END / timeout=FEVER CLEAR!）
	let feverSummary: { reason: 'miss' | 'timeout'; streak: number; chaos: number } | null = null;
	let feverSummaryT = 0;
	let feverChaos = 0; // 今回の FEVER 中の CHAOS PERFECT 数
	let chaosHintShown = false; // 最初の CHAOS チャンスで1度だけ説明（ページを開いている間で1回。newGame では戻さない）
	let chaosHintT = 0;

	interface Particle {
		x: number;
		y: number;
		vx: number;
		vy: number;
		life: number;
		ttl: number;
		size: number;
		color: string;
	}
	let particles: Particle[] = [];
	// prefers-reduced-motion：シェイク・ズームなし、粒子とフラッシュを控えめに（音・スコアは同じ）
	const rmq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
	let reducedMotion = !!rmq?.matches;
	const onReducedMotion = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
	rmq?.addEventListener?.('change', onReducedMotion);
	const particleMult = () => (reducedMotion ? 0.4 : 1);
	const flashMult = () => (reducedMotion ? 0.4 : 1);

	function burst(px: number, py: number, big: boolean, opts: { mult?: number; palette?: string[]; speed?: number } = {}) {
		const room = FX.MAX_PARTICLES - particles.length;
		const n = Math.min(room, Math.round((big ? 40 : 16) * (opts.mult ?? 1) * particleMult()));
		const speed = (big ? 340 : 210) * (opts.speed ?? 1);
		const palette = opts.palette ?? (big ? [col.yellow, col.pink, col.chalk, col.blue] : [col.chalk, col.blue]);
		for (let i = 0; i < n; i++) {
			const a = Math.random() * Math.PI * 2;
			const sp = speed * (0.35 + Math.random() * 0.85);
			particles.push({
				x: px,
				y: py,
				vx: Math.cos(a) * sp,
				vy: Math.sin(a) * sp - 70,
				life: 0,
				ttl: 0.6 + Math.random() * 0.6,
				size: (big ? 3 : 2) + Math.random() * 3,
				color: palette[(Math.random() * palette.length) | 0],
			});
		}
	}

	// --- 物理（変更禁止） ---
	function deriv([t1, t2, w1, w2]: Vec): Vec {
		const d = t1 - t2,
			den = 2 * m1 + m2 - m2 * Math.cos(2 * d);
		const a1 =
			(-g * (2 * m1 + m2) * Math.sin(t1) -
				m2 * g * Math.sin(t1 - 2 * t2) -
				2 * Math.sin(d) * m2 * (w2 * w2 * L2 + w1 * w1 * L1 * Math.cos(d))) /
			(L1 * den);
		const a2 =
			(2 *
				Math.sin(d) *
				(w1 * w1 * L1 * (m1 + m2) +
					g * (m1 + m2) * Math.cos(t1) +
					w2 * w2 * L2 * m2 * Math.cos(d))) /
			(L2 * den);
		return [w1, w2, a1, a2];
	}
	function rk4(y: Vec, h: number): Vec {
		const add = (a: Vec, b: Vec, k: number) => a.map((v, i) => v + b[i] * k);
		const k1 = deriv(y),
			k2 = deriv(add(y, k1, h / 2)),
			k3 = deriv(add(y, k2, h / 2)),
			k4 = deriv(add(y, k3, h));
		return y.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
	}
	const tips = ([t1, t2]: Vec): [number, number, number, number] => {
		const x1 = L1 * Math.sin(t1),
			y1 = L1 * Math.cos(t1);
		return [x1, y1, x1 + L2 * Math.sin(t2), y1 + L2 * Math.cos(t2)];
	};
	const rand = (a: number, b: number) => a + Math.random() * (b - a);
	const sign = () => (Math.random() < 0.5 ? -1 : 1);
	const P = (x: number, y: number): [number, number] => [cx + x * scale, cy + y * scale];

	function comboMult(c: number): number {
		return c >= 10 ? 2.0 : c >= 5 ? 1.5 : c >= 3 ? 1.2 : 1;
	}
	const CHAOS_LABEL = '⚡ CHAOS PERFECT';
	const FINAL_PERFECT_LABEL = 'FINAL PERFECT';
	/** コンボ節目で解放される BGM の層（audio 側の musicLevel と同じ区切り） */
	const LAYER_OF: Record<number, string> = { 3: '♪ BASS', 5: '♪ HAT', 10: '♪ MELODY' };
	const LABEL: Record<HitKind, string> = {
		perfect: 'PERFECT',
		great: 'GREAT',
		good: 'GOOD',
		near: 'NEAR MISS',
		miss: 'MISS',
	};

	// 物理は固定タイムステップ（FIXED_H）で進める。これでフレームレート・timeScale に依らず
	// 軌道が毎回同じ離散列になり、下の予測が実機と「完全一致」する（＝的が必ず通過する）。
	const FIXED_H = 1 / 300;
	const PRED_HORIZON = 2.6; // 的を置く未来の上限（秒）。カオスなので近い将来だけ信頼する（リズム量子化で最大~2.3秒先）
	const MAX_PRESS_LAG = 0.25; // 入力イベントの時刻が使えないとき：押した瞬間（ハンドラ実行時）まで進める上限（秒）。ループの dt 上限と同じ
	// 入力イベントの時刻（event.timeStamp → transport）を信じる範囲。これより古い／未来のものは異常値として従来の clock() に戻す
	// （音の出力遅延ぶん過去になるので MAX_PRESS_LAG より少し広い。スナップショットもこの長さだけ保持）
	const MAX_EVENT_AGE = 0.5;
	const MAX_EVENT_AHEAD = 0.02;

	/**
	 * 物理状態のスナップショット（transport 時刻 t に s だった）。押した瞬間（イベントの時刻）が最後の描画フレームより前でも、
	 * そこから同じ積分で進めて「その瞬間の位置」を出すため。timeScale = 1 の区間（playing）だけ記録し、スローに入ったら捨てる
	 * （スロー中は物理時間と transport 時刻の対応が変わるので混ぜない）。
	 */
	let physHist: { t: number; s: Vec }[] = [];
	const physTimeNow = () => gameTime - acc; // s が表している transport 時刻（acc = 未消化の固定ステップ時間）
	function recordPhys() {
		const t = physTimeNow();
		physHist.push({ t, s: s.slice() });
		while (physHist.length > 2 && physHist[0].t < t - MAX_EVENT_AGE - 0.1) physHist.shift();
	}

	/**
	 * 任意の transport 時刻 t の物理状態（判定・未来位置予測の共通関数）。
	 * 起点（現在の s、t が過去ならそれ以前で最新のスナップショット）から、ゲームと同じ固定ステップ（FIXED_H・同じ rk4）で
	 * floor 回進め、残り（< FIXED_H）だけ最後に1回 rk4(残り) で進める。
	 * ループは起点から FIXED_H 刻みで進むので、的を置いたとき（hitAt）と押したとき（pressT）で同じ時刻なら同じ計算列になる
	 * （＝pressT = hitAt ちょうどなら先端は的の中心。以前の Math.round による ±1.67ms の量子化は無い）。
	 */
	function stateAtTime(t: number): { s: Vec; remainder: number; clampedFrom: number } {
		let base = s;
		let bt = physTimeNow();
		let clampedFrom = t;
		if (t < bt) {
			for (let i = physHist.length - 1; i >= 0; i--) {
				if (physHist[i].t <= t + 1e-9) {
					base = physHist[i].s;
					bt = physHist[i].t;
					break;
				}
			}
			if (t < bt) {
				// 巻き戻せる状態が無い（スナップショットより前）：持っている最古の状態の時刻で打ち切る
				if (physHist.length) {
					base = physHist[0].s;
					bt = physHist[0].t;
				}
				t = bt;
			}
		}
		clampedFrom = clampedFrom - t; // 打ち切った量（秒。通常 0）
		const d = Math.max(0, t - bt);
		const n = Math.floor(d / FIXED_H + 1e-9);
		const remainder = d - n * FIXED_H;
		let sim = base.slice();
		for (let i = 0; i < n; i++) sim = rk4(sim, FIXED_H);
		if (remainder > 1e-7) sim = rk4(sim, remainder);
		return { s: sim, remainder: Math.max(0, remainder), clampedFrom };
	}
	/** 時刻 t の先端位置＋その瞬間の先端の速さ（次の1固定ステップとの差。ワールド単位/秒）。的の配置・CHAOS・判定で共通 */
	function tipAtTime(t: number): { x: number; y: number; speed: number; remainder: number; clampedFrom: number } {
		const st = stateAtTime(t);
		const [, , x2, y2] = tips(st.s);
		const [, , nx, ny] = tips(rk4(st.s, FIXED_H));
		return { x: x2, y: y2, speed: Math.hypot(nx - x2, ny - y2) / FIXED_H, remainder: st.remainder, clampedFrom: st.clampedFrom };
	}

	// 的は「リズムパターンの入力拍」に対応する未来軌道点へ置く。
	// = 音（タン・タン・ドン）でタイミングが分かり、振り子を見て微調整すると PERFECT。
	function newTarget() {
		const maxT = PRED_HORIZON;

		// パターンは「パターン先頭の拍」が属するセクションの譜面から順番に取り、先頭を次の拍頭に合わせる（beat grid と同期）。
		// 以降、cue・hitAt・リングはすべてこの拍番号から grid.beatTime() で求める（=BGMの拍頭と同じ式）。
		const firstBeat = grid.nextBeatIndex(gameTime);
		// 休符（section.restBeats）：前の入力拍から指定の拍数あけてから次のパターンを始める（歌・ギターを聞かせる）
		const restSec = song.sections[sectionIndexAt(song, grid.beatTime(firstBeat))];
		// （restBeats が無い区間＝60秒版は従来どおり「次の拍頭」から。譜面の密度・得点の基準を変えない）
		const rest = restSec.restBeats ?? 0;
		const earliest = lastHitBeat == null || rest <= 0 ? firstBeat : Math.max(firstBeat, Math.ceil(lastHitBeat + 1 + rest - 1e-9));
		const sec = song.sections[sectionIndexAt(song, grid.beatTime(earliest))];
		const place = (p: RhythmPattern) => {
			let sb = earliest;
			// 予測範囲を超えない・最低限の反応猶予を確保（ずらすときはパターンごと拍単位＝ドンと hitAt が離れない）
			while (sb > firstBeat && grid.beatTime(sb + p.hitBeat) - gameTime > maxT) sb--;
			while (grid.beatTime(sb + p.hitBeat) - gameTime < 0.5) sb++;
			return sb;
		};
		const lastHitTime = duration - LAST_HIT_MARGIN;
		waitingForMap = false;

		// 手書き譜面（song.beatmap）：その拍では必ず指定のパターン。拍はずらさない（曲のフレーズに合わせてあるため）。
		// 過ぎてしまったエントリ・曲の終わりに収まらないエントリは飛ばす。間はセクションの譜面で埋める。
		while (
			mapIdx < beatmap.length &&
			(beatmap[mapIdx].beat < firstBeat ||
				!PATTERN_BY_ID[beatmap[mapIdx].pattern] ||
				grid.beatTime(beatmap[mapIdx].beat + PATTERN_BY_ID[beatmap[mapIdx].pattern].hitBeat) > lastHitTime)
		)
			mapIdx++;
		const entry = beatmap[mapIdx];
		// 次の通常パターンを置くと、見逃したとき（入力拍＋1.2拍で消える＝次は入力拍＋2から）に次のエントリへ間に合わない
		// → 「開始 + そのパターンの入力拍 + 2 > エントリ」ならエントリを優先する（短いパターンならエントリの直前まで詰められる）
		const fitsBefore = (p: RhythmPattern) => place(p) + p.hitBeat + 2 <= (entry?.beat ?? Infinity);
		if (entry && (sec.autoFill === false || !fitsBefore(peekPattern(sec)))) {
			const ep = PATTERN_BY_ID[entry.pattern];
			if (grid.beatTime(entry.beat + ep.hitBeat) - gameTime > maxT) {
				// まだ予測範囲の外：的を出さずに待つ（ループが毎フレーム呼び直す）。曲のフレーズを優先して拍はずらさない
				target = null;
				waitingForMap = true;
				return;
			}
			mapIdx++;
			spawn(ep, entry.beat, song.sections[sectionIndexAt(song, grid.beatTime(entry.beat))], entry.final);
			return;
		}
		// 「聞く」区間（autoFill: false）：手書き譜面のエントリ以外は出さない。区間が変わるまで待つ
		// 休符：開始できる拍がまだ予測範囲に入っていなければ待つ（ループが毎フレーム呼び直す）
		if (sec.autoFill === false || grid.beatTime(earliest + 4) - gameTime > maxT) {
			target = null;
			waitingForMap = true;
			return;
		}

		let pat = nextPattern(sec);
		let startBeat = place(pat);
		if (grid.beatTime(startBeat + pat.hitBeat) > lastHitTime) {
			// 曲の終わりに収まらない：入力拍が一番遅い「収まるパターン」に差し替え。無ければ的なし（終止を待つ）
			const fit = RHYTHM_PATTERNS.filter((p) => !p.fullOnly) // フル尺専用（H/J/Z）は使わない＝60秒版の終わり方は従来どおり
				.sort((x, y) => y.hitBeat - x.hitBeat)
				.find((p) => grid.beatTime(place(p) + p.hitBeat) <= lastHitTime);
			if (!fit) {
				target = null;
				return;
			}
			pat = fit;
			startBeat = place(pat);
		}
		spawn(pat, startBeat, sec);
	}

	/** パターン pat を拍 startBeat から始める的を作り、予告音を通知する（hitAt = grid.beatTime(startBeat + hitBeat)） */
	function spawn(pat: RhythmPattern, startBeat: number, sec: GameSection, final = false) {
		const hitBeat = startBeat + pat.hitBeat;
		const hitAt = grid.beatTime(hitBeat); // 入力すべき時刻（transport 時刻）
		lastHitBeat = hitBeat;

		// 的の中心＝「hitAt+DECOUPLE の先端位置」（目押し封じ）。距離最小の瞬間を拍から少しずらすため。
		// CHAOS 判定用の速度は拍(hitAt)の瞬間で見る（押す瞬間の荒れ具合）。
		recordPhys(); // この的の区間の起点（押した瞬間が次の描画より前でも、ここから同じ積分で進められる）
		const at = tipAtTime(hitAt); // 速度・chaos 用
		const pos = tipAtTime(hitAt + JUDGE_DECOUPLE); // 的の中心座標
		// CHAOS チャンス：先端が最も荒れている瞬間の的。INTRO には出さず、直前の的がチャンスなら出さない（希少性）。
		// サビは速度のしきい値を少し下げてチャンスを増やす（section.chaosSpeed）
		const chaos = at.speed >= (sec.chaosSpeed ?? CHAOS_SPEED) && sec.id !== 'intro' && !lastWasChaos;
		lastWasChaos = chaos;
		if (chaos) {
			chaosChances++;
			if (!chaosHintShown) {
				chaosHintShown = true;
				chaosHintT = 1;
			}
		}
		target = {
			x: pos.x,
			y: pos.y,
			r: TARGET_R * sec.targetScale, // セクションで的の大きさを少し変える（INTRO は大きめ）
			bornAt: gameTime,
			hitBeat,
			hitAt,
			expireAt: hitAt + BEAT * 1.2, // 入力拍＋約1.2拍で見逃し
			chaos,
			final,
		};

		// 予告音（transport 時刻で渡す）。既に過ぎた cue と入力拍より後の cue は捨てる。
		const cues = pat.cues
			.map((c) => ({ beat: startBeat + c.beat, time: grid.beatTime(startBeat + c.beat), sound: c.sound }))
			.filter((c) => c.time >= gameTime && c.beat <= hitBeat);
		emit('rhythm_pattern', { patternId: pat.id, hitBeat, hitTime: hitAt, cues, chaos, chaosTell: CHAOS_TELL });
	}

	function newGame() {
		s = [sign() * rand(preset.a1[0], preset.a1[1]), sign() * rand(preset.a2[0], preset.a2[1]), 0, 0];
		trail = [];
		started = true;
		lastClock = clock();
		gameTime = lastClock; // transport 基準（カウントイン中は負・拍0で 0）
		slowmoT = 0;
		acc = 0;
		score = 0;
		combo = 0;
		maxCombo = 0;
		hits = 0;
		perfectCount = 0;
		(Object.keys(counts) as HitKind[]).forEach((k) => (counts[k] = 0));
		expiredCount = 0;
		pressCount = 0;
		sumAbsOffsetMs = 0;
		sumOffsetMs = 0;
		perfectStreak = 0;
		fever = false;
		feverT = 0;
		feverEntryT = 0;
		feverDropT = 0;
		feverStreak = 0;
		feverFinish = false;
		feverCount = 0;
		feverTime = 0;
		feverHits = 0;
		feverPerfects = 0;
		shakeT = 0;
		scorePop = null;
		pendingBursts = [];
		lastWasChaos = false;
		mapIdx = 0;
		waitingForMap = false;
		lastHitBeat = null;
		physHist = [];
		lastInput = null;
		chaosChances = 0;
		chaosPerfectCount = 0;
		chaosFlashT = 0;
		curSeq = null;
		seqIdx = 0;
		lastSeqId = '';
		target = null;
		sectionIdx = -1;
		sectionFlashT = 0;
		finishT = 0;
		flash = 0;
		popT = 0;
		resultLabel = '';
		lastHit = null;
		milestoneLabel = '';
		milestoneT = 0;
		resultSub = '';
		feverSummary = null;
		feverSummaryT = 0;
		feverChaos = 0;
		chaosHintT = 0;
		particles = [];
		// gameTime<0 ならカウントイン、そうでなければ即プレイ（最初の的を出す）。
		if (gameTime < 0) {
			state = 'countin';
			$msg.textContent = 'タン・タン・タン… で GO！';
		} else {
			state = 'playing';
			newTarget();
			$msg.textContent = '「ドン！」でタップ ― 先端が黄色い丸に重なる瞬間';
		}
		updateHUD();
		emit('game_start', undefined);
		if (state === 'playing') checkSection();
	}

	/** セクション境界（小節頭）を越えたら section_change を通知（UI・計測用。BGM は audio が同じ曲データから拍単位で切替） */
	function checkSection() {
		const idx = sectionIndexAt(song, Math.max(0, gameTime));
		if (idx === sectionIdx) return;
		sectionIdx = idx;
		const sec = song.sections[idx];
		sectionFlashT = 1;
		emit('section_change', {
			section: sec.id,
			elapsed: Math.round(sectionStart(song, idx) * 1000) / 1000,
			musicIntensity: sec.musicIntensity,
		});
	}

	function updateTime() {
		const played = Math.max(0, gameTime);
		$time.style.width = Math.max(0, Math.min(1, 1 - played / duration)) * 100 + '%';
		if ($timeText) {
			const left = Math.max(0, Math.ceil(duration - played - 1e-6));
			// フル尺（100秒以上）は 4:38 のように分:秒。60秒版は従来どおり秒だけ
			$timeText.textContent = duration >= 100 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : String(left);
		}
	}
	function updateHUD() {
		$score.textContent = String(score);
		$combo.textContent = String(combo);
		updateTime();
	}

	function startFever() {
		fever = true;
		feverT = FEVER_TIME;
		feverEntryT = 1;
		feverDropT = 0;
		feverStreak = 0;
		feverStartedAt = gameTime;
		feverChaos = 0;
		feverCount++;
		// 突入：画面中央と先端から虹の粒子を大量に
		const [, , x2, y2] = tips(s);
		const [px, py] = P(x2, y2);
		burst(cx, cy, true, { mult: FX.FEVER_PARTICLE_MULT, palette: RAINBOW, speed: 1.5 });
		burst(px, py, true, { mult: FX.FEVER_PARTICLE_MULT * 0.6, palette: RAINBOW });
		emit('fever_start', undefined);
	}
	function endFever(reason: 'miss' | 'timeout' | 'finish') {
		if (!fever) return;
		fever = false;
		feverT = 0;
		feverEntryT = 0;
		const dur = Math.max(0, gameTime - feverStartedAt);
		feverTime += dur;
		if (reason === 'miss') feverDropT = 1; // MISS で切れた：一瞬で静かになる落差（虹・太い軌跡が消え、暗く沈む）
		if (reason !== 'finish') {
			// 失敗だけでなく「ここまで行けた」を 0.7 秒残す（時間切れは FEVER CLEAR!）
			feverSummary = { reason, streak: feverStreak, chaos: feverChaos };
			feverSummaryT = 1;
		}
		emit('fever_end', { reason, duration: Math.round(dur * 10) / 10, hits: feverStreak });
	}

	/**
	 * 押した瞬間の transport 時刻を決める。
	 *   1. 入力イベントの時刻（event.timeStamp）を options.eventTime で transport 時刻に換算できて、妥当な範囲なら それ
	 *      （＝指が触れた・キーが押された時刻。ハンドラが遅れて動いても遅押しにならない）
	 *   2. 使えない（時刻が無い・NaN/Infinity・未来・古すぎる）なら従来どおり ハンドラ実行時の clock()（上限 MAX_PRESS_LAG）
	 * 戻り値 null＝的が出る前（スロー中の入力ロック中）に押されていた → 入力として扱わない。
	 */
	function resolvePress(eventTs?: number): PressInfo | null {
		const handlerMs = performance.now();
		const now = clock();
		const handlerT = Math.max(gameTime, Math.min(now, gameTime + MAX_PRESS_LAG)); // 従来の押下時刻
		const info: PressInfo = { t: handlerT, handlerT, source: 'handler', mode: '-', eventMs: null, handlerMs, queueLagMs: null, contextTime: null };
		if (eventTs == null || !Number.isFinite(eventTs)) return info;
		info.eventMs = eventTs;
		const lag = handlerMs - eventTs; // イベント発生 → ハンドラ実行の遅れ（計測用。判定の補正には使わない）
		if (!(lag > -5 && lag < MAX_EVENT_AGE * 1000)) return info; // 基準の違う timeStamp（古い WebKit の epoch 等）は捨てる
		info.queueLagMs = lag;
		const ev = eventTimeOf(eventTs);
		if (!ev || !Number.isFinite(ev.t)) return info;
		if (ev.t > now + MAX_EVENT_AHEAD || ev.t < now - MAX_EVENT_AGE) return info; // transport のかなり未来／過去は信じない
		info.mode = ev.mode;
		info.contextTime = ev.contextTime ?? null;
		if (target && ev.t < target.bornAt) return null; // 的が出る前（入力ロック中）の操作
		info.t = ev.t;
		info.source = 'event';
		return info;
	}

	/** プレイヤーが叩いた（state==='playing' のときだけ呼ばれる）。press = 押した瞬間（resolvePress） */
	function hit(press: PressInfo) {
		if (!target) return;
		// 判定は「最後に描いたフレームの物理状態」ではなく、押した瞬間（pressT）の先端で行う。
		// 的の配置と同じ tipAtTime（固定ステップ＋端数1回）で求める＝hitAt ちょうどなら的の中心（s は変えない）。
		const pressT = press.t;
		const tip = tipAtTime(pressT);
		const [x2, y2] = [tip.x, tip.y];
		lastInput = {
			...press,
			hitAt: target.hitAt,
			offsetMs: (pressT - target.hitAt) * 1000,
			handlerOffsetMs: (press.handlerT - target.hitAt) * 1000,
			remainderMs: tip.remainder * 1000,
			clampedMs: tip.clampedFrom * 1000,
		};
		options.onInputDebug?.(lastInput);
		const d = Math.hypot(x2 - target.x, y2 - target.y);
		const R = target.r;
		// --- 位置精度（振り子↔的）---
		const posN = d / R; // 0=中心, 1=縁
		const posRank = posN <= 0.35 ? 4 : posN <= 0.7 ? 3 : posN <= 1.0 ? 2 : posN <= 1.25 ? 1 : 0;
		// --- 拍精度（押した瞬間の正確な時刻 pressT ↔ 入力拍 hitAt）---
		const beatMs = Math.abs((pressT - target.hitAt) * 1000);
		const beatRank = beatMs <= BEAT_PERFECT_MS ? 4 : beatMs <= BEAT_GREAT_MS ? 3 : beatMs <= BEAT_GOOD_MS ? 2 : beatMs <= BEAT_NEAR_MS ? 1 : 0;
		// --- 複合（段階的・操作感優先）---
		// 位置が土台。そのうえで拍でキャップ（PERFECT/GREAT には拍精度が要る＝目押し封じ）。
		// 的の中(posRank>=2)なら拍が外れても GOOD は残す（救済）。的の外は位置どおり（near/miss）。
		const g = posRank >= 2 ? Math.max(2, Math.min(posRank, beatRank)) : posRank;
		const kind: HitKind = g === 4 ? 'perfect' : g === 3 ? 'great' : g === 2 ? 'good' : g === 1 ? 'near' : 'miss';
		// 点数は「位置と拍の悪い方の誤差」で連続化（両方そろうほど高い。内部100点満点は維持）。
		const worseN = Math.max(posN, beatMs / BEAT_GOOD_MS);
		const pts = g >= 2 ? Math.round(Math.max(40, Math.min(100, 100 - worseN * 45))) : 0;
		lastJudge = { kind, beatMs: Math.round(beatMs), posPx: Math.round(d * scale), g };

		const scoring = kind === 'perfect' || kind === 'great' || kind === 'good';
		// 順序：判定 → GOOD以上ならコンボ+1 → 倍率再計算 → 今回分を加算
		if (scoring) {
			combo++;
			if (combo > maxCombo) maxCombo = combo;
		} else {
			combo = 0;
		}
		// CHAOS FEVER：PERFECT 連続で発火。MISS/NEAR で解除、GREAT/GOOD は連続を切るだけ。
		const wasFever = fever; // この打鍵の前から FEVER だったか（突入の打鍵と FEVER 中の打鍵で演出を分ける）
		if (kind === 'perfect') {
			perfectStreak++;
			if (perfectStreak >= FEVER_STREAK && !fever) startFever();
		} else {
			perfectStreak = 0;
			if (!scoring) endFever('miss');
		}
		const mult = comboMult(combo);
		// コンボ節目（倍率が上がる＝BGMの層が増える瞬間）の演出
		if (scoring && (combo === 3 || combo === 5 || combo === 10)) {
			milestoneLabel = `${LAYER_OF[combo]} IN · ×${mult}`;
			milestoneT = 1;
		}
		const add = scoring ? Math.round(pts * mult * (fever ? FEVER_MULT : 1)) : 0;
		score += add;
		hits++;
		if (kind === 'perfect') perfectCount++;
		if (scoring && fever) {
			feverHits++;
			if (kind === 'perfect') feverPerfects++;
		}
		if (scoring && wasFever) feverStreak++;
		const chaosPerfect = kind === 'perfect' && target.chaos;
		if (chaosPerfect) {
			chaosPerfectCount++;
			if (fever) feverChaos++;
		}
		// 判定ラベルの下の一言：つながっていることを見せる（文字は1行だけ）
		resultSub =
			kind === 'perfect' && !fever && perfectStreak === FEVER_STREAK - 1
				? `PERFECT ×${perfectStreak}`
				: target.chaos && scoring && !chaosPerfect
					? '⚡ CHAOS おしい！'
					: kind === 'great'
						? 'COMBO KEEP'
						: kind === 'good'
							? 'STILL ALIVE'
							: '';

		const nearMissPx = kind === 'near' ? Math.round((d - R) * scale) : 0;
		// 予定入力時刻（拍）とのズレ。負=早押し／正=遅押し。
		const timingOffsetMs = Math.round((pressT - target.hitAt) * 1000);
		counts[kind]++;
		pressCount++;
		sumAbsOffsetMs += Math.abs(timingOffsetMs);
		sumOffsetMs += timingOffsetMs;
		lastHit = { d, kind };
		resultLabel = chaosPerfect ? CHAOS_LABEL : LABEL[kind];
		// 曲の最後の一打（得点は通常どおり。表示だけ特別）
		if (target.final && scoring) {
			resultLabel = kind === 'perfect' ? FINAL_PERFECT_LABEL : 'FINAL HIT!';
			resultSub = chaosPerfect ? '⚡ CHAOS PERFECT' : '';
		}
		popT = 1;
		flash = scoring ? 1 : 0.5;
		if (scoring) {
			const [tx, ty] = P(x2, y2);
			const [gx, gy] = P(target.x, target.y);
			if (wasFever) {
				// FEVER 中：虹の粒子を増量。PERFECT は的から二段階の爆発＋描画シェイク＋巨大な「+xxx ×2」
				burst(tx, ty, kind === 'perfect', { mult: FX.FEVER_PARTICLE_MULT, palette: RAINBOW });
				if (kind === 'perfect') {
					burst(gx, gy, true, { mult: FX.FEVER_PARTICLE_MULT, palette: RAINBOW, speed: 1.2 });
					pendingBursts.push({ t: 0.12, x: gx, y: gy });
					shakeT = FX.SHAKE_TIME;
				}
			} else {
				burst(tx, ty, kind === 'perfect');
				if (kind === 'perfect') burst(gx, gy, true);
			}
			if (fever) scorePop = { text: `+${add}`, big: kind === 'perfect', t: 1, sub: `FEVER ×${FEVER_MULT}` };
			if (chaosPerfect) {
				// ⚡ CHAOS PERFECT：振り子が最も荒れた瞬間を叩き抜いた。白い閃光＋電撃の粒子＋描画だけのシェイク（得点は通常どおり）
				burst(gx, gy, true, { mult: FX.FEVER_PARTICLE_MULT * 1.5, palette: ['#ffffff', '#7FE3F0', '#F2D06B'], speed: 2.1 });
				pendingBursts.push({ t: 0.08, x: gx, y: gy });
				chaosFlashT = 1;
				shakeT = FX.SHAKE_TIME * 1.6;
				// この曲で何回目か（取った数 / ここまでのチャンス数）
				const tally = `${chaosPerfectCount} / ${chaosChances}`;
				scorePop = { text: `+${add}`, big: true, t: 1.2, sub: fever ? `⚡ CHAOS ${tally} × FEVER` : `⚡ CHAOS ${tally}` };
			}
			$msg.textContent = fever
				? `+${add}（×${mult}・FEVER ×${FEVER_MULT}）`
				: mult > 1
					? `+${add}（×${mult}）`
					: `+${add}`;
			if (chaosPerfect) $msg.textContent = `⚡ CHAOS PERFECT！ ${$msg.textContent}`;
			if (target.final) {
				// 最後の一打：曲の最後の和音と同時に虹の大爆発（表示のみ）
				burst(gx, gy, true, { mult: FX.FEVER_PARTICLE_MULT * 2, palette: RAINBOW, speed: 1.8 });
				pendingBursts.push({ t: 0.1, x: gx, y: gy });
				shakeT = FX.SHAKE_TIME * 1.8;
				$msg.textContent = `${resultLabel}！ ${$msg.textContent}`;
			}
		} else if (kind === 'near') {
			// 惜しい：距離ではなく拍とのタイミングのズレを見せる（「もう一回」を誘発）
			const sec = Math.abs(timingOffsetMs) / 1000;
			$msg.textContent = `${sec.toFixed(2)}秒${timingOffsetMs < 0 ? '早い' : '遅い'}！`;
		} else {
			$msg.textContent = 'MISS';
		}
		updateHUD();
		emit('hit', {
			kind,
			pts,
			score,
			combo,
			comboMult: mult,
			maxCombo,
			distancePx: Math.round(d * scale),
			nearMissPx,
			timingOffsetMs,
			expired: false,
			chaos: target.chaos,
			chaosPerfect,
		});

		// 叩いたら必ずスロー → 次の的
		state = 'slowmo';
		physHist = []; // スロー中は物理時間と transport の対応が変わる → 次の的から記録し直す
		slowmoT = SLOWMO_TIME;
	}

	/** 寿命切れ（見逃し）。スローは挟まず即次。 */
	function expireTarget() {
		if (!target) return;
		combo = 0;
		perfectStreak = 0;
		endFever('miss');
		hits++;
		counts.miss++;
		expiredCount++;
		resultLabel = 'MISS';
		resultSub = '';
		popT = 1;
		flash = 0.4;
		lastHit = null;
		$msg.textContent = '見逃し…';
		updateHUD();
		emit('hit', {
			kind: 'miss',
			pts: 0,
			score,
			combo: 0,
			comboMult: 1,
			maxCombo,
			distancePx: 0,
			nearMissPx: 0,
			timingOffsetMs: 0,
			expired: true,
			chaos: target.chaos,
			chaosPerfect: false,
		});
		newTarget();
	}

	function endGame() {
		state = 'over';
		resultLabel = '';
		target = null;
		finishT = 1; // 曲の終止：FINISH! を大きく（終止音は audio が最終拍に鳴らす）
		if (fever) {
			// FEVER のまま終止：解除（MISS）扱いにせず、いちばん派手な FINISH へ繋ぐ
			feverFinish = true;
			burst(cx, cy, true, { mult: FX.FEVER_PARTICLE_MULT * 1.5, palette: RAINBOW, speed: 1.6 });
			endFever('finish');
		}
		updateTime();
		$msg.textContent = `FINISH！ ${score}点・最大${maxCombo}コンボ`;
		emit('game_over', {
			score,
			maxCombo,
			hits,
			perfectCount,
			greatCount: counts.great,
			goodCount: counts.good,
			nearCount: counts.near,
			missCount: counts.miss,
			expiredCount,
			averageAbsTimingOffsetMs: pressCount ? Math.round(sumAbsOffsetMs / pressCount) : 0,
			averageTimingOffsetMs: pressCount ? Math.round(sumOffsetMs / pressCount) : 0,
			feverCount,
			feverDuration: Math.round(feverTime * 10) / 10,
			feverHits,
			feverPerfects,
			chaosChances,
			chaosPerfectCount,
		});
	}

	// --- 入力 ---
	/** eventTs = 入力イベントの timeStamp（performance.now と同じ基準のミリ秒）。無ければハンドラ実行時の時計で判定 */
	function act(eventTs?: number) {
		if (state !== 'playing' || !target) return; // slowmo/over 中・曲の終わり（的なし）はロック
		const press = resolvePress(eventTs);
		if (!press) return;
		hit(press);
	}
	const onActClick = () => act();
	const onPointerDown = (e: PointerEvent) => {
		e.preventDefault();
		act(e.timeStamp);
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.code !== 'Space' && e.code !== 'Enter') return;
		// 文字入力中（ニックネーム欄など）は奪わない
		const el = e.target as HTMLElement | null;
		if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
		// ゲーム進行中だけキーを奪う。開始前・終了後はページのボタン（▶ PLAY・もう一回 等）の本来の Space/Enter を妨げない
		if (state !== 'countin' && state !== 'playing' && state !== 'slowmo') return;
		e.preventDefault();
		act(e.timeStamp);
	};
	cv.addEventListener('pointerdown', onPointerDown);
	window.addEventListener('keydown', onKeyDown);

	// --- 描画 ---
	function beatPulse(): number {
		const phase = grid.beatPhase(gameTime); // 0→1（BGM の拍頭で 0）
		return Math.max(0, 1 - phase * 1.6); // 拍頭で1、すぐ減衰
	}

	// 虹色：拍ごとに RAINBOW を1色進め、拍の中で次の色へ補間（beat grid に同期した色相循環）
	function hexToRgb(h: string): [number, number, number] {
		const n = parseInt(h.slice(1), 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
	const RAINBOW_RGB = RAINBOW.map(hexToRgb);
	function rainbowAt(t: number, offset = 0): string {
		const x = t / BEAT + offset;
		const i = Math.floor(x);
		const f = x - i;
		const n = RAINBOW_RGB.length;
		const c0 = RAINBOW_RGB[((i % n) + n) % n];
		const c1 = RAINBOW_RGB[(((i + 1) % n) + n) % n];
		return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * f)).join(',')})`;
	}
	const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
	/** CHAOS チャンスの予兆の強さ 0→1（hitAt の CHAOS_TELL 秒前から立ち上がり、hitAt を少し過ぎたら消える）。的の位置・判定には無関係 */
	function chaosTell(): number {
		if (state !== 'playing' || !target || !target.chaos) return 0;
		const until = target.hitAt - gameTime;
		if (until > CHAOS_TELL || until < -0.12) return 0;
		return Math.min(1, Math.max(0, 1 - until / CHAOS_TELL));
	}
	/** 判定ラベルの高さ。FEVER 中は上部の FEVER 見出し・ゲージと重ならないよう少し下げる */
	const labelY = () => Math.max(H * 0.16, cy - scale * 1.7) + (fever ? Math.min(W, H) * 0.12 : 0);

	/** 画面幅（92%）に収まるよう縮めてから中央揃えで描く */
	function fitText(text: string, x: number, y: number, size: number, color: string, weight = 700) {
		ctx!.font = `${weight} ${Math.round(size)}px "Klee One", sans-serif`;
		const w = ctx!.measureText(text).width;
		centeredText(text, x, y, w > W * 0.92 ? (size * W * 0.92) / w : size, color, weight);
	}
	function centeredText(text: string, x: number, y: number, size: number, color: string, weight = 700) {
		ctx!.fillStyle = color;
		ctx!.font = `${weight} ${Math.round(size)}px "Klee One", sans-serif`;
		ctx!.textAlign = 'center';
		ctx!.textBaseline = 'middle';
		ctx!.fillText(text, x, y);
	}

	function draw() {
		ctx!.clearRect(0, 0, W, H);
		ctx!.lineCap = 'round';
		ctx!.lineJoin = 'round';
		const m = Math.min(W, H);
		const live = state === 'playing' || state === 'slowmo';
		const inFinal = hasFinalCount && live && sectionIdx === finalIdx;
		const entryP = feverEntryT > 0 ? 1 - feverEntryT : 1; // 突入演出の進み 0→1

		// 描画だけのカメラ：FEVER 突入のズーム＋FEVER PERFECT のシェイク。物理・判定の座標は変えない。
		ctx!.save();
		if (!reducedMotion) {
			if (feverEntryT > 0) {
				const z = 1 + FX.ENTRY_ZOOM * (1 - easeOut(entryP));
				ctx!.translate(cx, cy);
				ctx!.scale(z, z);
				ctx!.translate(-cx, -cy);
			}
			if (shakeT > 0) {
				const k = FX.SHAKE_PX * (shakeT / FX.SHAKE_TIME);
				ctx!.translate((Math.random() * 2 - 1) * k, (Math.random() * 2 - 1) * k);
			}
		}

		// CHAOS FEVER：背景が拍頭で光る（pink / yellow を拍ごとに交互）＋虹の縁。
		// FINAL の枠・カウントと重なるときは合計が OVERLAY_ALPHA_MAX を超えないよう抑える。
		if (fever && state !== 'over') {
			const pulse = beatPulse();
			const cap = FX.OVERLAY_ALPHA_MAX - (inFinal ? 0.07 : 0);
			ctx!.globalAlpha = Math.min(cap, (0.05 + FX.BEAT_FLASH_ALPHA * pulse) * flashMult());
			ctx!.fillStyle = Math.floor(gameTime / BEAT) % 2 === 0 ? col.pink : col.yellow;
			ctx!.fillRect(-20, -20, W + 40, H + 40);
			if (!inFinal) {
				ctx!.globalAlpha = 0.35 + 0.4 * pulse;
				ctx!.strokeStyle = rainbowAt(gameTime);
				ctx!.lineWidth = 5;
				ctx!.strokeRect(2.5, 2.5, W - 5, H - 5);
			}
			ctx!.globalAlpha = 1;
		}

		// 可動範囲
		ctx!.strokeStyle = col.dim;
		ctx!.lineWidth = 1;
		ctx!.setLineDash([2, 8]);
		ctx!.beginPath();
		ctx!.arc(cx, cy, 2 * scale, 0, Math.PI * 2);
		ctx!.stroke();
		ctx!.setLineDash([]);

		// カウントイン中は数字（3・2・1）を大きく出す
		if (state === 'countin') {
			const n = Math.ceil(-gameTime / BEAT);
			if (n >= 1 && n <= 3) {
				centeredText(String(n), cx, cy, m * 0.18, col.yellow);
				ctx!.textAlign = 'start';
				ctx!.textBaseline = 'alphabetic';
			}
		}

		// FINAL：最後のセクションは 5→1 のカウントを背景に薄く大きく（拍に同期して切り替わり、最終拍＝終止で 0）
		// ＋黄色い枠が拍で明滅（FEVER 中は虹色）。振り子や的の邪魔をしないよう最背面・低い不透明度。
		if (inFinal) {
			const remain = duration - gameTime;
			const n = Math.max(1, Math.min(FINAL_COUNT, Math.ceil(remain / countStep - 1e-6)));
			const stepPhase = 1 - (remain / countStep - (n - 1)); // 0→1（各カウントの頭で 0）
			const pop = Math.max(0, 1 - stepPhase * 2.5);
			ctx!.save();
			ctx!.globalAlpha = 0.13 + 0.12 * pop;
			centeredText(String(n), cx, cy, m * 0.5 * (1 + 0.08 * pop), fever ? rainbowAt(gameTime) : col.yellow);
			ctx!.globalAlpha = 0.25 + 0.35 * beatPulse();
			ctx!.strokeStyle = fever ? rainbowAt(gameTime) : col.yellow;
			ctx!.lineWidth = 6;
			ctx!.strokeRect(3, 3, W - 6, H - 6);
			ctx!.restore();
		}

		// サビ（section.hype）：拍頭で枠が光る（1=サビ ピンク / 2=ラスサビ 黄色で強め＋背景もかすかに）。FEVER 中は FEVER の演出を優先
		const hype = live && !fever && !inFinal && sectionIdx >= 0 ? (song.sections[sectionIdx].hype ?? 0) : 0;
		if (hype > 0) {
			const pulse = beatPulse();
			ctx!.save();
			if (hype >= 2) {
				ctx!.globalAlpha = 0.05 * pulse * flashMult();
				ctx!.fillStyle = col.yellow;
				ctx!.fillRect(0, 0, W, H);
			}
			ctx!.globalAlpha = (hype >= 2 ? 0.2 + 0.45 * pulse : 0.12 + 0.3 * pulse) * flashMult();
			ctx!.strokeStyle = hype >= 2 ? col.yellow : col.pink;
			ctx!.lineWidth = hype >= 2 ? 6 : 4;
			ctx!.strokeRect(3, 3, W - 6, H - 6);
			ctx!.restore();
		}

		// FEVER 突入：巨大な CHAOS / FEVER / ×2 SCORE（的より奥に描く＝的とリングは常に手前で見える）
		if (fever && feverEntryT > 0) {
			const pop = 1 + 0.35 * (1 - easeOut(Math.min(1, entryP / 0.35)));
			ctx!.save();
			ctx!.globalAlpha = entryP < 0.45 ? 1 : Math.max(0, 1 - (entryP - 0.45) / 0.55);
			centeredText('CHAOS', cx, cy - m * 0.14 * pop, m * 0.17 * pop, rainbowAt(gameTime * 3));
			centeredText('FEVER', cx, cy + m * 0.03 * pop, m * 0.17 * pop, rainbowAt(gameTime * 3, 2));
			centeredText('×2 SCORE', cx, cy + m * 0.17 * pop, m * 0.07 * pop, col.chalk);
			ctx!.restore();
		}

		// 判定ラベル（叩いた直後だけポップ）。FEVER 中の PERFECT は虹色でさらに大きく、下に巨大な「+xxx / FEVER ×2」。
		// 的・リング・振り子より奥に描く（次の的に重なっても的が隠れない）。FEVER 突入の瞬間は突入演出が主役なので出さない。
		if (resultLabel && (state === 'slowmo' || popT > 0) && feverEntryT === 0) {
			const isChaos = resultLabel === CHAOS_LABEL;
			// FINAL PERFECT / FINAL HIT! は FEVER PERFECT と同じく虹色で大きく
			const feverPerfect = (fever && resultLabel === 'PERFECT') || resultLabel === FINAL_PERFECT_LABEL || resultLabel === 'FINAL HIT!';
			const pop = 1 + popT * (isChaos ? 0.9 : feverPerfect ? 0.8 : resultLabel === 'PERFECT' ? 0.6 : 0.3);
			const baseSize = m * (isChaos || feverPerfect ? 0.12 : 0.1);
			const ly = labelY();
			ctx!.save();
			const color = isChaos
				? Math.floor(gameTime * 18) % 2 === 0
					? '#ffffff'
					: '#7FE3F0' // 電撃のように白⇔シアンで明滅
				: feverPerfect
					? rainbowAt(gameTime * 2)
					: resultLabel === 'PERFECT'
						? col.yellow
						: resultLabel === 'MISS'
							? col.blue
							: col.chalk;
			// 長いラベル（⚡ CHAOS PERFECT）はスマホ幅に収まるよう縮める
			let size = baseSize * pop;
			ctx!.font = `600 ${Math.round(size)}px "Klee One", sans-serif`;
			const w = ctx!.measureText(resultLabel).width;
			if (w > W * 0.92) size *= (W * 0.92) / w;
			centeredText(resultLabel, cx, ly, size, color, 600);
			// ラベルの下の一言（得点ポップが出ているときは重ねない）
			if (resultSub && !scorePop) {
				ctx!.globalAlpha = 0.9;
				const subCol = resultSub.startsWith('PERFECT') ? col.yellow : resultSub.startsWith('⚡') ? '#7FE3F0' : col.chalk;
				centeredText(resultSub, cx, ly + size * 0.62, m * 0.042, subCol, 700);
			}
			ctx!.restore();
		}
		if (scorePop && state !== 'over' && feverEntryT === 0) {
			// 表示する点数は倍率適用後の加算値。下に「FEVER ×2」「⚡ CHAOS」などを添える
			const k = Math.max(0, scorePop.t);
			const size = m * (scorePop.big ? 0.11 : 0.065) * (1 + 0.4 * k);
			const ly = labelY() + m * (scorePop.big ? 0.13 : 0.1);
			ctx!.save();
			ctx!.globalAlpha = Math.min(1, k * 2);
			centeredText(scorePop.text, cx, ly, size, scorePop.big ? col.yellow : col.chalk);
			if (scorePop.sub) centeredText(scorePop.sub, cx, ly + size * 0.62, size * 0.32, col.chalk, 600);
			ctx!.restore();
		}

		// ターゲット＋アプローチリング（入力拍に向けて外側の輪が縮んで重なる＝押す瞬間が目で分かる）
		// FEVER 中は色だけ虹色に（位置・半径・判定・hitAt は同じ）。
		if (live && target) {
			const [tx, ty] = P(target.x, target.y);
			const remain = target.expireAt - gameTime;
			const baseR = target.r * scale;
			const targetCol = fever ? rainbowAt(gameTime) : col.yellow;
			const ringCol = fever ? rainbowAt(gameTime, 2) : col.blue;

			// 案A：入力拍への近さ vis（0=まさに拍で最も見えにくい／1=遠くてはっきり）。
			// 「正確な瞬間」を示す表示（リング収束・中心十字）だけを拍直前に弱め、音（ドン）で合わせる価値を出す。
			// 的の位置・半径・脈動・判定・hitAt は一切変えない（狙う"どこ"は見える）。
			const msToHit = Math.abs(gameTime - target.hitAt) * 1000;
			const vis = Math.min(1, msToHit / (fever ? HIDE_MS_FEVER : HIDE_MS));

			// アプローチリング：bornAt→hitAt で大きな輪が的の大きさへ収束する（重なった時が入力拍＝grid.beatTime(hitBeat)＝ドン）
			const lead = Math.max(0.001, target.hitAt - target.bornAt);
			const prog = Math.min(1.3, Math.max(0, (gameTime - target.bornAt) / lead));
			if (prog < 1.25) {
				const approachR = baseR * (1 + 2.6 * Math.max(0, 1 - prog));
				// 収束の瞬間だけ薄く＝目でジャストを読み切れない
				ctx!.globalAlpha = (0.2 + 0.55 * Math.min(1, prog) + (fever ? 0.15 : 0)) * (0.25 + 0.75 * vis);
				ctx!.strokeStyle = ringCol;
				ctx!.lineWidth = fever ? 3 : 2;
				ctx!.beginPath();
				ctx!.arc(tx, ty, approachR, 0, Math.PI * 2);
				ctx!.stroke();
			}

			// CHAOS チャンスの予兆：hitAt の直前だけ、的の周りに電撃の輪＋火花、的の円がわずかに震える。
			// 中心（十字）と的の位置は動かさない＝狙う場所は変わらない。reduced-motion では震え・火花なしで輪だけ。
			const tell = chaosTell();
			if (tell > 0) {
				const segs = 28;
				const R0 = baseR * (1.3 + 0.12 * (1 - tell));
				ctx!.save();
				ctx!.globalAlpha = 0.35 + 0.6 * tell;
				ctx!.strokeStyle = Math.floor(gameTime * 24) % 2 === 0 ? '#ffffff' : '#7FE3F0';
				ctx!.lineWidth = 1.5 + 1.8 * tell;
				ctx!.beginPath();
				for (let i = 0; i <= segs; i++) {
					const a = (i / segs) * Math.PI * 2;
					const jr = reducedMotion ? 0 : (Math.random() * 2 - 1) * (2 + 4 * tell);
					const x = tx + Math.cos(a) * (R0 + jr);
					const y = ty + Math.sin(a) * (R0 + jr);
					if (i === 0) ctx!.moveTo(x, y);
					else ctx!.lineTo(x, y);
				}
				ctx!.stroke();
				if (!reducedMotion && tell > 0.4) {
					ctx!.lineWidth = 1.5;
					for (let i = 0; i < 4; i++) {
						const a = Math.random() * Math.PI * 2;
						const r1 = R0 + 2;
						const r2 = R0 + 6 + Math.random() * 10 * tell;
						ctx!.beginPath();
						ctx!.moveTo(tx + Math.cos(a) * r1, ty + Math.sin(a) * r1);
						ctx!.lineTo(tx + Math.cos(a + 0.12) * r2, ty + Math.sin(a + 0.12) * r2);
						ctx!.stroke();
					}
				}
				ctx!.restore();
			}

			// 的本体（入力拍が近いほど明るく＋拍で脈動）
			const near = Math.min(1, prog); // 0→1
			const quiver = tell > 0 && !reducedMotion ? (Math.random() * 2 - 1) * 1.6 * tell : 0; // 予兆の震え（半径のみ）
			const rDraw = baseR * (1 + 0.18 * beatPulse()) + quiver;
			ctx!.globalAlpha = (0.4 + 0.6 * near) * Math.min(1, remain / 0.5);
			ctx!.strokeStyle = targetCol;
			ctx!.lineWidth = 2.5 + (1.5 + 2 * near) * beatPulse() + (fever ? 1 : 0);
			ctx!.setLineDash([6, 6]);
			ctx!.beginPath();
			ctx!.arc(tx, ty, rDraw, 0, Math.PI * 2);
			ctx!.stroke();
			ctx!.setLineDash([]);
			// 中心十字は「拍の瞬間」の目印になりやすいので、拍直前は消す（案A）
			if (vis > 0.35) {
				ctx!.globalAlpha = vis;
				ctx!.beginPath();
				ctx!.moveTo(tx - 6, ty);
				ctx!.lineTo(tx + 6, ty);
				ctx!.moveTo(tx, ty - 6);
				ctx!.lineTo(tx, ty + 6);
				ctx!.stroke();
			}
			// FEVER：拍直前に的の位置をわずかにブラす（ゴースト）＝耳を使うと有利。reduced-motion では出さない。
			if (fever && vis < 0.9 && !reducedMotion) {
				ctx!.globalAlpha = 0.14 * (1 - vis);
				for (const o of [
					[-9, 5],
					[8, -7],
				]) {
					ctx!.beginPath();
					ctx!.arc(tx + o[0], ty + o[1], rDraw, 0, Math.PI * 2);
					ctx!.stroke();
				}
			}
			ctx!.globalAlpha = 1;
		}

		// 軌跡。FEVER 中は約1.8倍の長さ・太く・濃く、pink → yellow → cyan のグラデーション。
		// 描画コール数を抑えるため TRAIL_CHUNKS 区間にまとめて stroke する。
		{
			const tellT = chaosTell(); // CHAOS 予兆中は軌跡が太く、先端側が白く光る
			const len = fever ? trail.length : Math.min(trail.length, FX.TRAIL_LEN);
			const start = trail.length - len;
			const chunks = Math.max(1, Math.min(FX.TRAIL_CHUNKS, len - 1));
			const per = (len - 1) / chunks;
			for (let c = 0; c < chunks; c++) {
				const i0 = start + Math.floor(c * per);
				const i1 = start + Math.min(len - 1, Math.ceil((c + 1) * per));
				if (i1 <= i0) continue;
				const k = (c + 1) / chunks; // 0→1（新しいほど 1）
				if (fever) {
					ctx!.strokeStyle = k < 0.5 ? col.pink : k < 0.8 ? col.yellow : RAINBOW[2];
					ctx!.globalAlpha = 0.25 + 0.75 * k;
					ctx!.lineWidth = 2 + 3 * k + 3 * tellT * k;
				} else {
					ctx!.strokeStyle = col.pink;
					ctx!.globalAlpha = k * 0.8;
					ctx!.lineWidth = 2 + 3.5 * tellT * k;
				}
				if (tellT > 0 && k > 0.75) {
					ctx!.strokeStyle = '#E8FBFF'; // 先端側が白く光る
					ctx!.globalAlpha = Math.max(ctx!.globalAlpha, 0.5 + 0.5 * tellT);
				}
				ctx!.beginPath();
				ctx!.moveTo(...P(trail[i0][0], trail[i0][1]));
				for (let i = i0 + 1; i <= i1; i++) ctx!.lineTo(...P(trail[i][0], trail[i][1]));
				ctx!.stroke();
			}
			ctx!.globalAlpha = 1;
		}

		// 振り子
		const [x1, y1, x2, y2] = tips(s);
		const [p1x, p1y] = P(x1, y1),
			[p2x, p2y] = P(x2, y2);
		ctx!.strokeStyle = col.chalk;
		ctx!.lineWidth = 3;
		ctx!.beginPath();
		ctx!.moveTo(cx, cy);
		ctx!.lineTo(p1x, p1y);
		ctx!.lineTo(p2x, p2y);
		ctx!.stroke();
		ctx!.fillStyle = col.chalk;
		ctx!.beginPath();
		ctx!.arc(cx, cy, 4, 0, Math.PI * 2);
		ctx!.fill();
		ctx!.beginPath();
		ctx!.arc(p1x, p1y, 9, 0, Math.PI * 2);
		ctx!.fill();
		ctx!.fillStyle = col.pink;
		ctx!.beginPath();
		ctx!.arc(p2x, p2y, 11, 0, Math.PI * 2);
		ctx!.fill();

		// スロー中は距離線（叩いた的との差）
		if (state === 'slowmo' && target && lastHit && lastHit.kind !== 'miss') {
			const [tx, ty] = P(target.x, target.y);
			ctx!.strokeStyle = col.blue;
			ctx!.lineWidth = 2;
			ctx!.setLineDash([4, 5]);
			ctx!.beginPath();
			ctx!.moveTo(p2x, p2y);
			ctx!.lineTo(tx, ty);
			ctx!.stroke();
			ctx!.setLineDash([]);
		}

		// 判定フラッシュ
		if (flash > 0) {
			ctx!.globalAlpha = flash * 0.32 * flashMult();
			ctx!.fillStyle = resultLabel === 'PERFECT' ? col.yellow : col.chalk;
			ctx!.fillRect(-20, -20, W + 40, H + 40);
			ctx!.globalAlpha = 1;
		}

		// ⚡ CHAOS PERFECT の閃光（白。reduced-motion では控えめ）
		if (chaosFlashT > 0) {
			ctx!.globalAlpha = 0.42 * chaosFlashT * flashMult();
			ctx!.fillStyle = '#ffffff';
			ctx!.fillRect(-20, -20, W + 40, H + 40);
			ctx!.globalAlpha = 1;
		}

		// パーティクル
		if (particles.length) {
			for (const p of particles) {
				const k = Math.max(0, 1 - p.life / p.ttl);
				ctx!.globalAlpha = k;
				ctx!.fillStyle = p.color;
				ctx!.beginPath();
				ctx!.arc(p.x, p.y, p.size * (0.5 + k * 0.5), 0, Math.PI * 2);
				ctx!.fill();
			}
			ctx!.globalAlpha = 1;
		}

		// FEVER 解除の落差：一瞬暗く沈んで「FEVER END」
		if (feverDropT > 0 && state !== 'over') {
			ctx!.save();
			ctx!.globalAlpha = 0.28 * feverDropT;
			ctx!.fillStyle = '#000';
			ctx!.fillRect(-20, -20, W + 40, H + 40);
			ctx!.restore();
		}
		// FEVER の終わり：「ここまで行けた」を 0.7 秒残す（MISS＝FEVER END、時間切れ＝FEVER CLEAR!）
		if (feverSummaryT > 0 && feverSummary && state !== 'over') {
			const fs = feverSummary;
			const y0 = labelY() + m * 0.19; // 判定ラベルとその下の一言の、さらに下（重ならない）
			ctx!.save();
			ctx!.globalAlpha = Math.min(1, feverSummaryT * 1.8) * 0.92;
			centeredText(fs.reason === 'miss' ? 'FEVER END' : 'FEVER CLEAR!', cx, y0, m * 0.048, fs.reason === 'miss' ? col.chalk : col.yellow, 700);
			const parts = [`STREAK ${fs.streak}`];
			if (fs.chaos > 0) parts.push(`⚡ CHAOS PERFECT ×${fs.chaos}`);
			centeredText(parts.join(' · '), cx, y0 + m * 0.06, m * 0.036, col.chalk, 600);
			ctx!.restore();
		}
		// 最初の CHAOS チャンス：1度だけ説明（的が電撃で光ったら PERFECT で ⚡）
		if (chaosHintT > 0 && state !== 'over') {
			ctx!.save();
			ctx!.globalAlpha = Math.min(1, chaosHintT * 2.5);
			fitText('⚡ CHAOS チャンス！', cx, H * 0.8, m * 0.05, '#7FE3F0', 800);
			fitText('的が電撃で光ったら PERFECT を狙え', cx, H * 0.8 + m * 0.065, m * 0.036, '#E8FBFF', 700);
			ctx!.restore();
		}

		// コンボ／フィーバー表示（上部）
		if (state !== 'over') {
			ctx!.textAlign = 'center';
			ctx!.textBaseline = 'top';
			if (fever && entryP > 0.6) {
				// FEVER 常駐表示：虹色の見出し＋「×2 SCORE · FEVER ×N」＋残り時間ゲージ
				const s2 = 1 + 0.12 * beatPulse();
				ctx!.fillStyle = rainbowAt(gameTime);
				ctx!.font = `700 ${Math.round(m * 0.08 * s2)}px "Klee One", sans-serif`;
				ctx!.fillText('🔥 CHAOS FEVER 🔥', cx, H * 0.04);
				ctx!.fillStyle = col.chalk;
				ctx!.font = `600 ${Math.round(m * 0.038)}px "Klee One", sans-serif`;
				// STREAK は倍率ではなく「FEVER 中に何回つないだか」（得点倍率は ×2 のまま）
				const streak = feverStreak > 0 ? ` · STREAK ${feverStreak}` : '';
				ctx!.fillText(`×${FEVER_MULT} SCORE${streak}`, cx, H * 0.04 + m * 0.095);
				const gw = m * 0.4;
				const gy = H * 0.04 + m * 0.15;
				ctx!.globalAlpha = 0.35;
				ctx!.fillStyle = col.chalk;
				ctx!.fillRect(cx - gw / 2, gy, gw, 4);
				ctx!.globalAlpha = 1;
				ctx!.fillStyle = rainbowAt(gameTime, 1);
				ctx!.fillRect(cx - gw / 2, gy, gw * Math.max(0, feverT / FEVER_TIME), 4);
			} else if (!fever && (combo >= 2 || perfectStreak === FEVER_STREAK - 1)) {
				// 上部の COMBO 表示。節目（3/5/10）では一瞬大きく黄色に＋「♪ BASS IN ×1.2」（曲の層が増えることを目でも）
				const ms = milestoneT > 0 && feverEntryT === 0 ? milestoneT : 0;
				ctx!.fillStyle = ms > 0 ? col.yellow : col.pink;
				ctx!.font = `700 ${Math.round(m * 0.07 * (1 + 0.35 * ms))}px "Klee One", sans-serif`;
				ctx!.fillText(`${combo} COMBO`, cx, H * 0.05);
				const subY = H * 0.05 + m * (0.085 + 0.025 * ms);
				ctx!.font = `600 ${Math.round(m * 0.038)}px "Klee One", sans-serif`;
				if (ms > 0 && milestoneLabel) {
					ctx!.globalAlpha = Math.min(1, ms * 1.6);
					ctx!.fillStyle = col.yellow;
					ctx!.fillText(milestoneLabel, cx, subY);
					ctx!.globalAlpha = 1;
				} else if (perfectStreak === FEVER_STREAK - 1) {
					// PERFECT 2連：次の1打が FEVER（3打目の緊張感）。拍で脈打つ
					ctx!.fillStyle = col.yellow;
					ctx!.font = `700 ${Math.round(m * 0.042 * (1 + 0.1 * beatPulse()))}px "Klee One", sans-serif`;
					ctx!.fillText('NEXT PERFECT → 🔥 CHAOS FEVER', cx, subY);
				} else {
					// 次のコンボ節目が近いときだけ小さく予告（常時は出さない）
					const next = combo < 3 ? 3 : combo < 5 ? 5 : combo < 10 ? 10 : 0;
					if (next && next - combo <= 2) {
						ctx!.globalAlpha = 0.75;
						ctx!.fillStyle = col.chalk;
						ctx!.fillText(`NEXT ${next} → ${LAYER_OF[next]} IN`, cx, subY);
						ctx!.globalAlpha = 1;
					}
				}
			}
			ctx!.textAlign = 'start';
			ctx!.textBaseline = 'alphabetic';
		}

		// セクション名（小節頭で一瞬。下端に小さく出して1秒でフェード）
		if (sectionFlashT > 0 && sectionIdx >= 0 && state !== 'over') {
			const sec = song.sections[sectionIdx];
			const isFinal = hasFinalCount && sectionIdx === finalIdx;
			ctx!.save();
			ctx!.globalAlpha = Math.min(1, sectionFlashT * 1.5);
			centeredText(isFinal ? `${sec.label} ${FINAL_COUNT}` : sec.label, cx, H * 0.9, m * (isFinal ? 0.07 : 0.05), isFinal ? col.yellow : col.chalk);
			ctx!.restore();
		}

		// 曲の終わり：FINISH!（ポップして残る）。FEVER のまま終わったら虹色でいちばん派手に
		if (state === 'over' && finishT >= 0 && started) {
			const pop = 1 + (feverFinish ? 0.9 : 0.5) * finishT;
			ctx!.save();
			ctx!.globalAlpha = 0.95;
			centeredText(
				feverFinish ? 'FINISH!!' : 'FINISH!',
				cx,
				cy,
				m * (feverFinish ? 0.17 : 0.14) * pop,
				feverFinish ? rainbowAt(gameTime * 2) : col.yellow,
			);
			if (feverFinish) centeredText('CHAOS FEVER FINISH', cx, cy + m * 0.15, m * 0.045, col.chalk, 600);
			ctx!.restore();
		}

		// FEVER 突入フラッシュ（最前面・最初の約0.2秒だけ。以降は的がはっきり見える）
		if (fever && feverEntryT > 0 && entryP < 0.3) {
			ctx!.globalAlpha = FX.ENTRY_FLASH_ALPHA * (1 - entryP / 0.3) * flashMult();
			ctx!.fillStyle = entryP < 0.12 ? '#ffffff' : col.yellow;
			ctx!.fillRect(-20, -20, W + 40, H + 40);
			ctx!.globalAlpha = 1;
		}

		ctx!.restore(); // カメラ（ズーム・シェイク）を戻す
		if (options.debugInfo) drawDebug();
	}

	/** ?debug=1：拍グリッドの同期確認。左上に曲・BPM・拍番号・transport 時刻、拍頭で光るメトロノーム四角（曲のキックと見比べる） */
	function drawDebug() {
		const beatNo = Math.floor(gameTime / BEAT + 1e-9);
		const lines = [
			`Song: ${song.id}  BPM: ${song.bpm}`,
			`beat: ${beatNo}  phase: ${grid.beatPhase(gameTime).toFixed(2)}`,
			`transport: ${gameTime.toFixed(3)}`,
			...(target ? [`next hit: beat ${target.hitBeat} @ ${target.hitAt.toFixed(3)}`] : []),
			...(lastJudge ? [`JUDGE ${lastJudge.kind}  beat=${lastJudge.beatMs}ms  pos=${lastJudge.posPx}px  (win P${BEAT_PERFECT_MS}/G${BEAT_GREAT_MS})`] : []),
			...(options.debugInfo?.() ?? []),
			...(lastInput
				? [
						`INPUT ${lastInput.source}  event: ${lastInput.eventMs != null ? (lastInput.eventMs / 1000).toFixed(3) : '-'}  handler: ${(lastInput.handlerMs / 1000).toFixed(3)}`,
						`queue lag: ${lastInput.queueLagMs != null ? lastInput.queueLagMs.toFixed(1) + 'ms' : '-'}  clock: ${lastInput.mode}`,
						`ctx: ${lastInput.contextTime != null ? lastInput.contextTime.toFixed(3) : '-'}  press: ${lastInput.t.toFixed(3)}`,
						`HIT expected: ${lastInput.hitAt.toFixed(3)}  offset: ${lastInput.offsetMs >= 0 ? '+' : ''}${lastInput.offsetMs.toFixed(1)}ms`,
						`(handler時刻なら ${lastInput.handlerOffsetMs >= 0 ? '+' : ''}${lastInput.handlerOffsetMs.toFixed(1)}ms)  phys remainder: ${lastInput.remainderMs.toFixed(2)}ms${lastInput.clampedMs > 0.01 ? `  clamp ${lastInput.clampedMs.toFixed(1)}ms` : ''}`,
					]
				: []),
		];
		ctx!.save();
		ctx!.globalAlpha = 0.85;
		ctx!.font = '12px ui-monospace, monospace';
		const boxW = Math.max(250, ...lines.map((l) => ctx!.measureText(l).width + 14));
		ctx!.fillStyle = 'rgba(0,0,0,0.55)';
		ctx!.fillRect(6, 6, boxW, 16 * lines.length + 10);
		ctx!.fillStyle = '#E8FBFF';
		ctx!.textAlign = 'start';
		ctx!.textBaseline = 'top';
		lines.forEach((l, i) => ctx!.fillText(l, 12, 11 + i * 16));
		// メトロノーム：拍頭で白く光る（4拍目ごとに黄色＝小節頭）
		const ph = grid.beatPhase(gameTime);
		const on = ph < 0.12;
		ctx!.globalAlpha = on ? 1 : 0.25;
		ctx!.fillStyle = beatNo % 4 === 0 ? col.yellow : '#ffffff';
		ctx!.fillRect(W - 34, 8, 26, 26);
		ctx!.restore();
	}

	// --- ループ ---
	let rafId = 0;
	function loop() {
		if (!started) {
			if (W) draw(); // TAP TO START 待ち：静止した振り子だけ描く
			rafId = requestAnimationFrame(loop);
			return;
		}
		// 時計は共通トランスポート（audio）。dt はその差分。
		// dt を小さくクランプすると物理が transport から恒久的に遅れて的を通らなくなるので、0.25秒までは追従する
		// （それ以上＝タブ非表示など。的は寿命切れ→次の的で予測し直すので自然に再同期する）。
		const t = clock();
		const dt = Math.min(Math.max(0, t - lastClock), 0.25);
		lastClock = t;
		gameTime = t;

		if (state === 'countin' || state === 'playing' || state === 'slowmo') {
			// 【リズム整合】的が生きている間の timeScale は必ず 1（速度変更なし）。
			// 固定タイムステップ積分で軌道が毎回同じ離散列になり、予測と完全一致する。
			const ts = state === 'slowmo' ? SLOWMO_SCALE : 1;
			acc += dt * ts;
			let steps = 0;
			while (acc >= FIXED_H && steps < 90) {
				s = rk4(s, FIXED_H);
				acc -= FIXED_H;
				steps++;
			}
			// 押した瞬間が次のフレームより前（イベントの時刻）でも、その時刻の状態から進められるように（timeScale = 1 の間だけ）
			if (state === 'playing') recordPhys();
			const [, , x2, y2] = tips(s);
			trail.push([x2, y2]);
			// FEVER 用に長めに保持し、描画側で通常時は末尾 TRAIL_LEN 点だけ使う
			if (trail.length > FX.TRAIL_LEN * FX.FEVER_TRAIL_MULT) trail.shift();

			if (state === 'countin') {
				// 拍0（gameTime>=0）でゲーム開始（最初の的を出す）
				if (gameTime >= 0) {
					state = 'playing';
					newTarget();
					resultLabel = 'GO!';
					popT = 1;
					$msg.textContent = '「ドン！」でタップ ― 先端が黄色い丸に重なる瞬間';
				}
			} else {
				// フィーバー残り時間（速度は変えず得点2倍＋演出だけ）
				if (fever) {
					feverT -= dt;
					if (feverT <= 0) endFever('timeout');
				}
				if (state === 'slowmo') {
					slowmoT -= dt;
					if (slowmoT <= 0) {
						state = 'playing';
						newTarget();
					}
				} else if (target && gameTime > target.expireAt) {
					expireTarget();
				} else if (!target && waitingForMap) {
					newTarget(); // 手書き譜面のエントリが予測範囲に入るのを待っている
				}
				if (gameTime >= duration) endGame();
				else checkSection();
			}
			updateTime();
		}

		if (flash > 0) flash = Math.max(0, flash - dt * 3);
		if (popT > 0) popT = Math.max(0, popT - dt * 2.4);
		if (milestoneT > 0) milestoneT = Math.max(0, milestoneT - dt * 1.3);
		if (sectionFlashT > 0) sectionFlashT = Math.max(0, sectionFlashT - dt);
		if (feverEntryT > 0) feverEntryT = Math.max(0, feverEntryT - dt / FX.ENTRY_TIME);
		if (feverDropT > 0) feverDropT = Math.max(0, feverDropT - dt / FX.DROP_TIME);
		if (chaosFlashT > 0) chaosFlashT = Math.max(0, chaosFlashT - dt * 2.2);
		if (feverSummaryT > 0) feverSummaryT = Math.max(0, feverSummaryT - dt / 0.7);
		if (chaosHintT > 0) chaosHintT = Math.max(0, chaosHintT - dt / 1.6);
		if (shakeT > 0) shakeT = Math.max(0, shakeT - dt);
		if (scorePop) {
			scorePop.t -= dt * 1.6;
			if (scorePop.t <= 0) scorePop = null;
		}
		if (pendingBursts.length) {
			for (const b of pendingBursts) {
				b.t -= dt;
				// 二段目：少し遅れて外側へ大きく広がる
				if (b.t <= 0) burst(b.x, b.y, true, { mult: FX.FEVER_PARTICLE_MULT, palette: RAINBOW, speed: 1.9 });
			}
			pendingBursts = pendingBursts.filter((b) => b.t > 0);
		}
		if (finishT > 0) finishT = Math.max(0, finishT - dt * 2);
		if (particles.length) {
			for (const p of particles) {
				p.life += dt;
				p.x += p.vx * dt;
				p.y += p.vy * dt;
				p.vy += 560 * dt;
				p.vx *= 1 - 1.1 * dt;
			}
			particles = particles.filter((p) => p.life < p.ttl);
		}

		if (W) draw();
		rafId = requestAnimationFrame(loop);
	}

	resize();
	emit('game_view', undefined);
	// 静止プレビュー用に振り子だけ用意（idle 時に描画される）
	s = [sign() * rand(preset.a1[0], preset.a1[1]), sign() * rand(preset.a2[0], preset.a2[1]), 0, 0];
	if (started) newGame(); // autostart:false のときは TAP TO START で start() を待つ
	rafId = requestAnimationFrame(loop);

	return {
		destroy() {
			cancelAnimationFrame(rafId);
			ro.disconnect();
			cv.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('keydown', onKeyDown);
			rmq?.removeEventListener?.('change', onReducedMotion);
		},
		start(opts = {}) {
			if (opts.difficulty) {
				preset = DIFFICULTY_PRESETS[opts.difficulty];
				TARGET_R = preset.targetR;
			}
			if (!options.now) perfOrigin = performance.now() / 1000;
			if (opts.retry) emit('game_retry', undefined);
			newGame();
		},
	};
}
