// 目押し対策の検証（数値シミュレーション）。
// 実際に耳で遊べないので、「押した瞬間の時刻ズレ e(ms)」の分布で2種のプレイヤーを近似し、
// 旧判定（距離のみ）と新判定（拍×位置の複合）で PERFECT 率を比べる。
//
// モデル：的は「hitAt で先端が来る位置」にあるので、押しズレ e のとき
//   beatMs = |e|、posN = v*|e|/1000 / R（v=先端速度 u/s、R=的半径）。
// audio player：ドン(拍)を聞いて合わせる → e ~ N(0, 25ms)
// silent player（目押し）：案A で拍直前の"正確な瞬間"が読めない → e ~ N(0, 70ms)
//   （案Aが無ければ silent も ~30ms 取れてしまい、音の価値が出ない＝これが今回の肝）

const N = 20000;
const R = 0.34; // normal
const BEAT_PERFECT_MS = 45, BEAT_GREAT_MS = 90, BEAT_GOOD_MS = 170, BEAT_NEAR_MS = 260;

function randn(sd) { // Box-Muller
	let u = 0, v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
}
// 先端速度 v(u/s)：二重振り子の hit 時。ゆっくり〜速いを混ぜる（CHAOS 的は速い）
const sampleV = () => 2.5 + Math.random() * 6.0; // 2.5〜8.5 u/s

function posRankOf(posN) { return posN <= 0.35 ? 4 : posN <= 0.7 ? 3 : posN <= 1.0 ? 2 : posN <= 1.25 ? 1 : 0; }
function gradeOld(posN) { return posRankOf(posN); } // 距離のみ（並行版の既存）
function gradeNew(posN, beatMs) {
	const posRank = posRankOf(posN);
	const beatRank = beatMs <= BEAT_PERFECT_MS ? 4 : beatMs <= BEAT_GREAT_MS ? 3 : beatMs <= BEAT_GOOD_MS ? 2 : beatMs <= BEAT_NEAR_MS ? 1 : 0;
	return posRank >= 2 ? Math.max(2, Math.min(posRank, beatRank)) : posRank;
}

function run(sd, grader) {
	const c = { perfect: 0, great: 0, good: 0, near: 0, miss: 0 };
	const names = ['miss', 'near', 'good', 'great', 'perfect'];
	for (let i = 0; i < N; i++) {
		const e = randn(sd);
		const v = sampleV();
		const posN = (v * Math.abs(e)) / 1000 / R;
		const beatMs = Math.abs(e);
		c[names[grader === gradeOld ? gradeOld(posN) : gradeNew(posN, beatMs)]]++;
	}
	return c;
}
const pct = (c, k) => ((c[k] / N) * 100).toFixed(1) + '%';

const SIG_AUDIO = 25, SIG_SILENT = 70;
console.log(`N=${N}, R=${R}, audio σ=${SIG_AUDIO}ms, silent σ=${SIG_SILENT}ms\n`);
for (const [label, grader] of [['OLD (距離のみ)', gradeOld], ['NEW (拍×位置 複合)', gradeNew]]) {
	const a = run(SIG_AUDIO, grader);
	const s = run(SIG_SILENT, grader);
	console.log(`--- ${label} ---`);
	console.log(`  audio : PERFECT ${pct(a, 'perfect')}  GREAT ${pct(a, 'great')}  GOOD ${pct(a, 'good')}  miss ${pct(a, 'miss')}`);
	console.log(`  silent: PERFECT ${pct(s, 'perfect')}  GREAT ${pct(s, 'great')}  GOOD ${pct(s, 'good')}  miss ${pct(s, 'miss')}`);
	const gap = ((a.perfect - s.perfect) / N) * 100;
	console.log(`  → PERFECT gap (audio − silent): ${gap.toFixed(1)} pt\n`);
}
