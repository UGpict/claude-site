# design: CHAOS BEAT

spec: [../specs/chaos-beat.md](../specs/chaos-beat.md) を満たす作り方（現行実装に一致させている）。
廃止済みの案は spec 末尾「廃止済み仕様」を参照。この文書には現行の設計だけを書く。

## モジュール境界
- `src/scripts/games/beat-grid.ts`：**拍の唯一の定義**。`BPM=130` / `SPB` / `COUNTIN_BEATS=4` /
  `beatTime(beatIndex)` / `nextBeatIndex(t)` / `beatPhase(t)`。DOM・AudioContext に依存しない。
- `src/scripts/games/chaos-pendulum.ts`：純粋エンジン。物理（deriv/rk4/tips）は不変。
  状態機械・採点・ターゲット生成・描画・集計。外へは `onEvent(name, payload)` だけで通知（Astro/音/保存/通信を知らない）。
  時計は `options.now`（外から注入される transport 時刻）だけを使い、**AudioContext は知らない**。
- `src/scripts/games/audio.ts`：Web Audio。共通 transport・BGM スケジューラ・cue 予約・ダッキング・判定SE。
- `src/scripts/games/storage.ts`：自己ベスト（難易度別、score＋maxCombo）。
- `src/scripts/games/ranking.ts` / `functions/api/games/chaos-pendulum/*`：D1 通信。
- `src/components/games/ChaosPendulum.astro`：DOM・スタイル・TAP TO START・各モジュールの橋渡し（唯一の開始経路 `startGame`）。

## 共通トランスポート時計（最重要の同期基盤）

```
user start（TAP / クリック / Space / もう一回 / 難易度変更）
  → audio.startTransport(COUNTIN_BEATS)
      ① ensureCtx()＋AudioContext.resume() を要求（ジェスチャー内・同期）→ running を待つ（最大0.5秒）
      ② transport.startTime = currentTime + START_DELAY(0.3) + 4×SPB   ← 拍0。ここで1回だけ決める
      ③ BGM スケジューラを拍0から開始、カウントイン（拍 -4..-1 タン、拍0 ドン）を予約
  → handle.start({ difficulty, retry })   ← gameTime = audio.now() < 0 なので state='countin'
  → 拍0（gameTime ≥ 0）で state='playing'＋最初の的
```

- `AudioTransport { startTime, bpm, secondsPerBeat, clock: 'audio' | 'performance' }`。
- `audio.now() = ctx.currentTime − startTime`（拍0で 0、カウントイン中は負）。エンジンには `now: () => audio.now()` として
  **関数だけ**渡す（エンジンは AudioContext を知らない）。`gameTime = now()`（rAF 累積はしない）。
- AudioContext が無い／resume できない環境は `clock='performance'`（`performance.now()` 基準）で**無音のまま進行**だけ保証する。
- 共通式：どの要素も **`audioTime = startTime + beatTime(beatIndex)`**。
  | 要素 | 拍の決め方 |
  | --- | --- |
  | BGM 拍頭 | `scheduleBgmBeat(n, startTime + n×SPB)`（加算で誤差を溜めず毎回この式で再計算） |
  | cue（タン/ドン） | エンジンが `beatTime(startBeat + cue.beat)` を transport 時刻で emit → audio が `startTime + time` に予約 |
  | target.hitAt | `beatTime(hitBeat)`、`hitBeat = nextBeatIndex(gameTime) + pattern.hitBeat` |
  | アプローチリング | `(gameTime − bornAt)/(hitAt − bornAt)` が 1 になる瞬間に的へ収束＝`beatTime(hitBeat)` |
  | 的の脈動・FEVER 明滅 | `beatPhase(gameTime)`（拍頭で 0） |
- cue は「今から何秒後（相対 offset）」ではなく **transport 時刻（絶対）** で渡す。emit と予約の間に currentTime が進んでも位相がズレない。
- 初回・retry・難易度変更は全部 `startGame()` → `startTransport()` → `handle.start()` の同じ経路。
  連打は `starting` フラグ＋トークンで無視。retry（結果表示中の開始）だけ `game_retry` を先に emit。
- 既知の未補正：出力レイテンシ（`outputLatency`、Bluetooth で大きい）は未補正。`averageTimingOffsetMs` で実機傾向を見て判断する。

## エンジンの状態機械
- 状態：`idle`（TAP TO START 待ち・静止プレビュー）/ `countin`（gameTime<0）/ `playing` / `slowmo`（判定スロー）/ `over`。
- `GAME_TIME = 30`（transport 時刻で計る。カウントインは含まない）。
- ターゲット：常に1つ `{ x, y, r, bornAt, hitBeat, hitAt, expireAt = hitAt + 1.2拍 }`。
  `gameTime > expireAt` で寿命切れ MISS（combo=0・0点・`expired:true`）→ 即 `newTarget()`（slowmo なし）。
- **入力ロック**：`act()` の先頭で `if (state !== 'playing') return;`。
- 叩く：距離 d → kind → GOOD以上なら combo+1 → 倍率再計算 → `score += round(pts × mult × (fever?2:1))`。
  `hit` を emit → `slowmo`（0.2秒）→ `newTarget()` → `playing`。
