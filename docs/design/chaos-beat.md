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
- **任意時刻の物理（`stateAtTime(t)` / `tipAtTime(t)`）**：物理状態 `s` は `gameTime − acc` の時点にある（`acc` = 未消化の固定ステップ時間）。
  t までを `n = floor((t − 起点)/FIXED_H)` 回の固定ステップ＋**最後に1回だけ `rk4(残り)`**（残り < 3.33ms）で積分する。
  ゲームの物理は 300Hz 固定のまま（`s` は変えない）、判定・予測だけ任意の時刻で求める。
  **的の配置（hitAt の中心）・CHAOS の先端速度・押した瞬間の判定位置はすべてこの関数**。起点のループも FIXED_H 刻みで進むので、
  hitAt と pressT が同じ時刻なら同じ計算列＝`pressT = hitAt` ちょうどなら先端は的の中心（以前の `round` による ±1.67ms の量子化は無い）。
- **スナップショット（`physHist`）**：押した瞬間（イベントの時刻）が最後のフレームより前のことがあるので、`playing` 中は毎フレーム
  （と的を出した瞬間に）`{ t: gameTime − acc, s }` を記録し、`t` 以前で最新のものを起点にする（0.6秒ぶん保持）。
  スロー（timeScale ≠ 1）に入ったら捨てる（物理時間と transport の対応が変わるため）。巻き戻せない場合は最古の状態の時刻で打ち切る（debug に表示）。
- **押した瞬間（`resolvePress(event.timeStamp)`）**：
  1. `options.eventTime(event.timeStamp)`（= `audio.eventTimeToTransport`）で transport 時刻に換算。
  2. 妥当性：timeStamp が有限／ハンドラまでの遅れが −5ms〜500ms（基準の違う timeStamp を捨てる）／換算結果が
     `now − 0.5秒 〜 now + 0.02秒`。どれかが外れたら従来どおり `pressT = clamp(now(), gameTime, gameTime + 0.25)`（source=handler）。
  3. 的が出る前（`pressT < target.bornAt`＝スロー中の入力ロック中）の操作は入力として扱わない。
  `timingOffsetMs = pressT − hitAt`（GA4 の hit / game_over の平均も同じ定義のまま精度だけ上がる）。判定しきい値・targetR は不変。
- **`eventTimeToTransport`（audio.ts）**：
  ① `getOutputTimestamp()` の `{contextTime, performanceTime}`（出力＝耳に届いている音の時刻と、その performance 時刻）で
  `contextTime + (event.timeStamp − performanceTime)/1000 − startTime`。値の妥当性（有限・0 より大・currentTime の 1 秒以内・
  performance 時刻が 1 秒以内）を満たさなければ ② へ。
  ② `currentTime − (performance.now() − event.timeStamp)/1000 − (baseLatency + outputLatency)`（出力遅延が取れなければ 0）。① と同じ「耳の時刻」に揃える。
  ③ transport が performance 時計（音の時計なし・停止）なら `event.timeStamp/1000 − startTime`。
  「耳の時刻」を使う理由：音（ドン）は出力遅延ぶん遅れて聞こえ、画面も表示遅延ぶん遅れて見える。currentTime（処理時刻）で押下を測ると
  音で押す人は出力遅延ぶん遅押し判定になる（ヘッドレスで +39ms）。出力側の時刻で測ると音にはぴったり、画面とは表示遅延と出力遅延が相殺する方向。
- **debug**（`?debug=1`）：INPUT（event / handler の時刻・queue lag・換算方法）、ctx・press、HIT（expected・offset・ハンドラ時刻だった場合の offset）、
  phys remainder。`onInputDebug` で `window.__cbLastInput` にも出す（検証スクリプト用）。本番表示には出ない。

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

## 外部音源の同期（song.ts / beat-grid.ts / audio.ts）
- **拍グリッドは曲ごと**：`makeGrid(bpm)`、`gridOf(song)`（WeakMap キャッシュ）。エンジン（cue・hitAt・リング・セクション切替の小節頭）と
  audio（BGM・外部音源・終止）が同じ `gridOf(song)` を使う。既定曲は `DEFAULT_GRID`（BPM 130）で従来と同一。
