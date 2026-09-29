// CHAOS BEAT の「曲」定義（譜面＋曲構成）。エンジンと audio が共有するデータだけを置く。
// DOM・AudioContext に依存しない。時刻はすべて transport 時刻（拍0=0 秒）。
//
// 1曲 = GAME_DURATION 秒を INTRO → GROOVE → BUILD → CLIMAX → FINAL のセクションに分ける。
// セクションは「曲そのものの進行（譜面の性格・基本アレンジ）」。コンボで解放される音の層とは別概念。
// 将来 QUICK 30 / NORMAL 60 / FULL 90 などは SongDefinition を増やすだけで作れるようにしてある（今は60秒のみ）。

import { BPM, makeGrid, type BeatGrid } from './beat-grid';

/** リズム予告の音種（Web Audio 側で鳴らし分ける） */
export type CueSound = 'tick' | 'accent';

/** リズムパターン。予告音（cue）の並びと「入力すべき拍(hitBeat)」を持つ。 */
export interface RhythmPattern {
	id: string;
	/** パターンの長さ（拍） */
	lengthBeats: number;
	/** 予告音：パターン先頭からの拍位置（小数=裏拍）と音種 */
	cues: { beat: number; sound: CueSound }[];
	/** 入力すべき拍（パターン先頭からの拍位置）。ここに先端がターゲットへ来る */
	hitBeat: number;
	/** フル尺の曲の譜面専用（曲の終わりの差し替え候補などに使わない＝60秒版の譜面を変えない） */
	fullOnly?: boolean;
}

// 極端に複雑にしない。どれも「タン（拍の刻み）を聞けばドンの位置が予測できる」形。
export const RHYTHM_PATTERNS: RhythmPattern[] = [
	// A：タン タン タン ドン
	{ id: 'A', lengthBeats: 4, cues: [t(0), t(1), t(2), a(3)], hitBeat: 3 },
	// B：タン タン 休 ドン
	{ id: 'B', lengthBeats: 4, cues: [t(0), t(1), a(3)], hitBeat: 3 },
	// C：タン ・タタ・ ドン（裏拍入り、2.5拍目で入力）
	{ id: 'C', lengthBeats: 3, cues: [t(0), t(1), t(1.5), a(2.5)], hitBeat: 2.5 },
	// D：タン 休 タン ドン
	{ id: 'D', lengthBeats: 4, cues: [t(0), t(2), a(3)], hitBeat: 3 },
	// E：タン タタ タン ドン（8分の刻みが入るだけ。入力は表拍）
	{ id: 'E', lengthBeats: 4, cues: [t(0), t(1), t(1.5), t(2), a(3)], hitBeat: 3 },
	// F：タン 休 タタ ドン（休みのあと8分で詰める）
	{ id: 'F', lengthBeats: 4, cues: [t(0), t(2), t(2.5), a(3)], hitBeat: 3 },
	// G：タン タン ・タ ・ドン（裏拍で入力。直前の裏拍タンから1拍後）
	{ id: 'G', lengthBeats: 4, cues: [t(0), t(1), t(2.5), a(3.5)], hitBeat: 3.5 },
	// --- フル尺の曲用（60秒版のプールには入れない） ---
	// H：タン ドン（1拍後に入力。続けると2拍ごとの「短い連続入力」になる）
	{ id: 'H', lengthBeats: 2, cues: [t(0), a(1)], hitBeat: 1, fullOnly: true },
	// J：タン ・ドン（1.5拍後の裏拍で入力。ソロのシンコペーション用）
	{ id: 'J', lengthBeats: 2, cues: [t(0), a(1.5)], hitBeat: 1.5, fullOnly: true },
	// Z：タン タン タン（溜め）ドン — 最後の一打。ドンは4拍目の16分後（Burning Heart の最後の和音に合わせる）
	{ id: 'Z', lengthBeats: 4, cues: [t(0), t(1), t(2), a(3.25)], hitBeat: 3.25, fullOnly: true },
];
function t(beat: number) {
	return { beat, sound: 'tick' as const };
}
function a(beat: number) {
	return { beat, sound: 'accent' as const };
}
export const PATTERN_BY_ID: Record<string, RhythmPattern> = Object.fromEntries(
	RHYTHM_PATTERNS.map((p) => [p.id, p]),
);

