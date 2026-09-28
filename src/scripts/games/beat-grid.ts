// CHAOS BEAT の拍グリッド（エンジンと audio が共有する唯一の拍の定義）。
// transport 時刻 t（秒）は「拍0 = 0」の共通時計。拍の時刻は必ず grid.beatTime(beatIndex) で求める。
//   audio 側の絶対時刻 = transportStartTime + grid.beatTime(beatIndex)
// BGM の拍頭・外部音源の拍・cue（タン/ドン）・target.hitAt・アプローチリングの収束は全部この式の同じ beatIndex を見る。
// BPM は曲（SongDefinition.bpm）ごと。makeGrid(bpm) で作る。AudioContext にも DOM にも依存しない。

/** 内蔵の合成曲（60秒1曲）の BPM。外部音源の曲は SongDefinition.bpm を使う */
export const BPM = 130;
/** TAP TO START 後のカウントイン拍数（ゲーム本編の尺には含めない） */
export const COUNTIN_BEATS = 4;

export interface BeatGrid {
	bpm: number;
	/** 1拍の秒数（Seconds Per Beat） */
	spb: number;
	/** 拍番号（小数可＝裏拍）→ transport 時刻（秒） */
	beatTime(beatIndex: number): number;
	/** transport 時刻 t の「次の拍頭」の拍番号（t がちょうど拍頭なら次の拍） */
	nextBeatIndex(t: number): number;
	/** 拍内の位相 0→1（負の t＝カウントイン中でも 0..1 に収める） */
	beatPhase(t: number): number;
}

export function makeGrid(bpm: number): BeatGrid {
	const spb = 60 / bpm;
	return {
		bpm,
		spb,
		beatTime: (beatIndex) => beatIndex * spb,
		nextBeatIndex: (t) => Math.floor(t / spb + 1e-9) + 1,
		beatPhase: (t) => {
			const x = t / spb;
			return x - Math.floor(x);
		},
	};
}

/** 内蔵曲のグリッド（BPM 130） */
export const DEFAULT_GRID = makeGrid(BPM);
