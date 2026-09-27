# design: CHAOS BEAT

spec: [../specs/chaos-beat.md](../specs/chaos-beat.md) を満たす作り方。物理は流用し、ループ・採点・演出・音を差し替える。

## モジュール境界（現状を踏襲）
- `src/scripts/games/chaos-pendulum.ts`：純粋エンジン。物理（deriv/rk4/tips）は不変。
  ループ・状態機械・採点・ターゲット生成・スロー演出・パーティクルを**この中で**作り替える。
  外へは従来どおり `onEvent(name, payload)` だけで通知（Astro/音/保存/通信を知らない）。
- `src/scripts/games/audio.ts`：Web Audio。ビート・レイヤー音楽・判定SEを拡張。
- `src/scripts/games/storage.ts`：自己ベスト（難易度別）。指標を score＋maxCombo に。
- `src/scripts/games/ranking.ts` / `functions/api/games/chaos-pendulum/*`：D1 通信。maxCombo 追加。
- `src/components/games/ChaosPendulum.astro`：DOM・スタイル・各モジュールの橋渡し。HUD（コンボ/スコア/残り時間）と結果パネルを作り替える。

## エンジンの状態機械（作り替え）
現状の `run/stopped/over`（5ラウンド）を、連続プレイ用に変える。

- 状態：`playing`（30秒進行中）/ `slowmo`（判定スロー中）/ `over`（終了）。
- 時間：`gameTime`（0→30秒でカウントアップ）。`TIME_LIMIT` 概念は廃し「総制限時間 GAME_TIME=30」。
- ターゲット：常に1つ `target`。叩く or 一定時間で自動 MISS 扱いにはしない（叩くまで在り続ける）
  → ただしテンポ維持のため「出現から一定秒（例8秒）で自動的に消えて次へ（MISS 扱い）」を入れるか Phase 2 で判断。
- 叩く（act）時：
  1. 距離 d を計算し判定 kind を決める（PERFECT..MISS/NEAR）。
  2. 基本点 pts（0〜100、従来式）を出し、`score += round(pts × comboMult)`。
  3. コンボ更新（GOOD以上 +1 / MISS 0）、maxCombo 更新。
  4. `slowmo` に入り timeScale を落として ~0.2秒 → 次のターゲット生成 → `playing` へ。
  5. `onEvent('hit', { kind, pts, distancePx, combo, comboMult, score })` を通知。
- 30秒経過：`over`。`onEvent('game_over', { score, maxCombo, ... })`。

### timeScale
- ループの物理積分ステップに `timeScale` を掛ける（`dt * timeScale` を積分に使う。実時間の経過＝30秒判定は実 dt で計る）。
- slowmo 中：timeScale≈0.15。Magnet Assist（Phase2）：的付近で timeScale≈0.65。通常：1.0（鬼は 1.3）。

## ターゲット生成
- `newTarget()`：`ang=rand(0,2π)`, `dist=rand(distRange)` で配置（現行と同様、届く範囲）。
- Phase 3 で「動く的」「ボーナス的（色・効果）」を `target.type` として拡張できるよう、
  ターゲットを `{ x, y, r, type, bornAt }` の形に持たせる。

## 判定しきい値
- `R = TARGET_R`（難易度別・従来の targetR を流用）。
- d ≤ 0.35R: perfect / ≤0.7R: great / ≤R: good / ≤1.25R: near / それ超: miss。
- 基本点 pts は従来式（d≤R は `100 - round(d/R*20)`、超過は部分点）を維持し、内部100点満点を残す。
- 「あと Npx」：`px = round((d - R) * scale)`（scale はワールド→画面の係数、resize で既知）。

## イベント（onEvent）設計
既存の GameEventName を作り替える：
- `game_start`：開始。
- `hit`：{ kind, pts, score, combo, comboMult, maxCombo, distancePx, nearMissPx? }
- `fever_start` / `fever_end`（Phase 2）
- `game_over`：{ score, maxCombo, hits, perfectCount }
- 計測（GA4）は従来どおりコンポーネントで trackGameEvent に橋渡し。

## 音（audio.ts）
- `beat` クロック：AudioContext の currentTime を基準に BPM で拍を刻む（`requestAnimationFrame` ではなく先読みスケジューリング）。
- レイヤー：drum/bass/synth/melody をコンボ段階で mute/unmute。
- 判定SE：PERFECT=豪華アルペジオ（既存強化）、GREAT/GOOD=軽め、MISS=濁り。
- コンポーネント側が `hit`/`fever_*` を受けて audio に指示（エンジンは音を知らない）。
- Phase 1 は判定SEのみ、ビート/レイヤーは Phase 2/3。

## データ（D1）
- 追加：`max_combo INTEGER NOT NULL DEFAULT 0`（migration 0003）。
- 意味の再定義：`score`=30秒合計、`perfect_count`=PERFECT数、`rounds`=総ヒット数（or 未使用）、`average_distance`=平均ヒット距離。
- 既存行（5ラウンド時代）は指標が別物 → 切替時に **DELETE 全行**（開発初期・少数のため許容）。
- ランキング並び：`ORDER BY score DESC, max_combo DESC, created_at ASC`（難易度別・期間別は現状踏襲）。
- 送信検証：score 上限を新レンジに合わせて緩める。コンボ・ヒット数の軽い整合のみ（過剰なアンチチートはしない）。

## 失敗時の挙動
- 音が出せない環境：無音で進行（現状踏襲）。
- ランキングAPI障害：スコアは残り、送信のみスキップ（現状踏襲）。
- 低スペックで重い：物理サブステップ数と描画を軽くできるよう定数化しておく。

## コード一貫性の下ごしらえ
- 5ラウンド前提の名残（ROUNDS, 「次へ」ボタン, `/500` 表記, round_complete）は作り替え時に一掃する。
- 表記ゆれ（ラウンド/ステージ）を「ヒット/コンボ/タイム」に統一。