/** 譜面シーケンス。pattern を順番に消化する（「繰り返し→崩し」で覚えやすく）。 */
export interface RhythmSequence {
	id: string;
	patterns: string[];
}
/** やさしい：A/B のみ（裏拍なし） */
export const EASY_SEQUENCES: RhythmSequence[] = [
	{ id: 'e1', patterns: ['A', 'A', 'B', 'A'] },
	{ id: 'e2', patterns: ['A', 'A', 'A', 'B'] },
	{ id: 'e3', patterns: ['A', 'B', 'A', 'B'] },
];
/** 標準：C/D が1つ入る */
export const STANDARD_SEQUENCES: RhythmSequence[] = [
	{ id: 's1', patterns: ['A', 'A', 'C', 'A'] },
	{ id: 's2', patterns: ['A', 'B', 'A', 'D'] },
	{ id: 's3', patterns: ['B', 'A', 'C', 'A'] },
	{ id: 's4', patterns: ['A', 'C', 'B', 'D'] },
	{ id: 's5', patterns: ['A', 'E', 'A', 'B'] },
];
/** BUILD：同じフレーズを繰り返してから崩す／裏拍が増える */
export const BUILD_SEQUENCES: RhythmSequence[] = [
	{ id: 'b1', patterns: ['E', 'E', 'E', 'C'] },
	{ id: 'b2', patterns: ['D', 'F', 'D', 'C'] },
	{ id: 'b3', patterns: ['A', 'C', 'A', 'F'] },
	{ id: 'b4', patterns: ['C', 'C', 'E', 'D'] },
];
/** CLIMAX：裏拍入力（C/G）と詰め（E/F）が中心 */
export const CLIMAX_SEQUENCES: RhythmSequence[] = [
	{ id: 'h1', patterns: ['C', 'E', 'G', 'D'] },
	{ id: 'h2', patterns: ['F', 'C', 'G', 'E'] },
	{ id: 'h3', patterns: ['G', 'G', 'C', 'F'] },
	{ id: 'h4', patterns: ['E', 'G', 'F', 'C'] },
];
/** FINAL：残り約5秒で2つ入る短い締め */
export const FINAL_SEQUENCES: RhythmSequence[] = [
	{ id: 'f1', patterns: ['E', 'C'] },
	{ id: 'f2', patterns: ['F', 'C'] },
];
export const ALL_SEQUENCES: RhythmSequence[] = [
	...EASY_SEQUENCES,
	...STANDARD_SEQUENCES,
	...BUILD_SEQUENCES,
	...CLIMAX_SEQUENCES,
	...FINAL_SEQUENCES,
];
export const SEQUENCE_BY_ID: Record<string, RhythmSequence> = Object.fromEntries(
	ALL_SEQUENCES.map((s) => [s.id, s]),
);
const ids = (list: RhythmSequence[]) => list.map((s) => s.id);

/** 60秒版は intro/groove/build/climax/final。曲ごとのセクション（chorus・solo 等）は曲が自由に名付ける。'intro' は CHAOS チャンスを出さない */
export type SectionId = string;

/** セクションの基本アレンジ（コンボと無関係に鳴る「曲の進行」側）。コンボ層は audio が別に重ねる。 */
export interface SectionArrangement {
	/** ドラムの型：sparse=キック中心 / basic=キック+スネア / drive=+8分シェイカー / four=4つ打ち+シェイカー */
	drums: 'sparse' | 'basic' | 'drive' | 'four';
	/** 伴奏の和音（小節頭のパッド） */
	pad: boolean;
	/** コンボで解放される melody 層がどのモチーフを弾くか */
	motif: 'main' | 'variation' | 'finale';
	/** melody 層の音量（CLIMAX で強める） */
	melodyGain: number;
	/** セクション最後の1小節にフィル（スネアロール）を入れて次へ繋ぐ */
	fill: boolean;
	/** セクション頭にクラッシュ */
	crash: boolean;
}

export interface GameSection {
	id: SectionId;
	/** 表示名 */
	label: string;
	/** 開始・終了（秒、設計値）。実際の境界は小節頭へ丸める（sectionStart 参照） */
	start: number;
	end: number;
	/** このセクションで選ぶ譜面シーケンス（id） */
	sequencePool: string[];
	/** 曲の盛り上がり度 0..4（UI/計測用の目安） */
	musicIntensity: number;
	/** 的の大きさ倍率（難易度の targetR に掛ける）。INTRO は少し大きく分かりやすく */
	targetScale: number;
	arrangement: SectionArrangement;
	/**
	 * 休符：前の入力拍から最低この拍数あけてから次のパターンを始める（既定 0＝すぐ次）。
	 * 4拍パターンなら 0 で約4拍に1回、4 で約8拍に1回。歌やギターを聞かせる区間に使う。
	 */
	restBeats?: number;
	/** false なら sequencePool で埋めず、手書き譜面（beatmap）の的だけを出す（ブレイク・アウトロ等の「聞く」区間）。既定 true */
	autoFill?: boolean;
	/** CHAOS チャンスとみなす先端速度（既定 7.5 u/s）。サビで少し下げてチャンスを増やす */
	chaosSpeed?: number;
	/** 盛り上がり演出（0=なし / 1=サビ：拍で枠が光る / 2=ラスサビ：さらに強く） */
	hype?: number;
	/** 外部音源のダッキング倍率（ドンの前後で曲をこの倍率に）。曲の音量差に合わせて区間ごとに。既定 0.42 */
	duck?: number;
	/** 判定音の音階に使う和音（[根音, 3度, 5度] Hz）。セクション頭から1小節ずつ順に使い、最後の和音を保持。無ければ song.harmony */
	harmony?: number[][];
}

