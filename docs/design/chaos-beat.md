# design: CHAOS BEAT

spec: [../specs/chaos-beat.md](../specs/chaos-beat.md) を満たす作り方（現行実装に一致させている）。
廃止済みの案は spec 末尾「廃止済み仕様」を参照。この文書には現行の設計だけを書く。

## モジュール境界
- `src/scripts/games/song.ts`：**曲データ**（エンジンと audio が共有）。`RHYTHM_PATTERNS`（A〜G）、シーケンス群
  （EASY/STANDARD/BUILD/CLIMAX/FINAL）、`GameSection`／`SongDefinition`、`GAME_DURATION=60`、`SONG_60`（=DEFAULT_SONG）、
  `sectionStart(song, i)`（小節頭に丸めた境界）、`sectionIndexAt(song, t)`。DOM・AudioContext に依存しない。
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
- 尺は `song.duration`（既定 60 秒。transport 時刻で計る。カウントインは含まない）。エンジンは `options.song` を受け取り、
  `GAME_TIME` の直書きはしない。
- セクション：毎フレーム `sectionIndexAt(song, gameTime)` を見て、変わったら `section_change` を emit（INTRO は拍0で1回）。
- ターゲットは `Target | null`。曲末で最後の入力拍が `duration − 1拍` に収まらないときは、入力拍が一番遅い「収まるパターン」に差し替え、
  それも無ければ `null`（入力ロック、終止を待つ）。
- ターゲット：常に1つ `{ x, y, r, bornAt, hitBeat, hitAt, expireAt = hitAt + 1.2拍 }`。
  `gameTime > expireAt` で寿命切れ MISS（combo=0・0点・`expired:true`）→ 即 `newTarget()`（slowmo なし）。
- **入力ロック**：`act()` の先頭で `if (state !== 'playing') return;`。
- 叩く：距離 d → kind → GOOD以上なら combo+1 → 倍率再計算 → `score += round(pts × mult × (fever?2:1))`。
  `hit` を emit → `slowmo`（0.2秒）→ `newTarget()` → `playing`。
- `gameTime ≥ duration` で `over`、FINISH! を描画し、集計つき `game_over` を emit。

### 固定タイムステップ（予測一致のための不変条件）
- 物理は **FIXED_H = 1/300 秒** 固定（`acc += dt × timeScale`、`while (acc ≥ FIXED_H) rk4(s, FIXED_H)`）。
  的の位置・判定位置の計算も同じ FIXED_H・同じ rk4 で積分するので、予測と実機が**完全一致**する（補間・別積分は混ぜない）。
- `dt = now() − 前フレーム` を **0.25秒まで**追従（1フレーム最大90ステップ）。小さくクランプすると物理が transport から恒久的に遅れて的を通らなくなる。
  それを超える停止（タブ非表示など）は、的が寿命切れ→次の的で予測し直すので自然に再同期する。
- **時刻 → ステップ数の対応**：物理状態 `s` は `gameTime − acc` の時点にある（`acc` = 未消化の固定ステップ時間）。
  transport 時刻 t の先端は `stepsUntil(t) = round((t − gameTime + acc) / FIXED_H)` ステップ先。的が生きている間は timeScale=1 なので、
  この対応は的の生成から判定まで一定（slowmo 明けに作る的も、次フレーム以降は等速で進むので同じ式でよい）。
- **的の中心（`newTarget()`）**：`tipAfterSteps(stepsUntil(hitAt))` ＝ `s` のコピーを hitAt まで固定ステップで**直接積分**した先端。
  以前は 4 ステップ（≈13ms）ごとにサンプルした `predictPath()` から最寄り点を拾っており、±2 ステップの量子化誤差（p95 ≈3.7px）があった。
  予測の上限は `PRED_HORIZON = 2.6` 秒（範囲チェックのみ）。計算量は最大 ~690 ステップ＝以前の 780 ステップより軽い。
