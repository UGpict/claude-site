// カオス振り子ストップ — ゲームエンジン
//
// 【重要】物理計算・RK4 数値積分・スコア計算・的との距離判定・1ラウンド15秒・
// 全5ラウンド・0〜100点の採点仕様・ゲーム進行ルールは、単一HTML版から一切変更していない。
// これらを変更する場合は明示的な指示が必要（リファクタリング都合の挙動変更も禁止）。
//
// このファイルは Astro / GA4 / 広告に依存しない純粋なゲームエンジン。
// 将来 CrazyGames 等へ切り出す際は initGame() をそのまま利用できる。
// 計測は onEvent コールバック経由で外へ通知するだけで、送信先はこのファイルの外で決める。

export type GameEventName =
	| 'game_view'
	| 'game_start'
	| 'round_complete'
	| 'game_complete'
	| 'game_retry';

/** 判定の種類（表示・効果音の分岐用。採点ロジックそのものは変えていない） */
export type RoundKind = 'perfect' | 'nice' | 'miss' | 'timeup';

export interface GameEventPayloads {
	game_view: undefined;
	game_start: undefined;
	round_complete: {
		round: number;
		score: number;
		distance: number;
		/** 的の中で止められたか（timeout は常に false） */
		perfect: boolean;
		/** 判定の種類 */
		kind: RoundKind;
		/** 的の外へどれだけはみ出したか（= max(0, distance - TARGET_R)）。演出用の派生値 */
		overshoot: number;
	};
	game_complete: { score: number; rounds: number; duration: number };
	game_retry: undefined;
}

export interface GameElements {
	/** 現在ラウンド番号の表示先 */
	round: HTMLElement;
	/** 合計スコアの表示先 */
	total: HTMLElement;
	/** 残り時間バー（width % を設定する内側要素） */
	time: HTMLElement;
	/** メッセージ表示先 */
	msg: HTMLElement;
	/** 操作ボタン（止める / 次へ / もう一度） */
	act: HTMLElement;
}

export interface InitGameOptions {
	canvas: HTMLCanvasElement;
	elements: GameElements;
	/** 計測などの副作用は必ずこのコールバック経由で外へ出す（エンジンは送信先を知らない） */
	onEvent?: <K extends GameEventName>(name: K, payload: GameEventPayloads[K]) => void;
}

export interface GameHandle {
	destroy(): void;
}

type Vec = number[];