/**
 * 外部音源（mp3 等）。Web Audio の AudioBufferSourceNode で transport に合わせて再生する。
 * ファイル内の時刻 startAt + offset が「拍0」（＝ゲームの gameTime 0、最初の拍頭）。
 *   startAt：ファイルのどこからゲーム用に使うか（秒）。フル尺の中の「いちばんゲーム向きな60秒」を切り出す
 *   offset ：startAt から最初の拍頭までの秒数（波形で最初のキック／拍頭を見て決める）
 * 再生は拍0ちょうどに、ファイル位置 startAt + offset から始める（カウントインは曲の前に鳴る）。
 */
export interface ExternalAudio {
	/** 例：'/audio/chaos-beat/burning-heart.mp3'（public/ 配下に置いたファイル） */
	src: string;
	startAt: number;
	offset: number;
	/** 曲の音量 0..1（cue・判定音より小さめに。cue の前後はさらにダッキング） */
	volume: number;
	/** ゲーム終了後も鳴らす秒数（曲に自然な終わりがあるならそこまでの長さにする）。既定 1.5 */
	tail?: number;
	/** tail の最後の何秒でフェードアウトするか。既定 = tail 全体（切り出し曲は終止から徐々に下げる） */
	fadeOut?: number;
	/** 拍0より前から鳴らす秒数（カウントイン中に曲の頭＝ピックアップを鳴らす）。既定 0 */
	preroll?: number;
	/** 曲自身にエンディングがある（合成の終止音を重ねない） */
	ownEnding?: boolean;
	/**
	 * デコーダ差の補正用の目印：ファイルの最初の鋭い立ち上がり（左チャンネルの振幅が level を初めて超える時刻）。
	 * ギャップレス情報の無い MP3 は、ブラウザごとにデコーダ遅延の扱いが違うことがある（数 ms〜数十 ms 前後にずれる）。
	 * 実行時にデコード結果から同じ点を探し、ずれていればその分 offset を補正する（±0.06 秒以内のときだけ）。
	 */
	anchor?: { level: number; time: number };
}

export interface SongCredit {
	/** 例：'Music: 魔王魂' */
	label: string;
	url?: string;
}

/** 手書き譜面の1エントリ。beat はパターン先頭（最初の「タン」）の拍番号。入力拍は beat + pattern.hitBeat */
export interface BeatmapEntry {
	beat: number;
	pattern: string;
	/** 曲の最後の一打（叩けたら FINAL PERFECT / FINAL HIT! 表示。得点は通常どおり） */
	final?: boolean;
}

export interface SongDefinition {
	id: string;
	title: string;
	/** ゲーム本編の長さ（秒）。カウントインは含まない。拍頭に揃えると終止がきれい（例：BPM130 なら 60秒＝130拍） */
	duration: number;
	/** 曲のテンポ。拍グリッド（cue・hitAt・リング・BGM・外部音源）の基準 */
	bpm: number;
	sections: GameSection[];
	/** あれば外部音源モード（合成BGMの代わりに曲を流す）。無ければ合成BGMモード */
	audio?: ExternalAudio;
	/** 外部音源の作者表記（ゲームの下に小さく出す） */
	credit?: SongCredit;
	/**
	 * 手書き譜面（任意・拍番号の昇順）。ここにある拍ではこのパターンを必ず出し、間はセクションの sequencePool で埋める。
	 * 全打を書かなくてよい（サビの頭だけ等）。
	 * 間隔の決まり：次のエントリの beat は「前のエントリの入力拍 + 2」以上にする（見逃した的は入力拍＋1.2拍で消えるため、
	 * それより前のエントリは間に合わず飛ばされる。拍はずらさない＝曲のフレーズを優先）。
	 */
	beatmap?: BeatmapEntry[];
	/** 判定音（コンボで上がる音階）に使う和音（小節ごとに循環、各 [根音, 3度, 5度] Hz）。外部曲は曲のキーに合わせる。既定は Dm */
	harmony?: number[][];
	/** 最後のセクションで 5→1 のカウントを出す（既定 true＝60秒版）。フル尺の曲は false（アウトロを聞かせる） */
	finalCountdown?: boolean;
	/** モード名（スタート画面・結果に出す）。例：'FULL SONG' */
	modeLabel?: string;
}

/** 正式モード：60秒で1曲 */
export const GAME_DURATION = 60;

