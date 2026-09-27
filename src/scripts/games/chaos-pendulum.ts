// CHAOS BEAT — ゲームエンジン（旧「カオス振り子ストップ」を作り替え）
//
// 【重要】物理計算・RK4 数値積分（deriv/rk4/tips）は単一HTML版から変更しない。
// 変えるのはゲーム体験（30秒連続・的の寿命・判定・コンボ・スロー・BPM脈動）だけ。
// 物理そのものを変える場合は明示的な指示が必要。
//
// spec: docs/specs/chaos-beat.md / design: docs/design/chaos-beat.md
// このファイルは Astro / GA4 / 広告 / 音 に依存しない純粋なエンジン。
// 外へは onEvent(name, payload) だけで通知する（送信先はこのファイルの外で決める）。

export type GameEventName =
	| 'game_view'
	| 'game_start'
	| 'hit'
	| 'rhythm_pattern'
	| 'fever_start'
	| 'fever_end'
	| 'game_over'
	| 'game_retry';

/** 判定の種類。得点対象は perfect/great/good のみ（near/miss は 0 点）。 */
export type HitKind = 'perfect' | 'great' | 'good' | 'near' | 'miss';

/** リズム予告の音種（Web Audio 側で鳴らし分ける） */
export type CueSound = 'tick' | 'accent';

/** リズムパターン。予告音（cue）の並びと「入力すべき拍(hitBeat)」を持つ。データ駆動で増やせる。 */
export interface RhythmPattern {
	id: string;
	/** パターンの長さ（拍） */
	lengthBeats: number;
	/** 予告音：パターン先頭からの拍位置（小数=裏拍/細分化）と音種 */
	cues: { beat: number; sound: CueSound }[];
	/** 入力すべき拍（パターン先頭からの拍位置）。ここに先端がターゲットへ来る */
	hitBeat: number;
}

// 初期パターン。極端に複雑にしない（2〜3拍先＋裏拍程度）。
export const RHYTHM_PATTERNS: RhythmPattern[] = [
	// タン タン タン ドン（4拍目で入力）
	{
		id: 'A',
		lengthBeats: 4,
		cues: [
			{ beat: 0, sound: 'tick' },
			{ beat: 1, sound: 'tick' },
			{ beat: 2, sound: 'tick' },
			{ beat: 3, sound: 'accent' },
		],
		hitBeat: 3,
	},
	// タン タン 休 ドン
	{
		id: 'B',
		lengthBeats: 4,
		cues: [
			{ beat: 0, sound: 'tick' },
			{ beat: 1, sound: 'tick' },
			{ beat: 3, sound: 'accent' },
		],
		hitBeat: 3,
	},
	// タン ・タタ・ ドン（裏拍入り、2.5拍目で入力）
	{
		id: 'C',
		lengthBeats: 3,
		cues: [
			{ beat: 0, sound: 'tick' },
			{ beat: 1, sound: 'tick' },
			{ beat: 1.5, sound: 'tick' },
			{ beat: 2.5, sound: 'accent' },
		],
		hitBeat: 2.5,
	},
	// タン 休 タン ドン
	{
		id: 'D',
		lengthBeats: 4,
		cues: [
			{ beat: 0, sound: 'tick' },
			{ beat: 2, sound: 'tick' },
			{ beat: 3, sound: 'accent' },
		],
		hitBeat: 3,
	},
];
const PATTERN_BY_ID: Record<string, RhythmPattern> = Object.fromEntries(
	RHYTHM_PATTERNS.map((p) => [p.id, p]),
);

