// CHAOS BEAT の拍グリッド（エンジンと audio が共有する唯一の拍の定義）。
// transport 時刻 t（秒）は「拍0 = 0」の共通時計。拍の時刻は必ず beatTime(beatIndex) で求める。
//   audio 側の絶対時刻 = transportStartTime + beatTime(beatIndex)
// BGM の拍頭・cue（タン/ドン）・target.hitAt・アプローチリングの収束は全部この式の同じ beatIndex を見る。
// AudioContext にも DOM にも依存しない（エンジンから import してよい）。

export const BPM = 130;
/** 1拍の秒数（Seconds Per Beat） */
export const SPB = 60 / BPM;
/** TAP TO START 後のカウントイン拍数（ゲーム本編の尺には含めない） */
export const COUNTIN_BEATS = 4;

/** 拍番号（小数可＝裏拍）→ transport 時刻（秒） */
export function beatTime(beatIndex: number): number {
	return beatIndex * SPB;
}

/** transport 時刻 t の「次の拍頭」の拍番号（t がちょうど拍頭なら次の拍） */
export function nextBeatIndex(t: number): number {
	return Math.floor(t / SPB + 1e-9) + 1;
}

/** 拍内の位相 0→1（負の t＝カウントイン中でも 0..1 に収める） */
export function beatPhase(t: number): number {
	const x = t / SPB;
	return x - Math.floor(x);
}