export const SONG_60: SongDefinition = {
	id: 'normal60',
	title: 'CHAOS BEAT（合成BGM）',
	duration: GAME_DURATION,
	bpm: BPM,
	sections: [
		{
			id: 'intro',
			label: 'INTRO',
			start: 0,
			end: 10,
			sequencePool: ids(EASY_SEQUENCES),
			musicIntensity: 0,
			targetScale: 1.15,
			arrangement: { drums: 'sparse', pad: false, motif: 'main', melodyGain: 0.1, fill: false, crash: false },
		},
		{
			id: 'groove',
			label: 'GROOVE',
			start: 10,
			end: 25,
			sequencePool: [...ids(EASY_SEQUENCES), ...ids(STANDARD_SEQUENCES)],
			musicIntensity: 1,
			targetScale: 1,
			arrangement: { drums: 'basic', pad: false, motif: 'main', melodyGain: 0.1, fill: false, crash: true },
		},
		{
			id: 'build',
			label: 'BUILD',
			start: 25,
			end: 40,
			sequencePool: [...ids(STANDARD_SEQUENCES), ...ids(BUILD_SEQUENCES), ...ids(BUILD_SEQUENCES)],
			musicIntensity: 2,
			targetScale: 1,
			arrangement: { drums: 'drive', pad: false, motif: 'variation', melodyGain: 0.1, fill: true, crash: false },
		},
		{
			id: 'climax',
			label: 'CLIMAX',
			start: 40,
			end: 55,
			sequencePool: [...ids(BUILD_SEQUENCES), ...ids(CLIMAX_SEQUENCES), ...ids(CLIMAX_SEQUENCES)],
			musicIntensity: 3,
			targetScale: 0.92,
			arrangement: { drums: 'drive', pad: true, motif: 'variation', melodyGain: 0.13, fill: false, crash: true },
		},
		{
			id: 'final',
			label: 'FINAL',
			start: 55,
			end: 60,
			sequencePool: ids(FINAL_SEQUENCES),
			musicIntensity: 4,
			targetScale: 0.92,
			arrangement: { drums: 'four', pad: true, motif: 'finale', melodyGain: 0.13, fill: false, crash: true },
		},
	],
};

export const DEFAULT_SONG = SONG_60;

/**
 * 外部音源の曲の雛形（テスト用）。音源ファイルはリポジトリに入れていない。
 * 使うとき：public/audio/chaos-beat/ に利用条件を確認した音源を置き、src・bpm・startAt・offset・sections・credit を実際の曲に合わせる。
 * ページで ?song=external_test を付けると、この曲で遊べる（通常表示は DEFAULT_SONG のまま）。
 * 音源が読めない場合は、同じ拍グリッドの合成BGMで遊べる（ゲームは止まらない）。
 */
export const TEST_EXTERNAL_SONG: SongDefinition = {
	id: 'external_test',
	title: 'External Test',
	duration: GAME_DURATION,
	bpm: 130,
	audio: {
		src: '/audio/chaos-beat/test-song.mp3',
		startAt: 0,
		offset: 0,
		volume: 0.8,
		tail: 1.5,
	},
	credit: { label: 'Music: （テスト音源）' },
	// 曲の構成に合わせて秒で指定（小節頭に丸まる）。例：Aメロ=INTRO/GROOVE、Bメロ=BUILD、サビ=CLIMAX、サビ終わり=FINAL
	sections: SONG_60.sections,
	// 例：サビ頭で A（拍88開始→入力拍91）、続けて E（拍93開始＝91+2→入力拍96）を固定。間はセクションの譜面で埋まる
	beatmap: [
		{ beat: 88, pattern: 'A' },
		{ beat: 93, pattern: 'E' },
	],
};

// ---------------------------------------------------------------------------------------------
// Burning Heart（魔王魂）フル尺ステージ
// 実音源（maou_08_burning_heart.mp3, 44.1kHz, 312.74 秒）を解析して決めた値（docs/design/chaos-beat.md 参照）：
//   BPM 142.000（キックの立ち上がり 720 個に当てはめ。曲全体で一定＝40 秒ごとの中央残差 0〜3ms）
//   拍0 = ファイル 0.8735 秒（最初の小節頭＝ギターの最初の一撃）。ここから4拍=1小節で最後まで割り切れる
//   構成は小節ごとの帯域エネルギーとクロマの自己相似（同じ進行の繰り返し＝サビ）から：
//     小節 0 INTRO（ギター→8 小節目でドラム）/ 8 サビ1 / 24 リフ / 32 Aメロ / 48 Bメロ / 52 サビ2 / 68 リフ（75 でブレイク）/
//     76 Aメロ2 / 92 Bメロ2 / 96 サビ3 / 112 ブリッジ / 117 ソロ（128 で転調）/ 137 ブレイク / 142 ラスサビ（158 から繰り返し）/
//     169 アウトロ（ドラム終わり）/ 最後の和音 = 拍 708.25（ファイル 300.14 秒）
// 入力の基準は歌ではなく楽器（キック・スネア・クラッシュの小節頭・ブレイクの一撃・最後の和音）。
// ---------------------------------------------------------------------------------------------
const BH_BPM = 142;
const BH_BAR = (4 * 60) / BH_BPM;
const bhBar = (n: number) => n * BH_BAR;
// 判定音の和音（区間のキーに合わせる。オクターブは judgment 側で上げる）
const B_MAJ = [246.94, 311.13, 369.99]; // B – D♯ – F♯（サビ・イントロ・アウトロ）
const EB_MAJ = [311.13, 392.0, 466.16]; // E♭ – G – B♭（リフ・Aメロ・Bメロ：Cm/E♭ の進行）
const D_MIN = [293.66, 349.23, 440.0]; // D – F – A（ソロ後半の転調）