- **判定位置（`hit()`）**：押した瞬間の transport 時刻 `pressT = now()`（`gameTime`〜`gameTime + 0.25` に丸める）で
  `tipAfterSteps(stepsUntil(pressT))` を使う。`s` 自体は変えない（実機の物理列はそのまま）。
  以前は「最後に描いたフレームの `s`」で判定しており、押した瞬間より最大 1 フレーム＋acc（60fps で ~20ms）遅れた位置＝
  常に「まだ届いていない」側にズレていた（px では全難易度同じ ~11px p95 だが、的が小さい難しい・鬼ほど PERFECT を外す）。
  `timingOffsetMs` も `pressT − hitAt` で計る。判定しきい値（0.35R/0.7R/R/1.25R）・targetR は不変。

### timeScale（リズム整合）
- 的が生きている `playing` 中は **timeScale = 1**。`slowmo`（0.15）は叩いた直後の的が無い間だけ。
- 難易度・FEVER で物理速度は変えない。

### 譜面とセクション
- `RhythmPattern { id, lengthBeats, cues[{beat, sound}], hitBeat }`（A〜G。song.ts）。
- `RhythmSequence { id, patterns }`。`nextPattern(section)` がシーケンスを順番に消化 → 尽きたら、または
  **セクションが変わって今のシーケンスがプール外になったら** `pickSequence(section)`（直前と同じ id を避ける）。
- パターンを選ぶセクションは「パターン先頭の拍（次の拍頭）」の時刻で決める。的の半径は `targetR × section.targetScale`。
- `GameSection { id, label, start, end, sequencePool, musicIntensity, targetScale, arrangement }`。
  `start/end` は設計値の秒で、実境界は `round(start / 1小節) × 1小節`（BGM・イベント・譜面が同じ小節頭で切り替わる）。
  プール内の重複（例：BUILD に BUILD_SEQUENCES を2回）は選ばれやすさの重み。
- FINAL の 5→1 カウント：`countStep = (duration − finalStart) / 5`（60秒版は 2拍）、`n = ceil((duration − gameTime) / countStep)`。
- 予測範囲外（>2.6秒）・反応猶予不足（<0.5秒）のときは **パターンごと拍単位でずらす**（hitAt だけをずらさない＝ドンと hitAt が離れない）。

## 音（audio.ts）
- **transport**：上記。`startTransport` は前ゲームの BGM バス（`bgmGain`）を 50ms でフェードして切り離し、新しいバスで拍0から始める。
  未再生の cue も取り消す（前ゲームの残響が新しい拍に混ざらない）。
- **BGM スケジューラ**：`setInterval(25ms)` で `nextBeatTime < currentTime + 0.12` の拍を先読み予約。
  `startTransport(leadBeats, song)` で曲を受け取り、拍 n ごとに **2層**で組み立てる：
  1. **セクションの基本アレンジ**：`sectionIndexAt(song, beatTime(n))` の `arrangement` から。エンジンのイベントを待たず
     同じ曲データ・同じ beat grid で決めるので、`section_change` と BGM の切替は同じ小節頭になる。
     - drums：`sparse`（kick 0,2＋4拍目リム）/ `basic`（kick 0,2＋snare 1,3）/ `drive`（＋裏8分シェイカー）/ `four`（4つ打ち＋snare＋シェイカー）
     - `crash`：セクション頭にクラッシュ ／ `fill`：次セクション直前の1小節に16分スネアのクレッシェンド
     - `pad`：小節頭に和音（Dm–B♭–C–A）／ FINAL の締めモチーフ（D–F♯–A–D、小音量）
  2. **コンボ層**（その拍を予約する瞬間の musicLevel/feverOn）：bass（level≥1。pad のあるセクションは和音ルート）/
     hihat 8分（level≥2）/ melody（level≥3。`arrangement.motif` = main / variation（2小節の問いと答え）/ finale、
     音量 `arrangement.melodyGain`）/ lead（FEVER）。
- **終止**：`beatTime(n) ≥ song.duration` の拍（60秒版は拍130）でループをやめ、`scheduleFinish()`（キック＋クラッシュ＋Dメジャー和音）を
  BGM バスを通さず予約してスケジューラを止める（game_over の `stopMusic()` フェードで終止音が切れない）。