- **ロード**：`preloadSong(song)`（ページ表示時に fetch → ArrayBuffer をキャッシュし、`OfflineAudioContext(2, 1, 44100)` で先にデコード＝
  `predecoded`。ユーザー操作不要）→ `startTransport` 内の `loadBuffer` は先読みデコードの結果を使い、無ければ実 AudioContext でデコード
  （src ごとにキャッシュ。失敗したらキャッシュを消す）。デコードは **startTime を決める前**に待つ（最大 `max(DECODE_TIMEOUT_MS=4000, duration×25ms)`、
  初回だけ開始ボタンが「♪ 曲名 LOADING…」）。タイムアウト／失敗は `extActive = false` で合成BGMに切り替え（同じ grid。デコードは裏で続き次回使う）。
- **再生**：拍0のファイル位置 `beat0File = startAt + offset + anchorShift`。`pre = min(preroll, beat0File)` 秒前から
  `src.start(startTime − pre, beat0File − pre)`。以後 拍 n の音 ＝ ファイル位置 `beat0File + n·spb` が `startTime + n·spb` に鳴る
  （sample 精度。JS タイマーに依存しない）。source は毎ゲーム新規（AudioBufferSourceNode は1回しか start できない）。
  gain は頭で 8ms フェードイン、`audioTimeOf(duration) + tail − fadeOut` から `fadeOut` 秒で 0 へ、`stop(end + tail + 0.05)` を予約。
- **anchorShift**（デコーダ差の補正）：`audio.anchor = { level, time }`＝解析時（Chromium のデコード）に左チャンネルが level を初めて超えた時刻。
  実行時にデコード結果の左チャンネルを先頭から走査し、同じ条件の時刻との差を offset に足す（±60ms を超えたら目印が違うとみなして 0。WeakMap でキャッシュ）。
  ギャップレス情報（LAME/Xing）の無い MP3 で、ブラウザのデコーダが先頭の遅延を削る／削らないの差（最大 1105 サンプル≒25ms）を吸収する。
- **バス**：曲（外部音源 or 合成BGM）→ `bgmGain`（ダッキング・ミュート・前ゲームのフェード）→ `bgmOut` → destination ／
  cue（タン・ドン・予兆）→ `cueBus` ／ 判定SE・演出SE → `sfxBus`。外部音源の音量は `musicBase()` = `song.audio.volume`。
- **ダッキング**：`duckAt` が曲のベース音量 × `section.duck`（その accent の transport 時刻が属する区間。既定 `DUCK_EXTERNAL = 0.42`。合成BGMは ×0.55）。
- **cue の「コッ」**：`extActive` のとき `accentAt`/`tickAt` に `cueClick`（1318Hz sine＋2365Hz sine、30〜45ms）を重ねる（ドン 0.16 / タン 0.07。cueBus）。
- **コンボ層**：`scheduleBgmBeat` は `extActive` なら `scheduleExternalBeat(beat)` だけ：level≥2 小節頭に `chordAt` の5度×8・根音×8 のきらめき（0.012/0.008）、
  level≥3 小節頭に根音×2・5度×2 の triangle をのばす（0.007/0.005）、FEVER 突入の小さなクラッシュ（0.045）＋裏拍オープンハット（0.018）。
  `api.fever()` は外部音源中は音量 ×0.5。`scheduleFinish` は `audio.ownEnding` なら何も鳴らさない。
- **和音**：`chordAt(t)` = `section.harmony`（セクション頭から1小節ずつ順に・最後を保持）→ `song.harmony`（小節ごとに循環）→ 合成BGMの進行。
- **止め方**：再戦・終了は `stopExternal(c, fade)`（50ms フェード→stop）。`stopMusic()` は外部音源中は何もしない（予約済みの終わりのフェードを活かす）。
  `startTransport` の冒頭・例外時・時計停止（`fallbackToPerformance`）でも止める＝時計がずれた音源を鳴らし続けない。