/** Aメロ：休符多め。聞く区間（歌・リード） */
export const BH_VERSE_SEQUENCES: RhythmSequence[] = [
	{ id: 'bv1', patterns: ['A', 'B', 'A', 'D'] },
	{ id: 'bv2', patterns: ['B', 'A', 'D', 'A'] },
	{ id: 'bv3', patterns: ['E', 'A', 'E', 'B'] },
];
/** リフ（2バスの刻み）：8分入りの4拍パターンで一定に */
export const BH_RIFF_SEQUENCES: RhythmSequence[] = [
	{ id: 'br1', patterns: ['E', 'E', 'F', 'E'] },
	{ id: 'br2', patterns: ['F', 'E', 'F', 'A'] },
	{ id: 'br3', patterns: ['E', 'A', 'E', 'F'] },
];
/** Bメロ：サビ前の助走（裏拍の C で溜める） */
export const BH_PRE_SEQUENCES: RhythmSequence[] = [
	{ id: 'bp1', patterns: ['A', 'C', 'A', 'C'] },
	{ id: 'bp2', patterns: ['E', 'C', 'E', 'C'] },
];
/** サビ1：4拍＋「タン ドン」の2拍で密度UP（覚えやすい繰り返し＝PERFECT を続けて FEVER に入りやすい） */
export const BH_CHORUS1_SEQUENCES: RhythmSequence[] = [
	{ id: 'bc1', patterns: ['A', 'H', 'A', 'H'] },
	{ id: 'bc2', patterns: ['E', 'H', 'E', 'A'] },
	{ id: 'bc3', patterns: ['A', 'A', 'H', 'H'] },
];
/** サビ2・3：サビ1＋裏拍（C/G）を少し */
export const BH_CHORUS_SEQUENCES: RhythmSequence[] = [
	{ id: 'bc4', patterns: ['E', 'H', 'C', 'H'] },
	{ id: 'bc5', patterns: ['A', 'H', 'G', 'H'] },
	{ id: 'bc6', patterns: ['C', 'H', 'E', 'H'] },
];
/** ソロ：裏拍入力（C/G/J）と短い連続（H）が主役。譜面の性格を変える */
export const BH_SOLO_SEQUENCES: RhythmSequence[] = [
	{ id: 'bs1', patterns: ['C', 'J', 'C', 'J'] },
	{ id: 'bs2', patterns: ['G', 'H', 'G', 'H'] },
	{ id: 'bs3', patterns: ['F', 'J', 'E', 'J'] },
	{ id: 'bs4', patterns: ['J', 'J', 'G', 'C'] },
];
/** ラスサビ：ここまでに出たパターンの総復習（サビの H ＋ ソロの J/G/C を組み合わせる。新しい形は出さない） */
// 平均の間隔 約2.6拍（サビ 約3.1拍・ソロ 約3.2拍より詰める）＋的が小さめ（0.9）＝いちばんの難所
export const BH_FINAL_SEQUENCES: RhythmSequence[] = [
	{ id: 'bf1', patterns: ['H', 'H', 'E', 'H'] },
	{ id: 'bf2', patterns: ['J', 'H', 'C', 'H'] },
	{ id: 'bf3', patterns: ['H', 'J', 'H', 'G'] },
	{ id: 'bf4', patterns: ['F', 'H', 'J', 'H'] },
	{ id: 'bf5', patterns: ['E', 'H', 'H', 'J'] },
];

for (const seq of [
	...BH_VERSE_SEQUENCES,
	...BH_RIFF_SEQUENCES,
	...BH_PRE_SEQUENCES,
	...BH_CHORUS1_SEQUENCES,
	...BH_CHORUS_SEQUENCES,
	...BH_SOLO_SEQUENCES,
	...BH_FINAL_SEQUENCES,
])
	SEQUENCE_BY_ID[seq.id] = seq;

/** サビ入りの決めフレーズ（全サビ共通＝覚えられる）：小節頭 D にドン → 2拍ごとに ドン・ドン → 4拍溜めてドン */
function chorusEntry(d: number, lead: string): BeatmapEntry[] {
	return [
		{ beat: d - 3, pattern: lead }, // Bメロ/フィルの3拍を「タン」で数えて、サビ頭（クラッシュ）で「ドン」
		{ beat: d + 1, pattern: 'H' },
		{ beat: d + 3, pattern: 'H' },
		{ beat: d + 5, pattern: 'A' },
	];
}
/** ソロの決めフレーズ：小節頭のドン → 裏拍 → 裏拍 → 裏拍（d, d+2.5, d+5.5, d+8.5。ラスサビ後半でもう一度＝総復習） */
function soloPhrase(d: number): BeatmapEntry[] {
	return [
		{ beat: d - 3, pattern: 'A' },
		{ beat: d + 1, pattern: 'J' },
		{ beat: d + 4, pattern: 'J' },
		{ beat: d + 6, pattern: 'C' },
	];
}