/** 譜面シーケンス。pattern を順番に消化する（完全ランダムをやめ「繰り返し→崩し」で覚えやすく）。 */
export interface RhythmSequence {
	id: string;
	patterns: string[];
}
// やさしい（A/B中心・裏拍なし）と、全体（C/D入り）を分ける。序盤はやさしい方だけ使う。
export const EASY_SEQUENCES: RhythmSequence[] = [
	{ id: 'e1', patterns: ['A', 'A', 'B', 'A'] },
	{ id: 'e2', patterns: ['A', 'A', 'A', 'B'] },
	{ id: 'e3', patterns: ['A', 'B', 'A', 'B'] },
];
export const RHYTHM_SEQUENCES: RhythmSequence[] = [
	...EASY_SEQUENCES,
	{ id: 's1', patterns: ['A', 'A', 'C', 'A'] },
	{ id: 's2', patterns: ['A', 'B', 'A', 'D'] },
	{ id: 's3', patterns: ['B', 'A', 'C', 'A'] },
	{ id: 's4', patterns: ['A', 'C', 'B', 'D'] },
];

/** 難易度。カオス（激しい挙動）は全段維持し、差は主に的の大きさ（鬼だけ速度UP）。 */
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
		/** 予定入力時刻とのズレ（ms）。負=早押し／正=遅押し */
		timingOffsetMs: number;
	};
	/** リズム予告のスケジュール。cues/hit の offset は「今から何秒後」（実時間） */
	rhythm_pattern: {
		patternId: string;
		hitOffset: number;
		cues: { offset: number; sound: CueSound }[];
	};
	fever_start: undefined;
	fever_end: undefined;
	game_over: { score: number; maxCombo: number; hits: number; perfectCount: number };
	game_retry: undefined;
}

export interface GameElements {
	/** 合計スコアの表示先 */
	score: HTMLElement;
	/** 現在コンボの表示先 */
	combo: HTMLElement;
	/** 残り時間バー（width % を設定する内側要素） */
	time: HTMLElement;
	/** 判定の詳細（+240 / あと6px！ など）の表示先 */
	msg: HTMLElement;
}

export interface InitGameOptions {
	canvas: HTMLCanvasElement;
	elements: GameElements;
	difficulty?: Difficulty;
	onEvent?: <K extends GameEventName>(name: K, payload: GameEventPayloads[K]) => void;
}

export interface GameHandle {
	destroy(): void;
	/** 難易度を切り替えて最初から遊び直す */
	setDifficulty(level: Difficulty): void;
	/** 同じ難易度のまま最初から（即リトライ） */
	restart(): void;
}

type Vec = number[];

