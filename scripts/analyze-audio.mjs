// 音源解析スクリプト（BPM・最初の拍位置・エネルギー推移）。新曲を CHAOS BEAT に追加するとき用。
// ffmpeg 不要：WASM の MP3 デコーダ + 純JS のテンポ検出。
// 先に依存を入れる（出荷物には含めない）: npm i --no-save mpg123-decoder music-tempo
// 使い方: node scripts/analyze-audio.mjs "C:/path/to/song.mp3"
import fs from 'node:fs';
import { MPEGDecoder } from 'mpg123-decoder';
import MusicTempo from 'music-tempo';

const path = process.argv[2] || 'C:/Users/zeak2/Downloads/SUMMER_TRIANGLE.mp3';
const bytes = fs.readFileSync(path);

const dec = new MPEGDecoder();
await dec.ready;
const { channelData, samplesDecoded, sampleRate } = dec.decode(new Uint8Array(bytes));
dec.free();

const L = channelData[0];
const R = channelData[1] || channelData[0];
const n = samplesDecoded;
const dur = n / sampleRate;
console.log(`decoded: ${n} samples, ${sampleRate} Hz, ${dur.toFixed(2)} s`);

// mono（music-tempo は通常配列を想定）
const mono = new Array(n);
for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;

// テンポ・ビート検出
const mt = new MusicTempo(mono, { timeStep: 0.01 });
console.log(`\n=== TEMPO ===`);
const bpm = Number(mt.tempo);
console.log(`BPM: ${bpm.toFixed(2)} (raw: ${mt.tempo})`);
const beats = (mt.beats || []).map(Number);
console.log(`beats detected: ${beats.length}`);
console.log(`first 8 beat times(s): ${beats.slice(0, 8).map((b) => b.toFixed(3)).join(', ')}`);
// 拍間隔の中央値からも BPM を確認
if (beats.length > 4) {
	const ivs = [];
	for (let i = 1; i < beats.length; i++) ivs.push(beats[i] - beats[i - 1]);
	ivs.sort((a, b) => a - b);
	const med = ivs[ivs.length >> 1];
	console.log(`median beat interval: ${med.toFixed(4)} s → ${(60 / med).toFixed(2)} BPM`);
	console.log(`first beat (≈offset候補): ${beats[0].toFixed(3)} s`);
}

// エネルギー推移（1秒ごとの RMS）→ セクション境界の目安
console.log(`\n=== ENERGY (RMS per 1s) ===`);
const win = sampleRate; // 1s
const rms = [];
for (let s = 0; s + win <= n; s += win) {
	let sum = 0;
	for (let i = s; i < s + win; i++) sum += mono[i] * mono[i];
	rms.push(Math.sqrt(sum / win));
}
const maxR = Math.max(...rms) || 1;
rms.forEach((r, i) => {
	const bar = '#'.repeat(Math.round((r / maxR) * 40));
	console.log(`${String(i).padStart(3)}s ${(r / maxR).toFixed(2)} ${bar}`);
});