const arr = (
	drums: SectionArrangement['drums'],
	pad: boolean,
	fill = false,
	crash = true,
): SectionArrangement => ({ drums, pad, motif: pad ? 'variation' : 'main', melodyGain: 0.1, fill, crash });

export const BURNING_HEART_SONG: SongDefinition = {
	id: 'burning-heart',
	title: 'Burning Heart',
	modeLabel: 'FULL SONG',
	bpm: BH_BPM,
	// 最後の和音（拍 708.25）の直後＝拍 710（300.0 秒）で本編終了。曲の余韻は tail で最後まで流す
	duration: 710 * (60 / BH_BPM),
	finalCountdown: false,
	audio: {
		src: '/audio/chaos-beat/maou_08_burning_heart.mp3',
		startAt: 0,
		offset: 0.8735,
		preroll: 0.8735, // ファイルの頭（拍0の前のピックアップ）からカウントイン中に鳴らす
		volume: 0.75,
		tail: 6.2, // 最後の和音の余韻（ファイル 306 秒付近まで）
		fadeOut: 1.0,
		ownEnding: true,
		anchor: { level: 0.1, time: 0.87283 },
	},
	credit: { label: 'Music: 魔王魂', url: 'https://maou.audio/' },
	harmony: [B_MAJ],
	sections: [
		{ id: 'intro', label: 'INTRO', start: bhBar(0), end: bhBar(8), sequencePool: ids(EASY_SEQUENCES), musicIntensity: 0,
			targetScale: 1.15, autoFill: false, duck: 0.5, harmony: [B_MAJ], arrangement: arr('sparse', false, true, false) },
		{ id: 'chorus', label: 'CHORUS', start: bhBar(8), end: bhBar(24), sequencePool: ids(BH_CHORUS1_SEQUENCES), musicIntensity: 3,
			targetScale: 1, hype: 1, chaosSpeed: 6.8, duck: 0.38, harmony: [B_MAJ], arrangement: arr('drive', true) },
		{ id: 'riff', label: 'RIFF', start: bhBar(24), end: bhBar(32), sequencePool: ids(BH_RIFF_SEQUENCES), musicIntensity: 2,
			targetScale: 1, duck: 0.4, harmony: [EB_MAJ], arrangement: arr('four', false) },
		{ id: 'verse', label: 'VERSE', start: bhBar(32), end: bhBar(48), sequencePool: ids(BH_VERSE_SEQUENCES).slice(0, 2), musicIntensity: 1,
			targetScale: 1.05, restBeats: 4, duck: 0.45, harmony: [EB_MAJ], arrangement: arr('basic', false, false, false) },
		{ id: 'pre', label: 'PRE-CHORUS', start: bhBar(48), end: bhBar(52), sequencePool: ids(BH_PRE_SEQUENCES), musicIntensity: 2,
			targetScale: 1, restBeats: 1, duck: 0.42, harmony: [EB_MAJ], arrangement: arr('drive', false, true, false) },
		{ id: 'chorus', label: 'CHORUS', start: bhBar(52), end: bhBar(68), sequencePool: [...ids(BH_CHORUS1_SEQUENCES), ...ids(BH_CHORUS_SEQUENCES)], musicIntensity: 3,
			targetScale: 1, hype: 1, chaosSpeed: 6.8, duck: 0.38, harmony: [B_MAJ], arrangement: arr('drive', true) },
		{ id: 'riff', label: 'RIFF', start: bhBar(68), end: bhBar(76), sequencePool: ids(BH_RIFF_SEQUENCES), musicIntensity: 2,
			targetScale: 1, duck: 0.4, harmony: [EB_MAJ], arrangement: arr('four', false) },
		{ id: 'verse', label: 'VERSE', start: bhBar(76), end: bhBar(92), sequencePool: ids(BH_VERSE_SEQUENCES), musicIntensity: 1,
			targetScale: 1.05, restBeats: 3, duck: 0.45, harmony: [EB_MAJ], arrangement: arr('basic', false, false, false) },
		{ id: 'pre', label: 'PRE-CHORUS', start: bhBar(92), end: bhBar(96), sequencePool: ids(BH_PRE_SEQUENCES), musicIntensity: 2,
			targetScale: 1, restBeats: 1, duck: 0.42, harmony: [EB_MAJ], arrangement: arr('drive', false, true, false) },
		{ id: 'chorus', label: 'CHORUS', start: bhBar(96), end: bhBar(112), sequencePool: ids(BH_CHORUS_SEQUENCES), musicIntensity: 3,
			targetScale: 0.96, hype: 1, chaosSpeed: 6.8, duck: 0.38, harmony: [B_MAJ], arrangement: arr('drive', true) },
		{ id: 'bridge', label: 'BRIDGE', start: bhBar(112), end: bhBar(117), sequencePool: ids(BH_SOLO_SEQUENCES), musicIntensity: 2,
			targetScale: 1, autoFill: false, duck: 0.42, harmony: [B_MAJ], arrangement: arr('sparse', false, false, true) },
		{ id: 'solo', label: 'GUITAR SOLO', start: bhBar(117), end: bhBar(137), sequencePool: ids(BH_SOLO_SEQUENCES), musicIntensity: 3,
			targetScale: 0.95, duck: 0.4,
			// ソロ：小節 117–120 は B のペダル、121–127 は E♭、128 から D へ転調（小節ごとに循環せず、この順に1回）
			harmony: [...Array(4).fill(B_MAJ), ...Array(7).fill(EB_MAJ), ...Array(9).fill(D_MIN)],
			arrangement: arr('drive', false) },
		{ id: 'break', label: 'BREAK', start: bhBar(137), end: bhBar(142), sequencePool: ids(EASY_SEQUENCES), musicIntensity: 1,
			targetScale: 1.05, autoFill: false, duck: 0.45, harmony: [B_MAJ], arrangement: arr('sparse', false, true, false) },
		{ id: 'final_chorus', label: 'FINAL CHORUS', start: bhBar(142), end: bhBar(169), sequencePool: ids(BH_FINAL_SEQUENCES), musicIntensity: 4,
			targetScale: 0.9, hype: 2, chaosSpeed: 6.5, duck: 0.36, harmony: [B_MAJ], arrangement: arr('four', true) },
		{ id: 'outro', label: 'OUTRO', start: bhBar(169), end: bhBar(178), sequencePool: ids(EASY_SEQUENCES), musicIntensity: 1,
			targetScale: 1.1, autoFill: false, duck: 0.5, harmony: [B_MAJ], arrangement: arr('sparse', false, false, false) },
	],
	// 手書き譜面：曲の決めどころだけ固定（間はセクションの譜面）。beat はパターン先頭の拍、入力拍 = beat + hitBeat
	beatmap: [
		// INTRO：ギターだけの4小節＋ベースの4小節を、4〜8拍おきの小さな一打で。8小節目のフィルを数えてサビ頭（拍32）でドン
		{ beat: 9, pattern: 'A' }, // → 12
		{ beat: 17, pattern: 'B' }, // → 20
		{ beat: 23, pattern: 'D' }, // → 26
		...chorusEntry(32, 'A'), // → 32, 34, 36, 40
		...chorusEntry(208, 'E'), // サビ2
		{ beat: 297, pattern: 'A' }, // リフの最後の小節（75）：頭の一撃で全員が止まる → 拍300
		...chorusEntry(384, 'E'), // サビ3
		// BRIDGE：シンコペーションの一発ずつ（長めの休符→一打）
		{ beat: 451, pattern: 'G' }, // → 454.5
		{ beat: 459, pattern: 'C' }, // → 461.5
		...soloPhrase(468), // ソロ頭（小節117）→ 468, 470.5, 473.5, 478.5
		{ beat: 545, pattern: 'A' }, // ブレイク頭の一撃（小節137）→ 548。そこから約20拍は聞くだけ
		...chorusEntry(568, 'E'), // ラスサビ（ドラムが戻る小節142）
		...soloPhrase(632), // ラスサビ後半（小節158）でソロの決めフレーズをもう一度
		{ beat: 673, pattern: 'A' }, // ドラム最後の一撃（小節169）→ 676
		{ beat: 705, pattern: 'Z', final: true }, // 最後の和音 → 708.25（FINAL HIT）
	],
};