- **iOS**：resume 打ち切り・currentTime の前進確認・プレイ中の時計監視は従来どおり。performance 時計になった回は無音（外部音源も止める）。
- **newTarget の順序**（chaos-pendulum.ts）：
  1. `firstBeat = nextBeatIndex(gameTime)`。区間に `restBeats > 0` があれば `earliest = max(firstBeat, ceil(直前の入力拍 + 1 + restBeats))`、
     無ければ `earliest = firstBeat`（60秒版は従来と同一＝密度・得点の基準は不変）。
  2. 過ぎた・未知・曲の終わりに収まらないエントリを飛ばす。次の通常パターン（`peekPattern`＝消費しない）を置くと
     `place(p) + p.hitBeat + 2 > entry.beat`（見逃したら次は入力拍＋2 からなので、エントリに間に合わない）か、区間が `autoFill: false` ならエントリの番：入力拍が予測範囲（`PRED_HORIZON` 2.6秒）の外なら的を出さずに待ち
     （`waitingForMap`。ループが毎フレーム `newTarget` を呼び直す）、入れば `spawn(pattern, entry.beat, …, entry.final)`。
  3. `autoFill: false`（エントリが無い）または `beatTime(earliest + 4)` がまだ予測範囲外（休符中）なら待つ。
  4. それ以外はセクションの sequencePool から次のパターン → `place()`（`earliest` 以降で、入力拍まで 0.5 秒以上）→ `spawn`。
- **CHAOS**：`speed ≥ section.chaosSpeed ?? 7.5` かつ `section.id !== 'intro'` かつ直前がチャンスでない。
- **FINAL**：`target.final`（beatmap の `final: true`）で GOOD 以上なら判定ラベルを `FINAL PERFECT` / `FINAL HIT!`（虹色・大）、虹の大爆発＋シェイク。得点式は同じ。
- **hype**：`section.hype` 1/2 のとき（FEVER・FINAL カウント中以外）、拍頭で枠がピンク／黄色に明滅（2 は背景もかすかに）。reduced-motion で弱める。
- **時間表示**：`duration ≥ 100` なら `m:ss`。`finalCountdown: false` の曲は FINAL の 5→1 と FINAL 枠を出さない。
- **debug**：`initGame({ debugInfo })` → `drawDebug()`（左上テキスト＋右上メトロノーム）。`audio.debugLines()` がモード・src・startAt/offset・ファイル内位置を返す。
- **検証方法**（ヘッドレス Chromium・実 AudioContext）：BPM120 のクリック音源（ファイル 2.35s から 0.5s 間隔、0s/1s にデコイ）を
  `?song=external_test&debug=1&bpm=120&startAt=2.0&offset=0.35` で流し、外部音源の出力を AudioWorklet で直接タップしてクリックの
  audio 時刻を測る → transport 時刻に直して拍グリッド・`rhythm_pattern.hitTime` と比較。

## Burning Heart FULL の解析と譜面（song.ts `BURNING_HEART_SONG`）
- **解析の手順**（再調整するときも同じ手順で）：
  1. Chromium の `decodeAudioData`（ゲームと同じデコーダ）で PCM にする（44.1kHz・13,791,744 サンプル＝312.738 秒。先頭 0.87 秒は無音）。
  2. テンポ：オンセット強度（スペクトルフラックス）の自己相関 → 約 70.95×2 = 141.9。次に 150Hz 以下のエネルギーの立ち上がり（hop 1.45ms）に
     「BPM × 位相」の格子を当てはめて全曲で最大化 → **142.000 BPM**、格子の位相 0.0325 秒。40 秒ごとの中央残差 0〜3ms（テンポ一定）。
  3. 拍0：最初の音（ギター）の立ち上がり 0.8728 秒 ＝ 格子の拍2（0.8776）。全帯域の立ち上がりはキックのエネルギーより約 5ms 早いので、
     拍0 = **0.8735 秒**（耳に聞こえる頭）。ここから4拍ごとの小節で、全セクション境界・ブレイク・最後の和音が小節（拍）の上に乗る。
  4. 構成：小節ごとの帯域エネルギー（低域＝キックとベース／中域／高域）、中央定位の強さ（mid/side 比。Aメロで高い＝歌・リード）、
     クロマ（12 音）の自己相似（8 小節ブロック）。サビ = 小節 8–23 ≡ 52–67 ≡ 146–161（類似度 0.96〜0.99）、Aメロ 32–47 ≡ 76–91、リフ 24–31 ≡ 68–75。
     ソロ 117–136 はどことも似ていない（B のペダル → E♭ → 小節128で D へ転調）。
  5. 決めどころ：各小節の 16 分グリッドでキック（30–120Hz）・スネア帯（1.5–5kHz）・シンバル帯（7k–16kHz）のオンセットを並べて確認
     （小節75・137 の頭の一撃のあと低域が消える＝ストップ、小節169 の2拍でドラム終了、最後の和音はファイル 300.14 秒＝拍 708.25）。