export function initGame(options: InitGameOptions): GameHandle {
	const ROUNDS = 5,
		TIME_LIMIT = 15,
		TARGET_R = 0.18;
	const g = 9.81,
		L1 = 1,
		L2 = 1,
		m1 = 1,
		m2 = 1;

	const cv = options.canvas;
	const ctx = cv.getContext('2d');
	if (!ctx) throw new Error('2D context is not available');
	const $round = options.elements.round;
	const $total = options.elements.total;
	const $time = options.elements.time;
	const $msg = options.elements.msg;
	const $act = options.elements.act;

	const emit = <K extends GameEventName>(name: K, payload: GameEventPayloads[K]) => {
		try {
			options.onEvent?.(name, payload);
		} catch {
			/* 計測の失敗はゲーム進行に影響させない */
		}
	};

	// 色は CSS カスタムプロパティから読む。単体HTMLでは値が無いのでフォールバックを持つ。
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

	// 状態 [θ1, θ2, ω1, ω2]
	let s: Vec,
		target: [number, number],
		trail: [number, number][],
		state: 'run' | 'stopped' | 'over',
		round: number,
		total: number,
		elapsed: number,
		lastScore: { d: number; pts: number } | null;

	// 止めた瞬間の演出（表示のみ・物理/スコアには一切干渉しない）
	let flash = 0;
	let resultLabel = '';

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

	function newRound() {
		s = [sign() * rand(1.9, 3.0), sign() * rand(1.4, 3.1), 0, 0];
		const ang = rand(0, Math.PI * 2),
			dist = rand(0.7, 1.8);
		target = [Math.sin(ang) * dist, Math.cos(ang) * dist];
		trail = [];
		elapsed = 0;
		state = 'run';
		flash = 0;
		resultLabel = '';
		$round.textContent = String(round);
		$act.textContent = '止める';
		$msg.textContent = '先端のおもりを黄色い丸の中で止めよう。';
	}

	let gameStartMs = 0;
	function newGame() {
		round = 1;
		total = 0;
		$total.textContent = '0';
		gameStartMs = performance.now();
		newRound();
		emit('game_start', undefined);
	}

	function stop(timeout: boolean) {
		const [, , x2, y2] = tips(s);
		const d = Math.hypot(x2 - target[0], y2 - target[1]);
		let pts: number, text: string;
		if (timeout) {
			pts = 0;
			text = '時間切れ。0点';
		} else if (d <= TARGET_R) {
			pts = 100 - Math.round((d / TARGET_R) * 20);
			text = `ぴったり！ +${pts}点`;
		} else {
			pts = Math.round(Math.max(0, 70 * (1 - (d - TARGET_R) / 0.9)));
			text = pts >= 40 ? `おしい！ +${pts}点` : `遠い… +${pts}点`;
		}
		lastScore = { d, pts };
		total += pts;
		$total.textContent = String(total);

		// 表示のみの演出ラベル（採点結果を読むだけ・ロジックには非干渉）
		const kind: RoundKind = timeout
			? 'timeup'
			: d <= TARGET_R
				? 'perfect'
				: pts >= 40
					? 'nice'
					: 'miss';
		resultLabel = kind === 'timeup' ? 'TIME UP' : kind === 'perfect' ? 'PERFECT' : kind === 'nice' ? 'NICE' : 'MISS';
		flash = 1;

		emit('round_complete', {
			round,
			score: pts,
			distance: d,
			perfect: !timeout && d <= TARGET_R,
			kind,
			overshoot: Math.max(0, d - TARGET_R),
		});

		state = round >= ROUNDS ? 'over' : 'stopped';
		if (state === 'over') {
			$msg.textContent = `${text}　最終スコアは ${total} / ${ROUNDS * 100} 点`;
			$act.textContent = 'もう一度';
			const duration = Math.round((performance.now() - gameStartMs) / 1000);
			emit('game_complete', { score: total, rounds: ROUNDS, duration });
		} else {
			$msg.textContent = text;
			$act.textContent = '次へ';
		}
	}

	function act() {
		if (state === 'run') stop(false);
		else if (state === 'stopped') {
			round++;
			newRound();
		} else {
			emit('game_retry', undefined);
			newGame();
		}
	}

	const onActClick = () => act();
	const onPointerDown = (e: PointerEvent) => {
		e.preventDefault();
		act();
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.code === 'Space' || e.code === 'Enter') {
			if (document.activeElement === $act && e.code === 'Enter') return;
			e.preventDefault();
			act();
		}
	};
	$act.addEventListener('click', onActClick);
	cv.addEventListener('pointerdown', onPointerDown);
	window.addEventListener('keydown', onKeyDown);

	const P = (x: number, y: number): [number, number] => [cx + x * scale, cy + y * scale];

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

		// ターゲット
		const [tx, ty] = P(target[0], target[1]);
		ctx!.strokeStyle = col.yellow;
		ctx!.lineWidth = 2.5;
		ctx!.setLineDash([6, 6]);
		ctx!.beginPath();
		ctx!.arc(tx, ty, TARGET_R * scale, 0, Math.PI * 2);
		ctx!.stroke();
		ctx!.setLineDash([]);
		ctx!.beginPath();
		ctx!.moveTo(tx - 6, ty);
		ctx!.lineTo(tx + 6, ty);
		ctx!.moveTo(tx, ty - 6);
		ctx!.lineTo(tx, ty + 6);
		ctx!.stroke();

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
		ctx!.fillStyle = state === 'run' ? col.pink : col.chalk;
		ctx!.beginPath();
		ctx!.arc(p2x, p2y, 11, 0, Math.PI * 2);
		ctx!.fill();

		// 止めた後の距離線
		if (state !== 'run' && lastScore) {
			ctx!.strokeStyle = col.blue;
			ctx!.lineWidth = 2;
			ctx!.setLineDash([4, 5]);
			ctx!.beginPath();
			ctx!.moveTo(p2x, p2y);
			ctx!.lineTo(tx, ty);
			ctx!.stroke();
			ctx!.setLineDash([]);
		}

		// 止めた瞬間の軽いフラッシュ＋結果ラベル（表示のみ）
		if (flash > 0) {
			ctx!.globalAlpha = flash * 0.35;
			ctx!.fillStyle = col.chalk;
			ctx!.fillRect(0, 0, W, H);
			ctx!.globalAlpha = 1;
		}
		if (state !== 'run' && resultLabel) {
			ctx!.fillStyle = resultLabel === 'PERFECT' ? col.yellow : col.chalk;
			ctx!.font = `600 ${Math.round(Math.min(W, H) * 0.1)}px "Klee One", sans-serif`;
			ctx!.textAlign = 'center';
			ctx!.textBaseline = 'middle';
			ctx!.fillText(resultLabel, cx, Math.max(H * 0.14, cy - scale * 1.7));
			ctx!.textAlign = 'start';
			ctx!.textBaseline = 'alphabetic';
		}
	}

	let last = performance.now();
	let rafId = 0;
	function loop(now: number) {
		const dt = Math.min((now - last) / 1000, 1 / 30);
		last = now;
		if (state === 'run') {
			const n = 10;
			for (let i = 0; i < n; i++) s = rk4(s, dt / n);
			const [, , x2, y2] = tips(s);
			trail.push([x2, y2]);
			if (trail.length > 140) trail.shift();
			elapsed += dt;
			$time.style.width = Math.max(0, 1 - elapsed / TIME_LIMIT) * 100 + '%';
			if (elapsed >= TIME_LIMIT) stop(true);
		}
		// 演出フラッシュの減衰（表示のみ）
		if (flash > 0) flash = Math.max(0, flash - dt * 3);
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
			$act.removeEventListener('click', onActClick);
			cv.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('keydown', onKeyDown);
		},
	};
}