/** id → 曲。ページの ?song= で選べる */
// ---------------------------------------------------------------------------------------------
// SUMMER TRIANGLE（外部音源）フル尺ステージ
// 自動解析（scripts/analyze-audio.mjs：WASM MP3デコード + music-tempo + 1秒RMS）で決めた値：
//   BPM 175.0（music-tempo 175.01／全ビート平均間隔 0.3429s＝175.0。楽譜情報でも 4/4・175）
//   拍0 ≈ ファイル 0.72 秒（最初の拍）。offset は ?debug=1 の拍ズレ表示で最終確認する。
//   構成（1秒RMSのブレイク=急落から）：0–10 イントロ/Aメロ / ~10–30 上昇 / 31 ブレイク / 33–52 サビ1(ピーク51) /
//     52–59 間奏 / 60–85 Bメロ→再上昇 / 86 ブレイク / 88–114 ラスサビ(ピーク106) / 114–128 アウトロ→終止(127≈無音)
//   セクション秒は gameTime（=ファイル時刻 − offset）。system が小節頭に丸める。
// ※ライセンス/クレジット：公開前に必ず利用条件を確認し credit を正しい表記に（未確認のまま本番公開しないこと）。
// ---------------------------------------------------------------------------------------------
const stArr = (drums: SectionArrangement['drums'], pad = false): SectionArrangement => ({
	drums,
	pad,
	motif: pad ? 'variation' : 'main',
	melodyGain: 0.1,
	fill: false,
	crash: true,
});
export const SUMMER_TRIANGLE_SONG: SongDefinition = {
	id: 'summer-triangle',
	title: 'SUMMER TRIANGLE',
	modeLabel: 'FULL SONG',
	bpm: 175,
	duration: 124, // gameTime 秒（アウトロ手前まで。system が小節頭に丸める）
	finalCountdown: false,
	audio: {
		src: '/audio/chaos-beat/summer_triangle.mp3',
		startAt: 0,
		offset: 0.72, // ?debug=1 で実音と拍を見ながら確定する
		volume: 0.72,
		tail: 3,
		fadeOut: 1.5,
		ownEnding: true,
		anchor: { level: 0.15, time: 0.72 },
	},
	credit: { label: 'Music: SUMMER TRIANGLE（※クレジット/ライセンス要確認）' },
	sections: [
		{ id: 'intro', label: 'INTRO', start: 0, end: 10, sequencePool: ids(EASY_SEQUENCES), musicIntensity: 0, targetScale: 1.1, duck: 0.45, arrangement: stArr('sparse') },
		{ id: 'groove', label: 'GROOVE', start: 10, end: 30, sequencePool: [...ids(EASY_SEQUENCES), ...ids(STANDARD_SEQUENCES)], musicIntensity: 1, targetScale: 1, duck: 0.42, arrangement: stArr('basic') },
		{ id: 'pre', label: 'PRE-CHORUS', start: 30, end: 32, sequencePool: ids(STANDARD_SEQUENCES), musicIntensity: 2, targetScale: 1, duck: 0.42, arrangement: stArr('drive') },
		{ id: 'chorus', label: 'CHORUS', start: 32, end: 51, sequencePool: [...ids(STANDARD_SEQUENCES), ...ids(CLIMAX_SEQUENCES)], musicIntensity: 3, targetScale: 0.95, hype: 1, duck: 0.38, arrangement: stArr('drive', true) },
		{ id: 'interlude', label: 'INTERLUDE', start: 51, end: 59, sequencePool: [...ids(EASY_SEQUENCES), ...ids(STANDARD_SEQUENCES)], musicIntensity: 1, targetScale: 1.05, duck: 0.45, arrangement: stArr('basic') },
		{ id: 'build', label: 'BUILD', start: 59, end: 85, sequencePool: [...ids(STANDARD_SEQUENCES), ...ids(BUILD_SEQUENCES)], musicIntensity: 2, targetScale: 1, duck: 0.4, arrangement: stArr('drive') },
		{ id: 'break', label: 'BREAK', start: 85, end: 87, sequencePool: ids(EASY_SEQUENCES), musicIntensity: 1, targetScale: 1.05, duck: 0.45, arrangement: stArr('sparse') },
		{ id: 'final_chorus', label: 'FINAL CHORUS', start: 87, end: 113, sequencePool: [...ids(CLIMAX_SEQUENCES), ...ids(FINAL_SEQUENCES)], musicIntensity: 4, targetScale: 0.92, hype: 2, duck: 0.36, arrangement: stArr('four', true) },
		{ id: 'outro', label: 'OUTRO', start: 113, end: 124, sequencePool: ids(EASY_SEQUENCES), musicIntensity: 1, targetScale: 1.05, duck: 0.5, arrangement: stArr('sparse') },
	],
};