- `musicLevel` はコンポーネントが hit ごとに `combo ≥10→3 / ≥5→2 / ≥3→1 / それ以外 0` で設定。
- **音量**：BGM マスター `BGM_LEVEL = 0.5`（cue・判定SE は destination 直結）。ドン = 180Hz sine 0.3＋90Hz triangle 0.16、
  タン = 720Hz square 0.1。
- **ダッキング**：accent ごとに `bgmGain` を `at−80ms` から `at−30ms` で ×0.55（約 −5dB）へ、`at+120ms` から `at+200ms` で戻す。
  早押しで消えた的のドンは、まだ始まっていないダッキングごと取り消す。
- **cue の取り消し**：`scheduleRhythm` の先頭で、前パターンの未再生 cue（早押しで消えた的のドン等）を stop する。
- `stopMusic()`：game_over で 0.3秒フェードアウト。ミュート時は BGM 0・cue/SE 無音（時計は動く）。

## 判定音が育つ（audio.ts `judgment(kind, combo)`）
- コンポーネントが hit ごとに `judgment(p.kind, p.combo)`（combo は判定後の値）を呼ぶ。
- 段階 `step`：combo 1-2=0 / 3-4=1 / 5-6=2 / 7-9=3 / 10+=4 → 音 `[根音, 3度, 5度, 根音×2, 根音×2][step] × 2`。
  和音は `chordNow()`：`api.now()` の transport 時刻から、伴奏パッドのあるセクションなら小節ごとの `CHORDS`（Dm–B♭–C–A）、それ以外は Dm。
  PERFECT＝triangle＋1オクターブ上の sine、step 4 は構成音×4 のきらめき。GREAT/GOOD は同じ音程で控えめ。押した瞬間に鳴らす（拍に寄せない）。
- 直前の combo（`lastCombo`）が 3 以上で NEAR/MISS/見逃しになったら `comboBreak()`：短いノイズのクリック＋520→90Hz の下降ブリップ＋
  BGM 出口ノード `bgmOut` を 15ms で 0.15 まで下げ、0.45 秒で戻す。`bgmOut` は `bgmGain`（cue のダッキング）とは別ノードなので予約が干渉しない。
  combo 3 未満の NEAR/MISS は従来の短い濁り音。

## CHAOS FEVER の演出（chaos-pendulum.ts の描画・audio.ts の音。物理・判定には触れない）
- 定数は `FX`（`ENTRY_TIME 0.7` / `ENTRY_FLASH_ALPHA 0.6` / `ENTRY_ZOOM 0.05` / `BEAT_FLASH_ALPHA 0.12` / `OVERLAY_ALPHA_MAX 0.2` /
  `TRAIL_LEN 140` / `FEVER_TRAIL_MULT 1.8` / `TRAIL_CHUNKS 28` / `FEVER_PARTICLE_MULT 2` / `MAX_PARTICLES 320` / `SHAKE_PX 6` /
  `SHAKE_TIME 0.1` / `DROP_TIME 0.45`）と `RAINBOW`。低スペック対策として粒子は総数上限、軌跡は最大 28 回の stroke にまとめる。
- 状態（表示・集計のみ）：`feverEntryT` / `feverDropT` / `feverStreak`（FEVER ×N）/ `shakeT` / `scorePop` / `pendingBursts`（二段目の爆発）/
  `feverFinish` と集計 `feverCount / feverTime / feverHits / feverPerfects`。
- **カメラ**：`draw()` の先頭で `ctx.save()` → 突入ズーム（中心基準の scale）と PERFECT シェイク（translate）→ 末尾で `restore()`。
  物理・target 座標・判定は一切変えない（同じ固定ステップ・同じ hitAt）。
- **描画順**（奥→手前）：背景の拍フラッシュ・虹の縁 → 可動範囲 → FINAL カウント・枠 → 突入の巨大文字 → 判定ラベル・「+xxx / FEVER ×2」 →
  **アプローチリング・的** → 軌跡 → 振り子 → 判定フラッシュ → 粒子 → 解除の暗転 → 上部の FEVER/COMBO 表示 → セクション名 → FINISH → 突入フラッシュ。
  文字は的より奥なので、次の的に重なっても的とリングは隠れない。突入フラッシュだけ最前面だが最初の約0.2秒（打鍵直後のスロー中）で消える。