- 30秒経過で `over`、集計つき `game_over` を emit。

### 固定タイムステップ（予測一致のための不変条件）
- 物理は **FIXED_H = 1/300 秒** 固定（`acc += dt × timeScale`、`while (acc ≥ FIXED_H) rk4(s, FIXED_H)`）。
  `predictPath` も同じ FIXED_H で積分するので予測と実機が**完全一致**する。
- `dt = now() − 前フレーム` を **0.25秒まで**追従（1フレーム最大90ステップ）。小さくクランプすると物理が transport から恒久的に遅れて的を通らなくなる。
  それを超える停止（タブ非表示など）は、的が寿命切れ→次の的で予測し直すので自然に再同期する。
- `newTarget()` は `acc`（未消化時間）も足して `(hitAt − gameTime + acc) / FIXED_H` ステップ後の予測点を引く。

### timeScale（リズム整合）
- 的が生きている `playing` 中は **timeScale = 1**。`slowmo`（0.15）は叩いた直後の的が無い間だけ。
- 難易度・FEVER で物理速度は変えない。

### 譜面
- `RhythmPattern { id, lengthBeats, cues[{beat, sound}], hitBeat }`（A〜D）。
- `RhythmSequence { id, patterns }`。`nextPattern()` がシーケンスを順番に消化 → 尽きたら `pickSequence()`（直前と同じ id を避ける）。
  `hits < 6` は `EASY_SEQUENCES`（A/B）のみ。
- 予測範囲外（>2.6秒）・反応猶予不足（<0.5秒）のときは **パターンごと拍単位でずらす**（hitAt だけをずらさない＝ドンと hitAt が離れない）。

## 音（audio.ts）
- **transport**：上記。`startTransport` は前ゲームの BGM バス（`bgmGain`）を 50ms でフェードして切り離し、新しいバスで拍0から始める。
  未再生の cue も取り消す（前ゲームの残響が新しい拍に混ざらない）。
- **BGM スケジューラ**：`setInterval(25ms)` で `nextBeatTime < currentTime + 0.12` の拍を先読み予約。1拍ごとに
  **その瞬間の musicLevel/feverOn を読む** → 層の切替が拍頭に同期。
  層：drum（kick 0,2＋noise 1,3）/ bass（level≥1）/ hihat 8分（level≥2）/ melody（level≥3）/ lead（FEVER）。
- `musicLevel` はコンポーネントが hit ごとに `combo ≥10→3 / ≥5→2 / ≥3→1 / それ以外 0` で設定。
- **音量**：BGM マスター `BGM_LEVEL = 0.5`（cue・判定SE は destination 直結）。ドン = 180Hz sine 0.3＋90Hz triangle 0.16、
  タン = 720Hz square 0.1。
- **ダッキング**：accent ごとに `bgmGain` を `at−80ms` から `at−30ms` で ×0.55（約 −5dB）へ、`at+120ms` から `at+200ms` で戻す。
  早押しで消えた的のドンは、まだ始まっていないダッキングごと取り消す。
- **cue の取り消し**：`scheduleRhythm` の先頭で、前パターンの未再生 cue（早押しで消えた的のドン等）を stop する。
- `stopMusic()`：game_over で 0.3秒フェードアウト。ミュート時は BGM 0・cue/SE 無音（時計は動く）。

## イベント（onEvent）
- `game_view` / `game_start` / `game_retry`（retry 時のみ、game_start の前）
- `rhythm_pattern`：`{ patternId, hitBeat, hitTime, cues: [{ beat, time, sound }] }`（時刻は transport 時刻）
- `hit`：`{ kind, pts, score, combo, comboMult, maxCombo, distancePx, nearMissPx, timingOffsetMs, expired }`
- `fever_start` / `fever_end`
- `game_over`：`{ score, maxCombo, hits, perfectCount, greatCount, goodCount, nearCount, missCount, expiredCount,
  averageAbsTimingOffsetMs, averageTimingOffsetMs }`（平均は押した判定のみ。寿命切れは除外）
- コンポーネントが GA4（`trackGameEvent`）へ橋渡し。`game_start / game_over / game_retry` には `difficulty` を付ける。

## 判定しきい値
- `R = targetR`（難易度別）。d ≤ 0.35R perfect / ≤0.7R great / ≤R good / ≤1.25R near / それ超 miss。
- NEAR は `timingOffsetMs = round((gameTime − hitAt) × 1000)` で「◯秒早い/遅い」を表示。

## データ（D1）
- `max_combo INTEGER NOT NULL DEFAULT 0`（migration 0003）。`score`=30秒合計、`perfect_count`、`rounds`=総ヒット数。
- ランキング並び：`ORDER BY score DESC, max_combo DESC, created_at ASC`（難易度別・期間別）。

## 失敗時の挙動
- 音が出せない環境：`clock='performance'` で無音進行（視覚の脈動・リングで遊べる）。
- ランキングAPI障害：スコアは残り、送信のみスキップ。
