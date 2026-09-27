// CHAOS BEAT の「曲」定義（譜面＋曲構成）。エンジンと audio が共有するデータだけを置く。
// DOM・AudioContext に依存しない。時刻はすべて transport 時刻（拍0=0 秒）。
//
// 1曲 = GAME_DURATION 秒を INTRO → GROOVE → BUILD → CLIMAX → FINAL のセクションに分ける。
// セクションは「曲そのものの進行（譜面の性格・基本アレンジ）」。コンボで解放される音の層とは別概念。
// 将来 QUICK 30 / NORMAL 60 / FULL 90 などは SongDefinition を増やすだけで作れるようにしてある（今は60秒のみ）。

import { SPB } from './beat-grid';

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

export type SectionId = 'intro' | 'groove' | 'build' | 'climax' | 'final';

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
}

export interface SongDefinition {
	id: string;
	/** ゲーム本編の長さ（秒）。カウントインは含まない */
	duration: number;
	sections: GameSection[];
}

/** 正式モード：60秒で1曲 */
export const GAME_DURATION = 60;

export const SONG_60: SongDefinition = {
	id: 'normal60',
	duration: GAME_DURATION,
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

const BAR = 4 * SPB;
/**
 * セクションの実際の開始時刻（transport 秒）。設計値の秒を「最寄りの小節頭」へ丸める。
 * → BGM のアレンジ切替・section_change・譜面プールの切替が全部同じ小節頭で起きる（beat grid 上）。
 * 先頭セクションは常に 0。
 */
export function sectionStart(song: SongDefinition, index: number): number {
	if (index <= 0) return 0;
	return Math.round(song.sections[index].start / BAR) * BAR;
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
