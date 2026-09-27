// CHAOS BEAT — ゲームエンジン（旧「カオス振り子ストップ」を作り替え）
//
// 【重要】物理計算・RK4 数値積分（deriv/rk4/tips）は単一HTML版から変更しない。
// 変えるのはゲーム体験（30秒連続・的の寿命・判定・コンボ・スロー・BPM脈動）だけ。
// 物理そのものを変える場合は明示的な指示が必要。
//
// spec: docs/specs/chaos-beat.md / design: docs/design/chaos-beat.md
// このファイルは Astro / GA4 / 広告 / 音 に依存しない純粋なエンジン。
// 外へは onEvent(name, payload) だけで通知する（送信先はこのファイルの外で決める）。

export type GameEventName = 'game_view' | 'game_start' | 'hit' | 'game_over' | 'game_retry';

/** 判定の種類。得点対象は perfect/great/good のみ（near/miss は 0 点）。 */
export type HitKind = 'perfect' | 'great' | 'good' | 'near' | 'miss';

/** 難易度。カオス（激しい挙動）は全段維持し、差は主に的の大きさ（鬼だけ速度UP）。 */
export type Difficulty = 'easy' | 'normal' | 'hard' | 'oni';

interface DifficultyPreset {
	/** 的の半径（大きいほど易しい） */
	targetR: number;
	/** 振り子の速度倍率（鬼だけ速い。timeScale の基準） */
	speed: number;
	/** θ1 初期角の絶対値レンジ（大きいほど暴れる） */
	a1: [number, number];
	/** θ2 初期角の絶対値レンジ */
	a2: [number, number];
	/** 的を置く距離レンジ（軸からの距離。先端の可動域は最大 2） */
	dist: [number, number];
}