- **虹色**：`rainbowAt(t) = RAINBOW[floor(t/BEAT)]` → 次の色へ拍内で補間（beat grid 同期）。リングは2色ずらす。
- **背景の拍フラッシュ**：`0.05 + BEAT_FLASH_ALPHA × beatPulse()`、拍ごとに pink/yellow。FINAL 中は上限を 0.07 下げる。
- **判定ラベル位置**：FEVER 中は上部の見出し・ゲージと重ならないよう少し下げる（`labelY()`）。
- **reduced motion**：`matchMedia('(prefers-reduced-motion: reduce)')` を監視。シェイク・ズーム無効、`particleMult 0.4`、`flashMult 0.4`。
- **音**：`fever()`＝インパクト（70Hz sine）＋ノイズ＋ライザー（saw 330→1320 / tri 660→1760）＋スパークル（C7–C8 の駆け上がり）、約0.5秒。
  `setFever(true)` で `feverCrashPending` → 次に予約する拍頭にクラッシュ＋キック。FEVER 層は BGM バス経由（ダッキング有効）。
  `feverEnd()`＝900→220Hz の短い下降（`reason !== 'finish'` のときだけ）。`scheduleFinish()` は `feverOn` なら上の和音・駆け上がり・長いクラッシュ・サブを足す。
- **終止時**：`endGame()` で FEVER 中なら `feverFinish=true`・粒子・`endFever('finish')`（解除演出なし）→ `game_over`。

## イベント（onEvent）
- `game_view` / `game_start` / `game_retry`（retry 時のみ、game_start の前）
- `rhythm_pattern`：`{ patternId, hitBeat, hitTime, cues: [{ beat, time, sound }] }`（時刻は transport 時刻）
- `section_change`：`{ section, elapsed, musicIntensity }`（elapsed は小節頭に丸めた境界の transport 秒）
- `hit`：`{ kind, pts, score, combo, comboMult, maxCombo, distancePx, nearMissPx, timingOffsetMs, expired }`
- `fever_start` / `fever_end { reason: 'miss' | 'timeout' | 'finish', duration, hits }`
- `game_over`：`{ score, maxCombo, hits, perfectCount, greatCount, goodCount, nearCount, missCount, expiredCount,
  averageAbsTimingOffsetMs, averageTimingOffsetMs, feverCount, feverDuration, feverHits, feverPerfects }`
  （平均は押した判定のみ。寿命切れは除外）
- コンポーネントが GA4（`trackGameEvent`）へ橋渡し。`game_start / game_over / game_retry` には `difficulty` を付ける。
  `section_change` で FINAL のとき `.is-final`（残り秒数・時間バーをピンク強調）。`game_over` から `RESULT_DELAY_MS=1300` 後に
  結果パネル（その間に次のゲームが始まったら出さない）。

## 判定しきい値
- `R = targetR`（難易度別）。d ≤ 0.35R perfect / ≤0.7R great / ≤R good / ≤1.25R near / それ超 miss。
- NEAR は `timingOffsetMs = round((gameTime − hitAt) × 1000)` で「◯秒早い/遅い」を表示。

## データ（D1）
- `max_combo INTEGER NOT NULL DEFAULT 0`（migration 0003）。`score`=1曲（60秒）合計、`perfect_count`、`rounds`=総ヒット数。
- ランキング並び：`ORDER BY score DESC, max_combo DESC, created_at ASC`（難易度別・期間別）。
- `scores.ts` の `MAX_SCORE = 40000`（60秒版。1ヒット最大400点×最悪ケース約85個≒34,000 に余裕）。`MAX_HITS = 200` は据え置き。
- 60秒版への切替で既存行（30秒版）は比較不能。初期化はオーナーが手動（plan の手順）。migration では消さない。

## 失敗時の挙動
- 音が出せない環境：`clock='performance'` で無音進行（視覚の脈動・リングで遊べる）。
- ランキングAPI障害：スコアは残り、送信のみスキップ。
