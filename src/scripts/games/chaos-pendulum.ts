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
// 拍の時刻は beat-grid.ts の beatTime(beatIndex) だけで決め、BGM・cue・hitAt・アプローチリングが同じ拍を見る。

import { SPB, beatPhase, beatTime, nextBeatIndex } from './beat-grid';
import {
	DEFAULT_SONG,
	PATTERN_BY_ID,
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
	};
	/**
	 * リズム予告のスケジュール。時刻は全部 transport 時刻（秒・拍0=0）＝ beatTime(beatIndex)。
	 * audio は startTime + time に予約する（「今から何秒後」の相対値は使わない＝位相がズレない）。
	 */
	rhythm_pattern: {
		patternId: string;
		/** 入力拍の拍番号（小数=裏拍）。target.hitAt = beatTime(hitBeat) */
		hitBeat: number;
		/** 入力拍の transport 時刻（= target.hitAt） */
		hitTime: number;
		cues: { beat: number; time: number; sound: CueSound }[];
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
	const duration = song.duration;
	const finalIdx = song.sections.length - 1;
	// 最後のセクション（FINAL）を5カウントに等分（60秒版は10拍＝2拍ごとに 5→1。最終拍＝終止）
	const FINAL_COUNT = 5;
	const finalStart = sectionStart(song, finalIdx);
	const countStep = (duration - finalStart) / FINAL_COUNT;
	const LAST_HIT_MARGIN = SPB; // 最後の入力拍は終止拍の1拍以上前（終止の拍で押させない）
	const BEAT = SPB; // 1拍の秒数（beat-grid と共通の BPM）
	const SLOWMO_TIME = 0.2; // 叩いた後のスロー時間（実秒）
	const SLOWMO_SCALE = 0.15; // スロー中の物理倍率
	const FEVER_STREAK = 3; // PERFECT 連続でフィーバー発火
	const FEVER_TIME = 5; // フィーバー継続（実秒）
	const FEVER_MULT = 2; // フィーバー中の得点倍率（速度は変えない＝リズム整合のため）

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
		/** 入力すべき時刻（gameTime）= beatTime(hitBeat)。先端がここでターゲットへ来る＝ドン・リング収束と一致 */
		hitAt: number;
		/** この時刻を過ぎたら見逃し */
		expireAt: number;
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
	let scorePop: { text: string; big: boolean; t: number } | null = null;
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
	function nextPattern(sec: GameSection): RhythmPattern {
		if (!curSeq || seqIdx >= curSeq.patterns.length || !sec.sequencePool.includes(curSeq.id)) {
			curSeq = pickSequence(sec);
			seqIdx = 0;
		}
		const pid = curSeq.patterns[seqIdx++];
		return PATTERN_BY_ID[pid] ?? RHYTHM_PATTERNS[0];
	}

	// 演出（表示のみ・物理/スコアに干渉しない）
	let flash = 0;
	let popT = 0;
	let resultLabel = '';
	let lastHit: { d: number; kind: HitKind } | null = null;
	let milestoneLabel = ''; // コンボ節目の演出（×1.2! など）
	let milestoneT = 0;

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
	const MAX_PRESS_LAG = 0.25; // 押した瞬間まで進める上限（秒）。ループの dt 上限と同じ

	/**
	 * 今の状態 s から、実際のゲームと同じ固定ステップ（FIXED_H・同じ rk4）で n ステップ進めた先端位置。
	 * s 自体は変えない（コピーを進める）。サンプリングや補間はしない＝実機が通る離散列そのもの。
	 */
	function tipAfterSteps(n: number): [number, number] {
		let sim = s.slice();
		for (let i = 0; i < n; i++) sim = rk4(sim, FIXED_H);
		const [, , x2, y2] = tips(sim);
		return [x2, y2];
	}
	/**
	 * transport 時刻 t に対応する「現在の s から何ステップ先か」。
	 * s は gameTime − acc の物理時刻にある（acc = 未消化の固定ステップ時間）ので、t − gameTime + acc を FIXED_H で丸める。
	 * 的が生きている間は timeScale = 1 なので、この対応は的の生成から判定まで一定。
	 */
	const stepsUntil = (t: number) => Math.max(0, Math.round((t - gameTime + acc) / FIXED_H));

	// 的は「リズムパターンの入力拍」に対応する未来軌道点へ置く。
	// = 音（タン・タン・ドン）でタイミングが分かり、振り子を見て微調整すると PERFECT。
	function newTarget() {
		const maxT = PRED_HORIZON;

		// パターンは「パターン先頭の拍」が属するセクションの譜面から順番に取り、先頭を次の拍頭に合わせる（beat grid と同期）。
		// 以降、cue・hitAt・リングはすべてこの拍番号から beatTime() で求める（=BGMの拍頭と同じ式）。
		const firstBeat = nextBeatIndex(gameTime);
		const sec = song.sections[sectionIndexAt(song, beatTime(firstBeat))];
		const place = (p: RhythmPattern) => {
			let sb = firstBeat;
			// 予測範囲を超えない・最低限の反応猶予を確保（ずらすときはパターンごと拍単位＝ドンと hitAt が離れない）
			while (sb > 0 && beatTime(sb + p.hitBeat) - gameTime > maxT) sb--;
			while (beatTime(sb + p.hitBeat) - gameTime < 0.5) sb++;
			return sb;
		};
		const lastHitTime = duration - LAST_HIT_MARGIN;
		let pat = nextPattern(sec);
		let startBeat = place(pat);
		if (beatTime(startBeat + pat.hitBeat) > lastHitTime) {
			// 曲の終わりに収まらない：入力拍が一番遅い「収まるパターン」に差し替え。無ければ的なし（終止を待つ）
			const fit = [...RHYTHM_PATTERNS]
				.sort((x, y) => y.hitBeat - x.hitBeat)
				.find((p) => beatTime(place(p) + p.hitBeat) <= lastHitTime);
			if (!fit) {
				target = null;
				return;
			}
			pat = fit;
			startBeat = place(pat);
		}
		const hitBeat = startBeat + pat.hitBeat;
		const hitAt = beatTime(hitBeat); // 入力すべき時刻（transport 時刻）

		// 的の中心＝hitAt の時刻に実際の物理が通る点。hitAt まで同じ固定ステップ列で直接積分して求める
		// （以前の「13ms 間隔でサンプルした軌道から最寄り点」だと ±2 ステップ≒±7ms の量子化誤差が出て、小さい的ほど目立った）。
		const [tx, ty] = tipAfterSteps(stepsUntil(hitAt));
		target = {
			x: tx,
			y: ty,
			r: TARGET_R * sec.targetScale, // セクションで的の大きさを少し変える（INTRO は大きめ）
			bornAt: gameTime,
			hitBeat,
			hitAt,
			expireAt: hitAt + BEAT * 1.2, // 入力拍＋約1.2拍で見逃し
		};

		// 予告音（transport 時刻で渡す）。既に過ぎた cue と入力拍より後の cue は捨てる。
		const cues = pat.cues
			.map((c) => ({ beat: startBeat + c.beat, time: beatTime(startBeat + c.beat), sound: c.sound }))
			.filter((c) => c.time >= gameTime && c.beat <= hitBeat);
		emit('rhythm_pattern', { patternId: pat.id, hitBeat, hitTime: hitAt, cues });
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
		if ($timeText) $timeText.textContent = String(Math.max(0, Math.ceil(duration - played - 1e-6)));
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
		if (reason !== 'finish') feverDropT = 1; // 一瞬で静かになる落差（虹・太い軌跡が消え、暗く沈む）
		emit('fever_end', { reason, duration: Math.round(dur * 10) / 10, hits: feverStreak });
	}

	/** プレイヤーが叩いた（state==='playing' のときだけ呼ばれる） */
	function hit() {
		if (!target) return;
		// 押した瞬間の transport 時刻。判定は「最後に描いたフレームの物理状態」ではなく、その状態から同じ固定ステップ列で
		// 押した瞬間まで進めた先端で行う（s は変えない）。以前は最大 1 フレーム＋acc（60fps で ~20ms）遅れた位置で判定しており、
		// 的の中心がちょうど拍に来ていても「まだ届いていない」側にズレ、小さい的（難しい・鬼）ほど PERFECT を外していた。
		const pressT = Math.max(gameTime, Math.min(clock(), gameTime + MAX_PRESS_LAG));
		const [x2, y2] = tipAfterSteps(stepsUntil(pressT));
		const d = Math.hypot(x2 - target.x, y2 - target.y);
		const R = target.r;
		let kind: HitKind;
		if (d <= 0.35 * R) kind = 'perfect';
		else if (d <= 0.7 * R) kind = 'great';
		else if (d <= R) kind = 'good';
		else if (d <= 1.25 * R) kind = 'near';
		else kind = 'miss';
		// 中央を狙う意味を強くするため、判定ごとに点差を広げる（内部100点満点は維持）。
		const nd = d / R;
		let pts: number;
		if (kind === 'perfect') pts = Math.round(90 + 10 * (1 - nd / 0.35)); // 90〜100
		else if (kind === 'great') pts = Math.round(70 + 20 * (1 - (nd - 0.35) / 0.35)); // 70〜90
		else if (kind === 'good') pts = Math.round(40 + 30 * (1 - (nd - 0.7) / 0.3)); // 40〜70
		else pts = 0;
		pts = Math.max(0, Math.min(100, pts));

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
			const layer = combo === 3 ? ' ♪BASS' : combo === 5 ? ' ♪HAT' : ' ♪MELODY';
			milestoneLabel = `${combo} COMBO ×${mult}!${layer}`;
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

		const nearMissPx = kind === 'near' ? Math.round((d - R) * scale) : 0;
		// 予定入力時刻（拍）とのズレ。負=早押し／正=遅押し。
		const timingOffsetMs = Math.round((pressT - target.hitAt) * 1000);
		counts[kind]++;
		pressCount++;
		sumAbsOffsetMs += Math.abs(timingOffsetMs);
		sumOffsetMs += timingOffsetMs;
		lastHit = { d, kind };
		resultLabel = LABEL[kind];
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
			if (fever) scorePop = { text: `+${add}`, big: kind === 'perfect', t: 1 };
			$msg.textContent = fever
				? `+${add}（×${mult}・FEVER ×${FEVER_MULT}）`
				: mult > 1
					? `+${add}（×${mult}）`
					: `+${add}`;
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
		});

		// 叩いたら必ずスロー → 次の的
		state = 'slowmo';
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
		});
	}

	// --- 入力 ---
	function act() {
		if (state !== 'playing' || !target) return; // slowmo/over 中・曲の終わり（的なし）はロック
		hit();
	}
	const onActClick = () => act();
	const onPointerDown = (e: PointerEvent) => {
		e.preventDefault();
		act();
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.code !== 'Space' && e.code !== 'Enter') return;
		// 文字入力中（ニックネーム欄など）は奪わない
		const el = e.target as HTMLElement | null;
		if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
		// ゲーム進行中だけキーを奪う。開始前・終了後はページのボタン（▶ PLAY・もう一回 等）の本来の Space/Enter を妨げない
		if (state !== 'countin' && state !== 'playing' && state !== 'slowmo') return;
		e.preventDefault();
		act();
	};
	cv.addEventListener('pointerdown', onPointerDown);
	window.addEventListener('keydown', onKeyDown);

	// --- 描画 ---
	function beatPulse(): number {
		const phase = beatPhase(gameTime); // 0→1（BGM の拍頭で 0）
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
	/** 判定ラベルの高さ。FEVER 中は上部の FEVER 見出し・ゲージと重ならないよう少し下げる */
	const labelY = () => Math.max(H * 0.16, cy - scale * 1.7) + (fever ? Math.min(W, H) * 0.12 : 0);

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
		const inFinal = live && sectionIdx === finalIdx;
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
			const feverPerfect = fever && resultLabel === 'PERFECT';
			const pop = 1 + popT * (feverPerfect ? 0.8 : resultLabel === 'PERFECT' ? 0.6 : 0.3);
			const baseSize = m * (feverPerfect ? 0.12 : 0.1);
			const ly = labelY();
			ctx!.save();
			const color = feverPerfect
				? rainbowAt(gameTime * 2)
				: resultLabel === 'PERFECT'
					? col.yellow
					: resultLabel === 'MISS'
						? col.blue
						: col.chalk;
			centeredText(resultLabel, cx, ly, baseSize * pop, color, 600);
			ctx!.restore();
		}
		if (scorePop && state !== 'over' && feverEntryT === 0) {
			// 表示する点数は ×2 適用後の加算値。下に「FEVER ×2」と添える
			const k = Math.max(0, scorePop.t);
			const size = m * (scorePop.big ? 0.11 : 0.065) * (1 + 0.4 * k);
			const ly = labelY() + m * (scorePop.big ? 0.13 : 0.1);
			ctx!.save();
			ctx!.globalAlpha = Math.min(1, k * 2);
			centeredText(scorePop.text, cx, ly, size, scorePop.big ? col.yellow : col.chalk);
			centeredText(`FEVER ×${FEVER_MULT}`, cx, ly + size * 0.62, size * 0.32, col.chalk, 600);
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

			// アプローチリング：bornAt→hitAt で大きな輪が的の大きさへ収束する（重なった時が入力拍＝beatTime(hitBeat)＝ドン）
			const lead = Math.max(0.001, target.hitAt - target.bornAt);
			const prog = Math.min(1.3, Math.max(0, (gameTime - target.bornAt) / lead));
			if (prog < 1.25) {
				const approachR = baseR * (1 + 2.6 * Math.max(0, 1 - prog));
				ctx!.globalAlpha = 0.2 + 0.55 * Math.min(1, prog) + (fever ? 0.15 : 0);
				ctx!.strokeStyle = ringCol;
				ctx!.lineWidth = fever ? 3 : 2;
				ctx!.beginPath();
				ctx!.arc(tx, ty, approachR, 0, Math.PI * 2);
				ctx!.stroke();
			}

			// 的本体（入力拍が近いほど明るく＋拍で脈動）
			const near = Math.min(1, prog); // 0→1
			const rDraw = baseR * (1 + 0.18 * beatPulse());
			ctx!.globalAlpha = (0.4 + 0.6 * near) * Math.min(1, remain / 0.5);
			ctx!.strokeStyle = targetCol;
			ctx!.lineWidth = 2.5 + (1.5 + 2 * near) * beatPulse() + (fever ? 1 : 0);
			ctx!.setLineDash([6, 6]);
			ctx!.beginPath();
			ctx!.arc(tx, ty, rDraw, 0, Math.PI * 2);
			ctx!.stroke();
			ctx!.setLineDash([]);
			ctx!.beginPath();
			ctx!.moveTo(tx - 6, ty);
			ctx!.lineTo(tx + 6, ty);
			ctx!.moveTo(tx, ty - 6);
			ctx!.lineTo(tx, ty + 6);
			ctx!.stroke();
			ctx!.globalAlpha = 1;
		}

		// 軌跡。FEVER 中は約1.8倍の長さ・太く・濃く、pink → yellow → cyan のグラデーション。
		// 描画コール数を抑えるため TRAIL_CHUNKS 区間にまとめて stroke する。
		{
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
					ctx!.lineWidth = 2 + 3 * k;
				} else {
					ctx!.strokeStyle = col.pink;
					ctx!.globalAlpha = k * 0.8;
					ctx!.lineWidth = 2;
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
			ctx!.globalAlpha = Math.min(1, feverDropT * 1.5) * 0.85;
			centeredText('FEVER END', cx, labelY() + m * 0.1, m * 0.045, col.chalk, 600);
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
				const streak = feverStreak > 0 ? ` · FEVER ×${feverStreak}` : '';
				ctx!.fillText(`×${FEVER_MULT} SCORE${streak}`, cx, H * 0.04 + m * 0.095);
				const gw = m * 0.4;
				const gy = H * 0.04 + m * 0.15;
				ctx!.globalAlpha = 0.35;
				ctx!.fillStyle = col.chalk;
				ctx!.fillRect(cx - gw / 2, gy, gw, 4);
				ctx!.globalAlpha = 1;
				ctx!.fillStyle = rainbowAt(gameTime, 1);
				ctx!.fillRect(cx - gw / 2, gy, gw * Math.max(0, feverT / FEVER_TIME), 4);
			} else if (!fever && combo >= 2) {
				ctx!.fillStyle = col.pink;
				ctx!.font = `600 ${Math.round(m * 0.07)}px "Klee One", sans-serif`;
				ctx!.fillText(`${combo} COMBO`, cx, H * 0.05);
				// 次の倍率まであと1回のときだけ緊張感を出す
				const next = combo < 3 ? 3 : combo < 5 ? 5 : combo < 10 ? 10 : 0;
				const nextMult = next === 3 ? 1.2 : next === 5 ? 1.5 : next === 10 ? 2.0 : 0;
				if (next && next - combo === 1) {
					ctx!.fillStyle = col.yellow;
					ctx!.font = `600 ${Math.round(m * 0.038)}px "Klee One", sans-serif`;
					ctx!.fillText(`あと1回で ×${nextMult}`, cx, H * 0.05 + m * 0.08);
				}
			}
			// コンボ節目のポップ（中央上）。FEVER 突入の瞬間は突入演出を優先
			if (milestoneT > 0 && milestoneLabel && feverEntryT === 0) {
				ctx!.globalAlpha = Math.min(1, milestoneT * 1.4);
				ctx!.fillStyle = col.yellow;
				ctx!.font = `600 ${Math.round(m * 0.06 * (1 + (1 - milestoneT) * 0.3))}px "Klee One", sans-serif`;
				ctx!.fillText(milestoneLabel, cx, H * 0.2);
				ctx!.globalAlpha = 1;
			}
			ctx!.textAlign = 'start';
			ctx!.textBaseline = 'alphabetic';
		}

		// セクション名（小節頭で一瞬。下端に小さく出して1秒でフェード）
		if (sectionFlashT > 0 && sectionIdx >= 0 && state !== 'over') {
			const sec = song.sections[sectionIdx];
			const isFinal = sectionIdx === finalIdx;
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
