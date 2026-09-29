// 目押し検証：ゲームが画面に見せている情報だけを使う「最適BOT」で判定を比較する（人間の反応σは仮定しない）。
// 物理・的配置・判定は実エンジンを複製。的は「先端が hitAt+DECOUPLE の時刻に来る位置」に置く。
//   DECOUPLE=0  … 現状（距離最小の瞬間＝拍。視覚だけでも拍だけでも同じ瞬間＝両方PERFECT）
//   DECOUPLE>0  … 距離最小を拍から少しずらす（視覚だけ／拍だけ を不十分にする案）
// BOT：
//   visual … d(t) が最小になる瞬間に押す（位置だけ最適）
//   beat   … hitAt ちょうどに押す（拍だけ最適）
//   both   … 拍窓 ±45ms の中で d(t) が最小の瞬間に押す（両方使う）
// 判定：OLD=距離のみ / NEW=拍×位置の複合（実装と同じしきい値）。

const g = 9.81, L1 = 1, L2 = 1, m1 = 1, m2 = 1;
const FIXED_H = 1 / 300;
const BPM = 175, SPB = 60 / BPM;
const R = 0.34; // normal 的半径
const BEAT_P = 45, BEAT_G = 90, BEAT_GD = 170, BEAT_N = 260;

function deriv([t1, t2, w1, w2]) {
	const d = t1 - t2, den = 2 * m1 + m2 - m2 * Math.cos(2 * d);
	const a1 = (-g * (2 * m1 + m2) * Math.sin(t1) - m2 * g * Math.sin(t1 - 2 * t2) - 2 * Math.sin(d) * m2 * (w2 * w2 * L2 + w1 * w1 * L1 * Math.cos(d))) / (L1 * den);
	const a2 = (2 * Math.sin(d) * (w1 * w1 * L1 * (m1 + m2) + g * (m1 + m2) * Math.cos(t1) + w2 * w2 * L2 * m2 * Math.cos(d))) / (L2 * den);
	return [w1, w2, a1, a2];
}
function rk4(y, h) {
	const add = (a, b, k) => a.map((v, i) => v + b[i] * k);
	const k1 = deriv(y), k2 = deriv(add(y, k1, h / 2)), k3 = deriv(add(y, k2, h / 2)), k4 = deriv(add(y, k3, h));
	return y.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}
const tip = ([t1, t2]) => [L1 * Math.sin(t1) + L2 * Math.sin(t2), L1 * Math.cos(t1) + L2 * Math.cos(t2)];
const rand = (a, b) => a + Math.random() * (b - a);
const sign = () => (Math.random() < 0.5 ? -1 : 1);

// 密な軌道（固定ステップ）：index i の時刻 = i*FIXED_H
function buildTrajectory(seconds) {
	let s = [sign() * rand(1.9, 3.0), sign() * rand(1.4, 3.1), 0, 0];
	const n = Math.round(seconds / FIXED_H);
	const xs = new Float64Array(n), ys = new Float64Array(n);
	for (let i = 0; i < n; i++) { const [x, y] = tip(s); xs[i] = x; ys[i] = y; s = rk4(s, FIXED_H); }
	return { xs, ys, n };
}
const posAt = (traj, t) => { const i = Math.max(0, Math.min(traj.n - 1, Math.round(t / FIXED_H))); return [traj.xs[i], traj.ys[i]]; };
const dAt = (traj, t, tx, ty) => { const [x, y] = posAt(traj, t); return Math.hypot(x - tx, y - ty); };

function posRank(dN) { return dN <= 0.35 ? 4 : dN <= 0.7 ? 3 : dN <= 1.0 ? 2 : dN <= 1.25 ? 1 : 0; }
function gradeOLD(d) { return posRank(d / R); }
function gradeNEW(d, beatMs) {
	const pr = posRank(d / R);
	const br = beatMs <= BEAT_P ? 4 : beatMs <= BEAT_G ? 3 : beatMs <= BEAT_GD ? 2 : beatMs <= BEAT_N ? 1 : 0;
	return pr >= 2 ? Math.max(2, Math.min(pr, br)) : pr;
}
const KNAME = ['miss', 'near', 'good', 'great', 'perfect'];

// 拍窓内で d 最小の時刻を探す（both BOT）
function argminD(traj, tx, ty, t0, t1, step) {
	let best = Infinity, bt = t0;
	for (let t = t0; t <= t1; t += step) { const dd = dAt(traj, t, tx, ty); if (dd < best) { best = dd; bt = t; } }
	return bt;
}

function runBots(DECOUPLE_MS, targetsPerRun = 600) {
	const DEC = DECOUPLE_MS / 1000;
	const traj = buildTrajectory(targetsPerRun * 3 * SPB + 5); // 1的おおよそ3拍
	const stats = {};
	for (const grader of ['OLD', 'NEW']) for (const bot of ['visual', 'beat', 'both'])
		stats[grader + ':' + bot] = { perfect: 0, great: 0, good: 0, near: 0, miss: 0, pts: 0, combo: 0, maxCombo: 0, n: 0 };

	let beatK = 12;
	for (let m = 0; m < targetsPerRun; m++) {
		const hitAt = beatK * SPB;
		if ((hitAt + 0.4) > traj.n * FIXED_H) break;
		// 的＝先端が (hitAt+DEC) に来る位置
		const [tx, ty] = posAt(traj, hitAt + DEC);
		// BOT ごとの押下時刻
		const pVisual = argminD(traj, tx, ty, hitAt - 0.3, hitAt + 0.3, 0.001); // d 最小（位置だけ）
		const pBeat = hitAt; // 拍だけ
		const pBoth = argminD(traj, tx, ty, hitAt - BEAT_P / 1000, hitAt + BEAT_P / 1000, 0.001); // 拍窓内で位置最良
		for (const [bot, pt] of [['visual', pVisual], ['beat', pBeat], ['both', pBoth]]) {
			const d = dAt(traj, pt, tx, ty);
			const beatMs = Math.abs(pt - hitAt) * 1000;
			for (const grader of ['OLD', 'NEW']) {
				const gg = grader === 'OLD' ? gradeOLD(d) : gradeNEW(d, beatMs);
				const st = stats[grader + ':' + bot];
				st[KNAME[gg]]++; st.n++;
				const worseN = Math.max(d / R, beatMs / BEAT_GD);
				const pts = gg >= 2 ? Math.max(40, Math.min(100, 100 - worseN * 45)) : 0;
				st.pts += pts;
				if (gg >= 2) { st.combo++; if (st.combo > st.maxCombo) st.maxCombo = st.combo; } else st.combo = 0;
			}
		}
		beatK += 2 + (m % 2); // 2〜3拍おき
	}
	return stats;
}

const pc = (st, k) => ((st[k] / st.n) * 100).toFixed(1) + '%';
const gePerfGreat = (st) => (((st.perfect + st.great) / st.n) * 100).toFixed(1) + '%';
for (const DEC of [0, 40, 60, 80]) {
	console.log(`\n================  DECOUPLE = ${DEC} ms  ================`);
	const s = runBots(DEC);
	for (const grader of ['OLD', 'NEW']) {
		console.log(`  [${grader}]`);
		for (const bot of ['visual', 'beat', 'both']) {
			const st = s[grader + ':' + bot];
			console.log(`    ${bot.padEnd(6)}  PERFECT ${pc(st, 'perfect').padStart(6)}  GREAT+ ${gePerfGreat(st).padStart(6)}  avgPts ${(st.pts / st.n).toFixed(1).padStart(5)}  maxCombo ${st.maxCombo}`);
		}
	}
}