export function initGame(options: InitGameOptions): GameHandle {
	// --- ルール定数 ---
	const GAME_TIME = 30; // 1ゲームの尺（秒・固定）
	const BPM = 130;
	const BEAT = 60 / BPM;
	const SLOWMO_TIME = 0.2; // 叩いた後のスロー時間（実秒）
	const SLOWMO_SCALE = 0.15; // スロー中の物理倍率
	const FEVER_STREAK = 3; // PERFECT 連続でフィーバー発火
	const FEVER_TIME = 5; // フィーバー継続（実秒）
	const FEVER_MULT = 2; // フィーバー中の得点倍率（速度は変えない＝リズム整合のため）

	const g = 9.81,
		L1 = 1,
		L2 = 1,
		m1 = 1,
		m2 = 1;

	let preset: DifficultyPreset = DIFFICULTY_PRESETS[options.difficulty ?? 'normal'];
	let TARGET_R = preset.targetR;

	const cv = options.canvas;
	const ctx = cv.getContext('2d');
	if (!ctx) throw new Error('2D context is not available');
	const $score = options.elements.score;
	const $combo = options.elements.combo;
	const $time = options.elements.time;
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
		/** 入力すべき時刻（gameTime）。先端がここでターゲットへ来る＝拍に一致 */
		hitAt: number;
		/** この時刻を過ぎたら見逃し */
		expireAt: number;
	}
	let s: Vec; // [θ1, θ2, ω1, ω2]
	let trail: [number, number][] = [];
	let target: Target;
	let state: 'playing' | 'slowmo' | 'over' = 'playing';
	let gameTime = 0; // 経過（実秒）
	let slowmoT = 0;
	let acc = 0; // 固定タイムステップ用の時間アキュムレータ
	let score = 0;
	let combo = 0;
	let maxCombo = 0;
	let hits = 0;
	let perfectCount = 0;
	let perfectStreak = 0;
	let fever = false;
	let feverT = 0;
	// 譜面シーケンス（1つを順番に消化 → 別のを選ぶ。直前と同じは選ばない。序盤はやさしい方だけ）
	let curSeq: RhythmSequence | null = null;
	let seqIdx = 0;
	let lastSeqId = '';
	function pickSequence(): RhythmSequence {
		const pool = hits < 6 ? EASY_SEQUENCES : RHYTHM_SEQUENCES;
		let pick = pool[(Math.random() * pool.length) | 0];
		let guard = 0;
		while (pool.length > 1 && pick.id === lastSeqId && guard++ < 8) {
			pick = pool[(Math.random() * pool.length) | 0];
		}
		lastSeqId = pick.id;
		return pick;
	}
	function nextPattern(): RhythmPattern {
		if (!curSeq || seqIdx >= curSeq.patterns.length) {
			curSeq = pickSequence();
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
	function burst(px: number, py: number, big: boolean) {
		const n = big ? 40 : 16;
		const speed = big ? 340 : 210;
		const palette = big ? [col.yellow, col.pink, col.chalk, col.blue] : [col.chalk, col.blue];
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
	const PRED_SAMPLE = 4; // 何ステップごとに軌道点を記録するか
	const PRED_DT = FIXED_H * PRED_SAMPLE; // 記録点どうしの物理時間間隔

	// これから先端が通る軌道（固定ステップで予測 → 実機と一致）。カオスなので horizon は短め。
	function predictPath(): [number, number][] {
		let sim = s.slice();
		const path: [number, number][] = [];
		const totalSteps = Math.round(2.6 / FIXED_H); // リズム量子化で最大~2.3秒先まで使うので広めに
		for (let i = 1; i <= totalSteps; i++) {
			sim = rk4(sim, FIXED_H);
			if (i % PRED_SAMPLE === 0) {
				const [, , x2, y2] = tips(sim);
				path.push([x2, y2]);
			}
		}
		return path;
	}

	// 的は「リズムパターンの入力拍」に対応する未来軌道点へ置く。
	// = 音（タン・タン・ドン）でタイミングが分かり、振り子を見て微調整すると PERFECT。
	function newTarget() {
		const path = predictPath();
		const maxT = path.length * PRED_DT;

		// パターンは譜面シーケンスから順番に取り、先頭を「次の拍」に合わせる（beat grid と同期）。
		const pat = nextPattern();
		const nextBeatIn = BEAT - (gameTime % BEAT); // 次の拍まで（秒）
		const patternStart = gameTime + nextBeatIn; // パターン先頭の時刻（拍の頭）
		let hitAt = patternStart + pat.hitBeat * BEAT; // 入力すべき時刻
		// 予測範囲を超えない・最低限の反応猶予を確保
		while (hitAt - gameTime > maxT) hitAt -= BEAT;
		while (hitAt - gameTime < 0.5) hitAt += BEAT;

		const timeUntilHit = hitAt - gameTime;
		const idx = Math.min(path.length - 1, Math.max(0, Math.round(timeUntilHit / PRED_DT) - 1));
		const [tx, ty] = path[idx] ?? [tips(s)[2], tips(s)[3]];
		target = {
			x: tx,
			y: ty,
			r: TARGET_R,
			bornAt: gameTime,
			hitAt,
			expireAt: hitAt + BEAT * 1.2, // 入力拍＋約1.2拍で見逃し
		};

		// 予告音のスケジュール（今から何秒後か）。パターン先頭に満たない cue は捨てる。
		const cues = pat.cues
			.map((c) => ({ offset: patternStart + c.beat * BEAT - gameTime, sound: c.sound }))
			.filter((c) => c.offset >= 0 && c.offset <= timeUntilHit + 0.05);
		emit('rhythm_pattern', { patternId: pat.id, hitOffset: timeUntilHit, cues });
	}

	function newGame() {
		s = [sign() * rand(preset.a1[0], preset.a1[1]), sign() * rand(preset.a2[0], preset.a2[1]), 0, 0];
		trail = [];
		gameTime = 0;
		slowmoT = 0;
		acc = 0;
		score = 0;
		combo = 0;
		maxCombo = 0;
		hits = 0;
		perfectCount = 0;
		perfectStreak = 0;
		fever = false;
		feverT = 0;
		curSeq = null;
		seqIdx = 0;
		lastSeqId = '';
		flash = 0;
		popT = 0;
		resultLabel = '';
		lastHit = null;
		milestoneLabel = '';
		milestoneT = 0;
		particles = [];
		state = 'playing';
		newTarget();
		updateHUD();
		$msg.textContent = '拍に合わせて、先端を黄色い丸で叩け！';
		emit('game_start', undefined);
	}

	function updateHUD() {
		$score.textContent = String(score);
		$combo.textContent = String(combo);
		$time.style.width = Math.max(0, 1 - gameTime / GAME_TIME) * 100 + '%';
	}

	function startFever() {
		fever = true;
		feverT = FEVER_TIME;
		emit('fever_start', undefined);
	}
	function endFever() {
		if (!fever) return;
		fever = false;
		feverT = 0;
		emit('fever_end', undefined);
	}

	/** プレイヤーが叩いた（state==='playing' のときだけ呼ばれる） */
	function hit() {
		const [, , x2, y2] = tips(s);
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
		if (kind === 'perfect') {
			perfectStreak++;
			if (perfectStreak >= FEVER_STREAK && !fever) startFever();
		} else {
			perfectStreak = 0;
			if (!scoring) endFever();
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

		const nearMissPx = kind === 'near' ? Math.round((d - R) * scale) : 0;
		// 予定入力時刻（拍）とのズレ。負=早押し／正=遅押し。
		const timingOffsetMs = Math.round((gameTime - target.hitAt) * 1000);
		lastHit = { d, kind };
		resultLabel = LABEL[kind];
		popT = 1;
		flash = scoring ? 1 : 0.5;
		if (scoring) {
			const [tx, ty] = P(x2, y2);
			burst(tx, ty, kind === 'perfect');
			if (kind === 'perfect') {
				const [gx, gy] = P(target.x, target.y);
				burst(gx, gy, true);
			}
			$msg.textContent = mult > 1 ? `+${add}（×${mult}）` : `+${add}`;
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
		});

		// 叩いたら必ずスロー → 次の的
		state = 'slowmo';
		slowmoT = SLOWMO_TIME;
	}

	/** 寿命切れ（見逃し）。スローは挟まず即次。 */
	function expireTarget() {
		combo = 0;
		perfectStreak = 0;
		endFever();
		hits++;
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
		});
		newTarget();
	}

	function endGame() {
		state = 'over';
		resultLabel = '';
		$msg.textContent = `TIME UP！ ${score}点・最大${maxCombo}コンボ`;
		emit('game_over', { score, maxCombo, hits, perfectCount });
	}

	// --- 入力 ---
	function act() {
		if (state !== 'playing') return; // slowmo/over 中はロック
		hit();
	}
	const onActClick = () => act();
	const onPointerDown = (e: PointerEvent) => {
		e.preventDefault();
		act();
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.code === 'Space' || e.code === 'Enter') {
			e.preventDefault();
			act();
		}
	};
	cv.addEventListener('pointerdown', onPointerDown);
	window.addEventListener('keydown', onKeyDown);

	// --- 描画 ---
	function beatPulse(): number {
		const phase = (gameTime % BEAT) / BEAT; // 0→1
		return Math.max(0, 1 - phase * 1.6); // 拍頭で1、すぐ減衰
	}

	function draw() {
		ctx!.clearRect(0, 0, W, H);
		ctx!.lineCap = 'round';
		ctx!.lineJoin = 'round';

		// CHAOS FEVER：ピンクの縁が拍で明滅
		if (fever && state !== 'over') {
			const pulse = beatPulse();
			ctx!.globalAlpha = 0.1 + 0.12 * pulse;
			ctx!.fillStyle = col.pink;
			ctx!.fillRect(0, 0, W, H);
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

		// ターゲット＋アプローチリング（入力拍に向けて外側の輪が縮んで重なる＝押す瞬間が目で分かる）
		if (state !== 'over') {
			const [tx, ty] = P(target.x, target.y);
			const remain = target.expireAt - gameTime;
			const baseR = target.r * scale;

			// アプローチリング：bornAt→hitAt で大きな輪が的の大きさへ収束する（重なった時が入力拍）
			const lead = Math.max(0.001, target.hitAt - target.bornAt);
			const prog = Math.min(1.3, Math.max(0, (gameTime - target.bornAt) / lead));
			if (prog < 1.25) {
				const approachR = baseR * (1 + 2.6 * Math.max(0, 1 - prog));
				ctx!.globalAlpha = 0.2 + 0.55 * Math.min(1, prog);
				ctx!.strokeStyle = col.blue;
				ctx!.lineWidth = 2;
				ctx!.beginPath();
				ctx!.arc(tx, ty, approachR, 0, Math.PI * 2);
				ctx!.stroke();
			}

			// 的本体（入力拍が近いほど明るく＋拍で脈動）
			const near = Math.min(1, prog); // 0→1
			const rDraw = baseR * (1 + 0.18 * beatPulse());
			ctx!.globalAlpha = (0.4 + 0.6 * near) * Math.min(1, remain / 0.5);
			ctx!.strokeStyle = col.yellow;
			ctx!.lineWidth = 2.5 + (1.5 + 2 * near) * beatPulse();
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

		// 軌跡
		for (let i = 1; i < trail.length; i++) {
			ctx!.strokeStyle = col.pink;
			ctx!.globalAlpha = (i / trail.length) * 0.8;
			ctx!.lineWidth = 2;
			ctx!.beginPath();
			ctx!.moveTo(...P(trail[i - 1][0], trail[i - 1][1]));
			ctx!.lineTo(...P(trail[i][0], trail[i][1]));
			ctx!.stroke();
		}
		ctx!.globalAlpha = 1;

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
		if (state === 'slowmo' && lastHit && lastHit.kind !== 'miss') {
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

		// フラッシュ
		if (flash > 0) {
			ctx!.globalAlpha = flash * 0.32;
			ctx!.fillStyle = resultLabel === 'PERFECT' ? col.yellow : col.chalk;
			ctx!.fillRect(0, 0, W, H);
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

		// コンボ／フィーバー表示（上部）
		if (state !== 'over') {
			ctx!.textAlign = 'center';
			ctx!.textBaseline = 'top';
			if (fever) {
				const s2 = 1 + 0.12 * beatPulse();
				ctx!.fillStyle = col.yellow;
				ctx!.font = `600 ${Math.round(Math.min(W, H) * 0.08 * s2)}px "Klee One", sans-serif`;
				ctx!.fillText('🔥 CHAOS FEVER 🔥', cx, H * 0.04);
			} else if (combo >= 2) {
				ctx!.fillStyle = col.pink;
				ctx!.font = `600 ${Math.round(Math.min(W, H) * 0.07)}px "Klee One", sans-serif`;
				ctx!.fillText(`${combo} COMBO`, cx, H * 0.05);
				// 次の倍率まであと1回のときだけ緊張感を出す
				const next = combo < 3 ? 3 : combo < 5 ? 5 : combo < 10 ? 10 : 0;
				const nextMult = next === 3 ? 1.2 : next === 5 ? 1.5 : next === 10 ? 2.0 : 0;
				if (next && next - combo === 1) {
					ctx!.fillStyle = col.yellow;
					ctx!.font = `600 ${Math.round(Math.min(W, H) * 0.038)}px "Klee One", sans-serif`;
					ctx!.fillText(`あと1回で ×${nextMult}`, cx, H * 0.05 + Math.min(W, H) * 0.08);
				}
			}
			// コンボ節目のポップ（中央上）
			if (milestoneT > 0 && milestoneLabel) {
				ctx!.globalAlpha = Math.min(1, milestoneT * 1.4);
				ctx!.fillStyle = col.yellow;
				ctx!.font = `600 ${Math.round(Math.min(W, H) * 0.06 * (1 + (1 - milestoneT) * 0.3))}px "Klee One", sans-serif`;
				ctx!.fillText(milestoneLabel, cx, H * 0.2);
				ctx!.globalAlpha = 1;
			}
			ctx!.textAlign = 'start';
			ctx!.textBaseline = 'alphabetic';
		}

		// 判定ラベル（叩いた直後だけポップ）
		if (resultLabel && (state === 'slowmo' || popT > 0)) {
			const pop = 1 + popT * (resultLabel === 'PERFECT' ? 0.6 : 0.3);
			const baseSize = Math.round(Math.min(W, H) * 0.1);
			ctx!.save();
			ctx!.fillStyle = resultLabel === 'PERFECT' ? col.yellow : resultLabel === 'MISS' ? col.blue : col.chalk;
			ctx!.font = `600 ${Math.round(baseSize * pop)}px "Klee One", sans-serif`;
			ctx!.textAlign = 'center';
			ctx!.textBaseline = 'middle';
			ctx!.fillText(resultLabel, cx, Math.max(H * 0.16, cy - scale * 1.7));
			ctx!.restore();
		}
	}

	// --- ループ ---
	let last = performance.now();
	let rafId = 0;
	function loop(now: number) {
		const dt = Math.min((now - last) / 1000, 1 / 30);
		last = now;

		if (state === 'playing' || state === 'slowmo') {
			// 【リズム整合】的が生きている間の timeScale は必ず 1。
			// フィーバー速度・アシスト・鬼speed で物理を伸縮させると「拍の時刻に先端が到達」が
			// ズレて音と合わなくなるため、速度変更は入れない（スロー演出は的の無い hit 直後だけ）。
			const ts = state === 'slowmo' ? SLOWMO_SCALE : 1;
			// 固定タイムステップで積分（timeScale は「1フレームで進めるステップ数」を変えるだけ）。
			// こうすると軌道が毎回同じ離散列になり、予測（predictPath）と完全一致する。
			acc += dt * ts;
			let steps = 0;
			while (acc >= FIXED_H && steps < 60) {
				s = rk4(s, FIXED_H);
				acc -= FIXED_H;
				steps++;
			}
			const [, , x2, y2] = tips(s);
			trail.push([x2, y2]);
			if (trail.length > 140) trail.shift();

			gameTime += dt; // 30秒は実時間で計る

			// フィーバーの残り時間（速度は変えず、得点2倍＋演出だけ）
			if (fever) {
				feverT -= dt;
				if (feverT <= 0) endFever();
			}

			if (state === 'slowmo') {
				slowmoT -= dt;
				if (slowmoT <= 0) {
					state = 'playing';
					newTarget();
				}
			} else if (gameTime > target.expireAt) {
				expireTarget();
			}

			$time.style.width = Math.max(0, 1 - gameTime / GAME_TIME) * 100 + '%';
			if (gameTime >= GAME_TIME) endGame();
		}

		if (flash > 0) flash = Math.max(0, flash - dt * 3);
		if (popT > 0) popT = Math.max(0, popT - dt * 2.4);
		if (milestoneT > 0) milestoneT = Math.max(0, milestoneT - dt * 1.3);
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
	newGame();
	rafId = requestAnimationFrame(loop);

	return {
		destroy() {
			cancelAnimationFrame(rafId);
			ro.disconnect();
			cv.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('keydown', onKeyDown);
		},
		setDifficulty(level: Difficulty) {
			preset = DIFFICULTY_PRESETS[level];
			TARGET_R = preset.targetR;
			newGame();
		},
		restart() {
			emit('game_retry', undefined);
			newGame();
		},
	};
}
