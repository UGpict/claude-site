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
- 時間：`gameTime`（0→30秒でカウントアップ、**実時間**で計る）。`TIME_LIMIT`(15秒)概念は廃し `GAME_TIME=30`。
- ターゲット：常に1つ `target`。**寿命 `TARGET_TTL=3秒`**。`gameTime - target.bornAt > TTL` で消滅 →
  その的は MISS（コンボ切断・0点）→ 即 `newTarget()`。「じっと待つ」を最適戦略にしないための肝。
- **入力ロック**：`act()` の先頭で `if (state !== 'playing') return;`。slowmo/over 中の入力は無視。
- 叩く（act）時（state==='playing' のときだけ）：
  1. 距離 d を計算し判定 kind を決める（perfect/great/good/near/miss）。
  2. **加点は GOOD 以上のみ**。順序：判定 → GOOD以上なら combo+1 → 倍率再計算 → `score += round(pts × comboMult)`。
     NEAR/MISS は combo=0・加点なし。maxCombo 更新。
  3. `slowmo` に入り timeScale を落として ~0.2秒 → 次のターゲット生成 → `playing` へ。
  4. `onEvent('hit', { kind, pts, score, combo, comboMult, maxCombo, distancePx, nearMissPx })` を通知。
- 寿命切れ MISS も同じく combo=0・0点で `onEvent('hit', {kind:'miss', ...})` を出し、slowmo は挟まず即次でよい。
- 30秒経過：`over`。`onEvent('game_over', { score, maxCombo, hits, perfectCount })`。

### BPM 脈動（Phase 1・視覚）
- `BPM=130`（120〜140）。`beatPhase = (gameTime % (60/BPM)) / (60/BPM)`（0→1）。
- 描画時、ターゲット半径に脈動を掛ける：`rDraw = R * (1 + 0.18 * pulse(beatPhase))`。
  `pulse` は拍頭で膨らみ減衰する形（例：`Math.max(0, 1 - beatPhase*1.6)` 等）。物理・判定距離は素の R を使う（見た目だけ脈動）。
- 音（拍のクリック）は Phase 2。Phase 1 は視覚脈動のみ。

### 固定タイムステップ（予測一致のための不変条件・重要）
- 物理は**固定ステップ FIXED_H(=1/300秒)** で進める（accumulator: `acc += dt*timeScale`、`while(acc>=FIXED_H) rk4(s,FIXED_H)`）。
- 可変 dt で積分すると、カオスなのでフレームレート差だけで軌道がズレ、`predictPath` と実機が食い違い
  「的を通らない」不具合になる。固定ステップなら軌道が毎回同じ離散列になり、予測が**完全一致**する。
- `predictPath` も必ず同じ FIXED_H で積分すること。ここを崩すと的の配置が破綻する。

### timeScale
- timeScale は「1フレームで進める**ステップ数**」を変えるだけ（ステップ幅 FIXED_H は不変）。だから軌道は変わらず速度だけ変わる。
- slowmo 中：0.15。Magnet Assist：的付近で 0.6〜0.82（難易度別）。通常：1.0（鬼は 1.3）。30秒判定は実 dt で計る。

## ターゲット生成（軌道上に置く）
- ランダムな位置だと先端が通らず理不尽になる。→ **これから先端が通る軌道上**に置く。
- `predictPath()`：現在の状態 s から通常速度・ループと同じ積分（PRED_DT=1/60, 10サブステップ）で
  ~1.4秒先まで先端位置を予測。二重振り子はカオスなので horizon は短く保ち近い将来だけ信頼する。
- `newTarget()`：予測パスの 0.5〜1.4秒先からランダムに1点を選び的にする。
  到達予測時刻（idx×PRED_DT）＋猶予0.9秒を `expireAt` にし、通過後の間延びを防ぐ（見逃しでコンボ切断）。
- ターゲットは `{ x, y, r, bornAt, expireAt }`。Phase 3 の動く的/ボーナス的は `type` を足して拡張。

## 判定しきい値
- `R = TARGET_R`（難易度別・従来の targetR を流用）。
- d ≤ 0.35R: perfect / ≤0.7R: great / ≤R: good / ≤1.25R: near / それ超: miss（寿命切れも miss）。
- 基本点 pts は従来式（内部100点満点、分析用）を残すが、**score へ加算するのは GOOD 以上のみ**。NEAR/MISS は 0。
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