- **譜面の密度**（的と的の間隔の平均。自動プレイの実測）：INTRO 7拍／サビ 3.0〜3.1／リフ 4〜4.8／Aメロ 7〜8（restBeats 3〜4）／Bメロ 4.5〜6／
  ブリッジ 7／ソロ 3.0〜3.3／ブレイク 1打のみ／ラスサビ 2.8〜2.9（最密）／アウトロ 2打のみ。1曲で的は約165〜173。
- **固定譜面の置き方**：`chorusEntry(d)` = `[d−3 A|E → d, d+1 H → d+2, d+3 H → d+4, d+5 A → d+8]`（全サビ共通）、
  `soloPhrase(d)` = `[d−3 A → d, d+1 J → d+2.5, d+4 J → d+5.5, d+6 C → d+8.5]`（ソロ頭とラスサビ後半。裏拍が3つ続く）。
  サビ・ソロの間は sequencePool（`BH_*_SEQUENCES`）。H/J/Z は FULL 専用パターンで 60秒版のプールには入れていない。

## 判定音が育つ（audio.ts `judgment(kind, combo)`）
- コンポーネントが hit ごとに `judgment(p.kind, p.combo)`（combo は判定後の値）を呼ぶ。
- 段階 `step`：combo 1-2=0 / 3-4=1 / 5-6=2 / 7-9=3 / 10+=4 → 音 `[根音, 3度, 5度, 根音×2, 根音×2][step] × 2`。
  和音は `chordNow()`：`api.now()` の transport 時刻から、伴奏パッドのあるセクションなら小節ごとの `CHORDS`（Dm–B♭–C–A）、それ以外は Dm。
  PERFECT＝triangle＋1オクターブ上の sine、step 4 は構成音×4 のきらめき。GREAT/GOOD は同じ音程で控えめ。押した瞬間に鳴らす（拍に寄せない）。
- 直前の combo（`lastCombo`）が 3 以上で NEAR/MISS/見逃しになったら `comboBreak()`：短いノイズのクリック＋520→90Hz の下降ブリップ＋
  BGM 出口ノード `bgmOut` を 15ms で 0.15 まで下げ、0.45 秒で戻す。`bgmOut` は `bgmGain`（cue のダッキング）とは別ノードなので予約が干渉しない。
  combo 3 未満の NEAR/MISS は従来の短い濁り音。

## ⚡ CHAOS PERFECT（chaos-pendulum.ts / audio.ts）
- `newTarget()`：`tipAtTime(hitAt)` で的の中心と hitAt の先端速度（次の1固定ステップとの差 ÷ FIXED_H）を同時に求める。
  `chaos = speed ≥ CHAOS_SPEED(7.5) && section ≠ intro && !lastWasChaos`。`target.chaos` と `rhythm_pattern { chaos, chaosTell: 0.35 }` に載せる。
  速度の分布（2000件/難易度）：7.5 以上は easy〜hard 約15%、鬼 約20%。
- 予兆 `chaosTell()`：state==='playing' かつ hitAt−0.35〜hitAt+0.12 で 0→1。的の周りにジグザグの電撃の輪（半径ランダム揺れ）＋火花、
  的の破線円の半径だけ ±1.6px 震える、軌跡の太さ +3〜3.5px・先端側を白に。的の中心・十字・判定は不変。reduced-motion は揺れ・火花なし。
- 判定：`chaosPerfect = kind==='perfect' && target.chaos`。得点計算は変えない。ラベル「⚡ CHAOS PERFECT」（白⇔シアン明滅・画面幅に合わせ縮小）、
  白い閃光 `chaosFlashT`、電撃色の粒子2段、シェイク 1.6 倍、`scorePop.sub = '⚡ CHAOS'`（FEVER 中は '⚡ CHAOS × FEVER ×2'）。