export const DIFFICULTY_PRESETS: Record<Difficulty, DifficultyPreset> = {
	easy: { targetR: 0.55, speed: 1, a1: [1.9, 3.0], a2: [1.6, 3.1], dist: [0.5, 1.4] },
	normal: { targetR: 0.34, speed: 1, a1: [1.9, 3.0], a2: [1.5, 3.1], dist: [0.6, 1.6] },
	hard: { targetR: 0.2, speed: 1, a1: [1.9, 3.0], a2: [1.4, 3.1], dist: [0.7, 1.8] },
	oni: { targetR: 0.13, speed: 1.3, a1: [2.2, 3.3], a2: [2.0, 3.3], dist: [0.8, 1.9] },
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
		/** near/miss のときの「あと◯px」。それ以外は 0 */
		nearMissPx: number;
	};
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
	const TARGET_TTL = 3; // 的の寿命（秒）。超えたら見逃し（MISS）
	const BPM = 130;
	const BEAT = 60 / BPM;
	const SLOWMO_TIME = 0.2; // 叩いた後のスロー時間（実秒）
	const SLOWMO_SCALE = 0.15; // スロー中の物理倍率

	const g = 9.81,
		L1 = 1,
		L2 = 1,
		m1 = 1,
		m2 = 1;

	let preset: DifficultyPreset = DIFFICULTY_PRESETS[options.difficulty ?? 'normal'];
	let TARGET_R = preset.targetR;
	let baseSpeed = preset.speed;

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
	}
	let s: Vec; // [θ1, θ2, ω1, ω2]
	let trail: [number, number][] = [];
	let target: Target;
	let state: 'playing' | 'slowmo' | 'over' = 'playing';
	let gameTime = 0; // 経過（実秒）
	let slowmoT = 0;
	let score = 0;
	let combo = 0;
	let maxCombo = 0;
	let hits = 0;
	let perfectCount = 0;

	// 演出（表示のみ・物理/スコアに干渉しない）
	let flash = 0;
	let popT = 0;
	let resultLabel = '';
	let lastHit: { d: number; kind: HitKind } | null = null;

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

	function newTarget() {
		const ang = rand(0, Math.PI * 2),
			dist = rand(preset.dist[0], preset.dist[1]);
		target = { x: Math.sin(ang) * dist, y: Math.cos(ang) * dist, r: TARGET_R, bornAt: gameTime };
	}

	function newGame() {
		s = [sign() * rand(preset.a1[0], preset.a1[1]), sign() * rand(preset.a2[0], preset.a2[1]), 0, 0];
		trail = [];
		gameTime = 0;
		slowmoT = 0;
		score = 0;
		combo = 0;
		maxCombo = 0;
		hits = 0;
		perfectCount = 0;
		flash = 0;
		popT = 0;
		resultLabel = '';
		lastHit = null;
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
		// 内部の距離スコア（分析用）。得点になるのは GOOD 以上だけ。
		const pts =
			d <= R
				? 100 - Math.round((d / R) * 20)
				: Math.round(Math.max(0, 70 * (1 - (d - R) / 0.9)));

		const scoring = kind === 'perfect' || kind === 'great' || kind === 'good';
		// 順序：判定 → GOOD以上ならコンボ+1 → 倍率再計算 → 今回分を加算
		if (scoring) {
			combo++;
			if (combo > maxCombo) maxCombo = combo;
		} else {
			combo = 0;
		}
		const mult = comboMult(combo);
		const add = scoring ? Math.round(pts * mult) : 0;
		score += add;
		hits++;
		if (kind === 'perfect') perfectCount++;

		const nearMissPx = !scoring ? Math.round((d - R) * scale) : 0;
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
		} else {
			$msg.textContent = `あと ${nearMissPx}px！`;
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
		});

		// 叩いたら必ずスロー → 次の的
		state = 'slowmo';
		slowmoT = SLOWMO_TIME;
	}

	/** 寿命切れ（見逃し）。スローは挟まず即次。 */
	function expireTarget() {
		combo = 0;
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

		// 可動範囲
		ctx!.strokeStyle = col.dim;
		ctx!.lineWidth = 1;
		ctx!.setLineDash([2, 8]);
		ctx!.beginPath();
		ctx!.arc(cx, cy, 2 * scale, 0, Math.PI * 2);
		ctx!.stroke();
		ctx!.setLineDash([]);

		// ターゲット（BPM で脈動。残り寿命が短いと薄くなる）
		if (state !== 'over') {
			const [tx, ty] = P(target.x, target.y);
			const life = Math.max(0, 1 - (gameTime - target.bornAt) / TARGET_TTL);
			const rDraw = target.r * scale * (1 + 0.18 * beatPulse());
			ctx!.globalAlpha = 0.35 + 0.65 * Math.min(1, life * 2); // 消える直前だけフェード
			ctx!.strokeStyle = col.yellow;
			ctx!.lineWidth = 2.5 + 1.5 * beatPulse();
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

		// コンボ（2以上で上部に表示）
		if (combo >= 2 && state !== 'over') {
			ctx!.fillStyle = col.pink;
			ctx!.font = `600 ${Math.round(Math.min(W, H) * 0.07)}px "Klee One", sans-serif`;
			ctx!.textAlign = 'center';
			ctx!.textBaseline = 'top';
			ctx!.fillText(`${combo} COMBO`, cx, H * 0.05);
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
			const ts = state === 'slowmo' ? SLOWMO_SCALE : baseSpeed;
			const h = dt * ts;
			const n = 10;
			for (let i = 0; i < n; i++) s = rk4(s, h / n);
			const [, , x2, y2] = tips(s);
			trail.push([x2, y2]);
			if (trail.length > 140) trail.shift();

			gameTime += dt; // 30秒は実時間で計る
			if (state === 'slowmo') {
				slowmoT -= dt;
				if (slowmoT <= 0) {
					state = 'playing';
					newTarget();
				}
			} else if (gameTime - target.bornAt > TARGET_TTL) {
				expireTarget();
			}

			$time.style.width = Math.max(0, 1 - gameTime / GAME_TIME) * 100 + '%';
			if (gameTime >= GAME_TIME) endGame();
		}

		if (flash > 0) flash = Math.max(0, flash - dt * 3);
		if (popT > 0) popT = Math.max(0, popT - dt * 2.4);
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
			baseSpeed = preset.speed;
			newGame();
		},
		restart() {
			emit('game_retry', undefined);
			newGame();
		},
	};
}