export const SONGS: Record<string, SongDefinition> = {
	[SONG_60.id]: SONG_60,
	[TEST_EXTERNAL_SONG.id]: TEST_EXTERNAL_SONG,
	[BURNING_HEART_SONG.id]: BURNING_HEART_SONG,
	[SUMMER_TRIANGLE_SONG.id]: SUMMER_TRIANGLE_SONG,
};

const gridCache = new WeakMap<SongDefinition, BeatGrid>();
/** 曲の拍グリッド（BPM は曲ごと） */
export function gridOf(song: SongDefinition): BeatGrid {
	let g = gridCache.get(song);
	if (!g) {
		g = makeGrid(song.bpm);
		gridCache.set(song, g);
	}
	return g;
}


/**
 * セクションの実際の開始時刻（transport 秒）。設計値の秒を「最寄りの小節頭」へ丸める。
 * → BGM のアレンジ切替・section_change・譜面プールの切替が全部同じ小節頭で起きる（beat grid 上）。
 * 先頭セクションは常に 0。
 */
export function sectionStart(song: SongDefinition, index: number): number {
	if (index <= 0) return 0;
	const bar = 4 * gridOf(song).spb; // 小節（4拍）は曲の BPM から
	return Math.round(song.sections[index].start / bar) * bar;
}

/** transport 時刻 t が属するセクションの index（t<0 は 0、t≥duration は最後） */
export function sectionIndexAt(song: SongDefinition, t: number): number {
	let idx = 0;
	for (let i = 1; i < song.sections.length; i++) {
		if (t + 1e-6 >= sectionStart(song, i)) idx = i;
	}
	return idx;
}

export function sectionAt(song: SongDefinition, t: number): GameSection {
	return song.sections[sectionIndexAt(song, t)];
}