- 音：`scheduleRhythm(cues, { hitTime, tell })` が hitTime の直前に予兆音（1800→3600Hz の弱い上昇サイン＋3136Hz の「チッ」を
  −0.35/−0.24/−0.16/−0.10/−0.06/−0.03 秒に加速）を予約。`stopChaosTell()` を hit ごとに呼んで鳴り途中でも止める。
  `chaosPerfect()`＝ノイズのクラック＋2400→180Hz のザップ＋62→34Hz の衝撃＋今の和音の構成音×4 のきらめき。

## 結果発表（ChaosPendulum.astro / result-rank.ts / audio.ts）
- `result-rank.ts`：`RANK_THRESHOLDS[difficulty]`（S/A/B/C の最低点）、`rankOf(score, difficulty)`、`nextRank(score, difficulty)`（あと何点で次か）。
  しきい値は正規分布の押しズレ σ=15/30/50ms の自動プレイ（2ゲームずつ）の得点から：S ≒ 上手い人（σ15）の典型値を少し超える、B ≒ 平均（σ30）。
- game_over で `getBest()`（更新前）→ `updateBest()` → `rankOf()` を計算し、`game_over` を `result_rank` / `new_best` 付きで送る（他のイベントは従来どおり先に送る）。
- `prepareResultShow()` が数値を入れて各項目を非表示（`.cp-reveal` から `.shown` を外す。場所は確保＝レイアウトが跳ねない）、
  パネル表示時に `playResultShow()`：無音 250ms → rAF でスコア加算 900ms（ease-out・65ms ごとに `resultTick(p)`）→ 各項目 220ms 間隔で `.shown`＋`resultPop(i)`
  → 250ms 後にランク `.shown`（ハンコのアニメ）＋`rankStamp(rank)` → NEW BEST なら 550ms 後に表示＋`best()` → `finishResultShow()`。
  タイマーは `game_start` で `cancelResultShow()`（演出中の再戦で残らない）。結果の数字部分クリックで `finishResultShow(true)`（音は二重に鳴らさない）。
- 音：`resultTick`（1200→2100Hz の短い矩形波）、`resultPop`（E5→D6 の三角波）、`rankStamp`（低い衝撃＋ノイズ＋和音。S はきらめき、C は短調で控えめ）。

## 報酬ループの表示（chaos-pendulum.ts の描画／ChaosPendulum.astro の結果／result-rank.ts／storage.ts）
- 上部 HUD（FEVER 外）：`N COMBO` の下の1行を優先順で1つ：節目直後（milestoneT）「♪ X IN · ×倍率」→ `perfectStreak === 2` なら
  「NEXT PERFECT → 🔥 CHAOS FEVER」（beatPulse で脈動）→ 次の節目まで ≤2 なら「NEXT n → ♪ X IN」。節目は COMBO 表示自体を 1.35 倍・黄色に。
  （以前の中央上のポップは判定ラベルと重なるので廃止）
- 判定ラベルの下の `resultSub`（得点ポップ `scorePop` が出ているときは描かない）。
- FEVER 終了：`endFever(reason)` で `feverSummary = { reason, streak, chaos }`（chaos は FEVER 中の CHAOS PERFECT 数 `feverChaos`）→ 0.7 秒描画。
  暗転は miss のときだけ。音は miss＝`feverEnd()`、timeout＝`resultPop(3)`。
- 最初の CHAOS チャンス：`chaosHintShown`（ページを開いている間で1回、newGame で戻さない）→ 1.6 秒の2行説明（`fitText` で画面幅に収める）。
- `storage.updateBest({ score, maxCombo, rank })` → `{ isNewBest, best(topCombo, gotS), prevBestScore, isNewTopCombo, prevTopCombo, isFirstS }`（旧データは topCombo=bestMaxCombo, gotS=false）。
- `result-rank.nextGoal()`：S 未満→次のランクまで／S で未更新→BEST まで／S で更新→MAX COMBO 記録を超えろ。`need ≤ SO_CLOSE_POINTS(300)` で close。
- 結果の段取りは従来どおり（無音→加算→各項目→ランク→NEW BEST）＋ ランクと同時に FIRST S、NEW BEST と同時に NEW MAX COMBO（小）、最後に NEXT GOAL。合計 ≤ 約3.4 秒。

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
