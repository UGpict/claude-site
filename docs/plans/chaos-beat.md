# plan: CHAOS BEAT

spec: [../specs/chaos-beat.md](../specs/chaos-beat.md) / design: [../design/chaos-beat.md](../design/chaos-beat.md)

plan から外れる判断が出たら、コードより先に spec/design を直す。
**現行仕様は spec/design が正**。下の「履歴」は経緯の記録で、Superseded/Deprecated の項目を現行仕様と読まないこと。

## Completed
- [x] **Phase 1 core loop**：30秒固定（当時。現在は60秒1曲に Superseded）・1的ずつ・寿命切れ MISS・距離判定（PERFECT/GREAT/GOOD/NEAR/MISS）・
      NEAR/MISS 0点・0.2秒スロー＋入力ロック・コンボ倍率・BPM脈動・即リトライ
- [x] **rhythm input**：`RHYTHM_PATTERNS` A〜D・入力拍に量子化した未来軌道点へ配置・cue 先読み予約・
      アプローチリング・`timingOffsetMs`・リズム整合（timeScale=1）
- [x] **sequence**：`RHYTHM_SEQUENCES`／`EASY_SEQUENCES`、順番消化・直前回避・序盤は易しい方のみ
- [x] **persistent music**：drum / +bass(3) / +hihat(5) / +melody(10) / +lead(FEVER)、MISS で次拍から drum のみ、game_over でフェード
- [x] **ranking**：難易度別・今日/今週/歴代、score＋maxCombo、自己ベスト、GA4
- [x] **transport sync / TAP TO START / instrumentation**、**60秒で1曲**（詳細は下の履歴）

## ルール：ランキング（D1）は初期化しない
他の人が遊び始めているため、ランキングの行を消す・作り直す操作（DELETE・テーブル再作成・リセット用 migration）はしない。
スコアの尺度が変わる変更（得点ボーナス等）は、既存ランキングと比べられなくならないよう設計段階で避けるか、オーナーに相談する。

## Current：報酬の3階層（1打 → 数秒 → 60秒）
順番：① 音が育つ → ④ CHAOS PERFECT → ② 結果発表。段階ごとに GA4 の `game_retry ÷ game_over`（結果画面からの再戦率）を比べる。
per-game イベント（game_start / game_over / game_retry）に `reward_stage`（0=導入前 / 1 / 2 / 3）を付けて期間とキャッシュを切り分ける。
- [x] **① 音が育つ（reward_stage 1）**：GOOD 以上の判定音がコンボで 根音(1-2) → 3度(3-4) → 5度(5-6) → オクターブ(7-9) → ＋きらめき(10+)。
      音は「今の小節の和音」の構成音（伴奏パッドのある CLIMAX/FINAL は Dm–B♭–C–A に追従、それ以外は Dm）なので伴奏と濁らない。
      PERFECT は倍音つき、GREAT/GOOD は同じ音程で控えめ。コンボ3以上が NEAR/MISS/見逃しで切れると「プツッ」＋BGM が一瞬（~0.45秒）抜ける
- [x] **④ CHAOS PERFECT（reward_stage 2）**：hitAt での先端速度 ≥ 7.5 u/s の的＝CHAOS チャンス（INTRO なし・2連続なし）。
      hitAt の 0.35 秒前から予兆（電撃の輪＋火花・的の円が震える・軌跡が太く白く・加速する高い「チッ」＋上昇音）→ PERFECT で ⚡ CHAOS PERFECT
      （白い閃光・電撃の粒子2段・シェイク・専用SE・バイブ）。得点は通常の PERFECT と同じ（ランキングの尺度を変えない）。
      検証：1曲あたり normal 平均約3回（2〜5）・鬼約5回。拍どおりに押すボットで全チャンスが CHAOS PERFECT、同期・PERFECT 率・フレーム時間は不変。
      計測：hit に chaos / chaosPerfect、game_over に chaosChances / chaosPerfectCount
- [x] **② 結果発表（reward_stage 3）**：一瞬の無音（0.25秒）→ スコア高速加算（0.9秒・刻み音）→ PERFECT → ⚡ CHAOS PERFECT（取った数 / チャンス数）
      → MAX COMBO → 🔥 FEVER 秒 → ランクのハンコ（S/A/B/C）→ NEW BEST（前 → 後）→「あと◯点で（次のランク）」。約3秒。
      「もう一回！」は最初から押せる（演出で再戦を待たせない）。数字部分のタップで飛ばせる。reduced-motion は一度に表示。
      ランクのしきい値は難易度別（人間らしい押しズレ σ15/30/50ms の自動プレイの得点から）：
      easy S10000/A8000/B5000・normal S9000/A6500/B4000・hard S6000/A4200/B2500・鬼 S4000/A2500/B1500。
      計測：game_over に result_rank / new_best（reward_stage 3）
- [x] **報酬ループの磨き込み（2026-09-28・罰は足さない／HP なし・得点式とランクしきい値は不変）**
  - 1打：PERFECT 2連で上部に「NEXT PERFECT → 🔥 CHAOS FEVER」（拍で脈打つ）＋ラベル下「PERFECT ×2」。GREAT「COMBO KEEP」/ GOOD「STILL ALIVE」/
    チャンスの的を GREAT 以下で「⚡ CHAOS おしい！」（ラベル下に1行だけ・得点ポップと重ねない）
  - 数秒：コンボ節目は上部の COMBO 表示が大きく黄色に＋「♪ BASS / HAT / MELODY IN · ×倍率」。節目の2手前から小さく「NEXT 10 → ♪ MELODY IN」。
    CHAOS PERFECT の得点ポップに「⚡ CHAOS 3 / 7」（ここまでの取った数/チャンス数）。最初のチャンスで1度だけ「⚡ CHAOS チャンス！ 的が電撃で光ったら PERFECT を狙え」。
    FEVER 中の表示を「×2 SCORE · STREAK n」に（倍率ではないと分かるように）。FEVER の終わりに 0.7 秒「FEVER END / FEVER CLEAR!（時間切れ）＋ STREAK n · ⚡ CHAOS PERFECT ×k」
  - 1ゲーム：NEXT GOAL を1つだけ（次のランク → BEST まで → MAX COMBO 記録）。300点以内は「SO CLOSE!」で黄色く脈打つ。
    NEW BEST に改善幅「+1,043」、最大コンボ記録の更新「NEW MAX COMBO! 12 → 18」（小さく）、S は金のハンコ＋光の帯、初 S は「FIRST S RANK!」。
    再戦ボタン：あと少し→「あと少し！もう一回」/ 自己ベスト更新→「さらに更新する！」。発表は約 2.9〜3.4 秒で、ボタンは最初から押せる
  - 自己ベストの保存に topCombo（最大コンボ記録）と gotS（S を取ったか）を追加（旧データ互換）
  - 計測：game_over に score_delta / next_rank_need / max_combo_new_best / first_s_rank
- [ ] 次：段階ごとの `game_retry ÷ game_over`（reward_stage 別）と、難易度別の result_rank 分布を見てしきい値を調整

## 完了：CHAOS FEVER 強化（2026-09-27）
ルール（PERFECT3連・5秒・×2・MISS/NEAR解除）は据え置き。演出と音だけ。
- [x] `FX` 定数・FEVER 演出状態の整理（表示・集計のみ。物理/判定/hitAt/beat grid/timeScale 不変）
- [x] 突入：フラッシュ・ズーム・巨大 CHAOS FEVER ×2 SCORE・虹の粒子・3層突入SE・次の拍頭のクラッシュ・バイブ
- [x] 虹の的・虹のアプローチリング（拍同期の色相循環）
- [x] 軌跡強化（1.8倍・太く・濃く・グラデ、描画は 28 区間にまとめる）
- [x] FEVER PERFECT：粒子増量・二段階爆発・虹の大きな PERFECT・「+xxx / FEVER ×2」・描画のみのシェイク
- [x] 背景の拍フラッシュ（pink/yellow 交互）＋虹の縁、FINAL と重なるときは上限を下げる
- [x] FEVER 層強化：lead＋5度の合いの手＋オープンハット＋パッド＋オクターブメロディ（BGM バス経由・ダッキング維持）
- [x] 解除の落差：一瞬の暗転＋FEVER END＋控えめな「シュン…」、次の拍から FEVER 層が消える
- [x] FEVER のまま終止：FINISH!! ＋ CHAOS FEVER FINISH ＋ 派手な終止音（解除扱いにしない）
- [x] prefers-reduced-motion（シェイク・ズームなし、粒子・フラッシュ 40%）
- [x] 計測：`fever_end { reason, duration, hits }`、`game_over` に feverCount/feverDuration/feverHits/feverPerfects
- [x] 検証（ヘッドレス Chromium）：拍どおり押す自動プレイで PERFECT 31〜32/34（演出で判定・同期が崩れない）、
      FEVER 中も 60fps（p95 17ms）、突入・FEVER PERFECT・解除・FEVER 終止の画面を確認。reduced-motion でも同等
- [ ] 実機（スマホ・イヤホン）で突入SEとFEVER層の音量、シェイク量、粒子数の最終調整

### ページUI（スマホで開いてすぐ遊べる）2026-09-27
- [x] ゲームを見出し＋一行説明の直下へ（iPhone 13 相当で TAP TO START が初期表示内。以前は約3画面下）
- [x] 遊び方・ルール・曲の流れを `<details>` アコーディオン3つに（初期は閉じる。本文は DOM に残す）。開いたら `howto_open` を計測
- [x] スタート画面に3ステップ（🎧 ドンを聞く / ⭕ 輪が重なったらタップ / 🔥 PERFECT 3連で FEVER）
- [x] スマホ：盤面内の重複タイトルを隠し HUD・難易度を1行に詰める。開始時は sticky ヘッダーの下に盤面全体が収まるようスクロール
- [x] プレイ中はスマホ下部の浮きシェアバーを隠す（盤面下端での誤タップ防止）

### 不具合修正：スマホで「もう一回！」から再戦できない（2026-09-27）
- 原因：ゲーム時計（audio.now）が AudioContext.currentTime だけに依存。iOS で state が 'running' のまま currentTime が止まる／
  'interrupted' になると、カウントインが拍0に届かず止まる（click→startGame→transport→engine.start→countin までは到達）。
  加えて resume 待ち（最大0.5秒）の間、結果パネルが残って無反応に見えた／結果パネルの smooth スクロール中のタップは iOS で click にならない。
- [x] startTransport：resume は 0.4 秒で打ち切り、currentTime が実際に進むか 0.25 秒以内に確認。ダメなら performance 時計（必ず有限時間で resolve・例外なし）
- [x] audio.now() に監視：state が running 以外、または currentTime が 0.3 秒止まったら performance 時計へ継ぎ目なく切替（以後その回は無音で継続）
- [x] 再戦：タップ直後に結果パネルを隠す・ボタンを無効化（1タップ = 1スタート）、スクロールは開始後に rAF で behavior:'auto'
- [x] 結果パネルの表示スクロールも smooth → auto
- [x] 検証（iPhone 13 エミュレーション＋偽 AudioContext）：running / suspended / resume 無応答 / interrupted / currentTime 停止 / resume 拒否 /
      二重タップ / 同一 tick の3連クリック / プレイ中の時計停止、PC のクリック・Space で、全て countin → playing まで到達、game_start 1回・BGM タイマー最大1

### 初見UX（説明を読まずに遊べるページ）2026-09-27
- [x] HERO：タイトル＋「音を聞いて、振り子が丸に重なる瞬間を叩け。」＋ ▶ PLAY（ゲームへスクロール＋TAP TO START にフォーカスのみ。開始はしない）
- [x] ページ順：HERO → GAME → 遊び方3ステップ（図つき）＋判定 → CHAOS FEVER / コンボで曲が育つ → ランキング → シェア → 詳しく（曲の流れ・難易度・しくみ）→ 制作記録
      （ランキングはコンポーネント内なので、`<slot name="guide">` で説明をゲームとランキングの間に差し込む）
- [x] TAP TO START：「🔊 音あり推奨 / タン・タン・タン・ドン！でタップ」。スマホは上寄せで初期表示内（iPhone 13 相当）
- [x] ゲーム中は「ドン！でタップ」を開始から約6秒だけ表示
- [x] 結果：FINISH! → スコア（大）→ MAX COMBO → NEW BEST → 自己ベスト → もう一回！（主）→ ランキング登録（枠線の副ボタン）
- [x] キーボード：開始前・終了後はエンジンが Space/Enter を奪わない（▶ PLAY・アコーディオン・ニックネーム入力が本来どおり動く）

### 外部音源の曲同期（Burning Heart 系の基盤）2026-09-28
- [x] `SongDefinition` に `bpm` / `audio { src, startAt, offset, volume, tail }` / `credit` / `beatmap` / `harmony`。拍グリッドを曲ごとに（`gridOf(song)`）
- [x] ロード：fetch をページ表示時に先読み、decode は開始時（キャッシュ・4秒タイムアウト）。失敗は同じ grid で合成BGMへフォールバック
- [x] 同期：`src.start(transport.startTime, startAt + offset)`＝曲の拍 n が transport の拍 n。カウントインは曲の前、60秒でフェード＋音程なしの終止
- [x] 再戦ごとに新しい source、前の曲は 50ms フェードで停止。時計停止（iOS）時は外部音源も止めて無音で継続
- [x] バス：曲（bgmGain＝ダッキング）/ cueBus / sfxBus。外部音源のダッキング ×0.42。コンボ／FEVER 層は音程なしの最小限
- [x] credit 表示、GA4 に `song_id` / `audio_mode`、自己ベストは曲 id ごと、既定曲以外はランキング登録しない（ランキングは初期化しない）
- [x] `?song=external_test&debug=1`（+ `bpm/offset/startAt` 上書き）で拍・transport・ファイル位置・メトロノームを表示
- [x] 検証（実 AudioContext＋AudioWorklet でレンダリング後のサンプルを計測）：BPM120・startAt 2.0・offset 0.35 のクリック音源で、
      拍0 = ファイル 2.350s、クリック 123 個すべて拍グリッドから誤差 0.045ms 以内（サンプル丸め）、整数拍の入力拍はすべてクリックと 2ms 以内で一致、
      デコイ（0s/1s）は鳴らない、60秒後はフェード。再戦（2ゲーム目も同精度）・iPhone 13 エミュレーション＋タップ再戦・404 で合成BGMへフォールバック・
      beatmap（A@88→入力拍91、E@93→入力拍96）を確認
- [x] Burning Heart の音源を受け取り → 下の「FULL：Burning Heart」で実装
- [ ] 曲ごとのランキング（今は既定曲のみ。D1 は既存行を消さず、列追加＋既定値で互換にする設計から）

### FULL：Burning Heart（原曲1曲まるごと）2026-09-28
- [x] 実音源の解析（Chromium の decodeAudioData＝ゲームと同じデコーダ）：312.74 秒、BPM 142.000（一定）、拍0 = 0.8735 秒、
      構成（クロマの自己相似＋帯域エネルギー＋中央定位）、決めどころ（16分グリッドのオンセット）、最後の和音 = 拍 708.25
- [x] `BURNING_HEART_SONG`：フル尺（本編 300.0 秒＝拍710、余韻は tail 6.2 秒）、preroll（曲の頭をカウントイン中から）、ownEnding（合成の終止音なし）、
      anchor（デコーダ差の自動補正）、credit「Music: 魔王魂」→ maou.audio
- [x] セクション15（INTRO / CHORUS×3 / RIFF×2 / VERSE×2 / PRE-CHORUS×2 / BRIDGE / GUITAR SOLO / BREAK / FINAL CHORUS / OUTRO）を小節頭で
- [x] 休符：`restBeats`（Aメロ 3〜4拍）、`autoFill: false`（INTRO・ブリッジ・ブレイク・アウトロは固定の一打だけ）
- [x] 固定譜面 33 エントリ（サビ頭の決めフレーズ×4、リフのストップ、ブリッジのキメ、ソロ頭、ブレイクの一撃、ラスサビ後半のソロフレーズ、最後のドラム、FINAL）
- [x] 追加パターン H（タン ドン）/ J（タン ・ドン）/ Z（FINAL：溜めて16分後）— FULL のみ
- [x] サビ：密度UP・枠の明滅（hype）・CHAOS しきい値 6.8。ソロ：裏拍と短い連続。ラスサビ：総復習・約2.7拍に1回・的 ×0.9・しきい値 6.5
- [x] FINAL PERFECT / FINAL HIT! 表示、m:ss の残り時間、FINAL カウント無し（`finalCountdown: false`）
- [x] 外部音源の音：cue に「コッ」を重ねる、区間ごとのダッキング（0.36〜0.5）、区間ごとの和音（B / E♭ / D）、コンボ・FEVER の追加音をごく控えめに、FEVER 突入SE ×0.5
- [x] 先読みデコード（ページ表示時に OfflineAudioContext）、LOADING に曲名、デコード待ちの上限を尺に比例（5分で7.5秒）
- [x] FULL 専用ランク（仮値）・「あと少し」900点、自己ベストは曲 id ごと、ランキングに送らない（登録欄を出さない）
- [x] スタート画面に QUICK / FULL の切替（ページの切替リンク）、結果に「♪ Burning Heart ・ FULL SONG」と QUICK/FULL への導線
- [ ] 実機（iPhone・Android・イヤホン）で：拍0（`?debug=1` の decoder shift と、メトロノーム四角とキックの一致）、cue の聞こえ方、
      ダッキング量、画面ロック・アプリ切替（時計停止 → 無音で継続）、5分通しのメモリ
- [ ] GA4（song_id=burning-heart）の score / result_rank / 区間ごとの MISS で、ランクしきい値・区間の密度を調整

## Next
- [ ] **playtest tuning（60秒版）**：セクション境界ごとの判定分布（hit × section_change）、FEVER の発生回数（多ければ終了後の短いクールダウンを検討）、
      INTRO/CLIMAX の的サイズ倍率、BUILD のフィルや CLIMAX のパッドの音量。実機 20〜30 回＋GA4 の `averageTimingOffsetMs`・判定分布で、カウントイン長・音量・ダッキング量・
      出力レイテンシ補正の要否を決める（判定ロジックは変えない。必要なら timingOffset を補助条件にする案を spec に起こしてから）

## Later
- [ ] プレイ時間モード（QUICK 30 / NORMAL 60 / FULL 90）：`SongDefinition` を足す＋モード UI＋ランキング/自己ベストのモード分離
- [ ] moving targets（動く的。hitAt で必ず軌道と交わる設計が前提）
- [ ] bonus targets（赤＝スコア3倍 / 青＝次の数秒×2 or コンボ保護 / 虹＝FEVER 突入。**時間延長は不可**。FEVER 倍率は ×2 のまま）
- [ ] article update：制作記録 `chaos-pendulum-tsukutta` を現行仕様に加筆（updatedDate 更新）
- [ ] 曲の作り込み（4〜8小節の basic/variation/build/climax）

---

## 履歴（記録のみ。現行仕様ではない）

### 60秒で1曲（2026-09-27・完了）
- [x] docs を30秒版 → 60秒セクション制へ（30秒版は spec の Deprecated に記録）
- [x] `song.ts` 新設：`GAME_DURATION=60`・`SongDefinition`・`GameSection`（sequencePool / musicIntensity / targetScale / arrangement）。
      エンジンは `options.song`、audio は `startTransport(lead, song)` で同じ曲データを使う（尺の直書きをやめた）
- [x] セクション INTRO / GROOVE / BUILD / CLIMAX / FINAL。境界は小節頭に丸める（9.23 / 25.85 / 40.62 / 55.38 秒）
- [x] `section_change` イベント（UI・GA4）。キャンバス下端にセクション名を1秒表示
- [x] セクション別 sequence pool（easy → +standard → build → climax → final）＋パターン E/F/G 追加
- [x] audio：セクションの基本アレンジ（sparse / basic / drive / four、crash、BUILD→CLIMAX のフィル、CLIMAX のパッド、FINAL の締めモチーフ）と
      コンボ層（bass / hihat / melody / FEVER lead）の二層構造。melody のモチーフと音量だけセクションで変わる
- [x] FINAL：「FINAL 5」、背景の 5→1 カウント（2拍ごと）、枠の明滅、残り秒数・バーの強調。最後の入力拍は終止拍の1拍以上前
- [x] 終止：最終拍（拍130＝60.00秒）で BGM ループを止めて終止音、FINISH! 表示 → 1.3秒後に結果パネル
- [x] HUD に残り秒数（TIME 60→0）
- [x] スコア上限 `MAX_SCORE` 20000 → 40000、自己ベストのキーを `cb:best:60:<難易度>` に分離
- [x] 検証：ヘッドレス自動プレイで section_change 5回（0 / 9.23 / 25.85 / 40.62 / 55.38）、34パターン全てで accent=hitTime=グリッド、
      譜面の性格がセクションで変わる（intro: A/B のみ → climax: C/E/F/G 中心 → final: E,C）、最後の入力拍 58.38 秒 → 60.00 秒で終止
- ~~D1 ランキングの初期化~~ → **しない**（2026-09-28 オーナー決定：他の人が遊び始めたため。以後もランキングは消さない）

### transport sync / TAP TO START / instrumentation（2026-09-27・完了）
- [x] **transport sync**
  - [x] `beat-grid.ts` に BPM/SPB/`beatTime(beatIndex)` を一本化（エンジンと audio が共有）
  - [x] `audio.startTransport()`：resume を待ってから `startTime`（拍0）を決定 → BGM を拍0から → カウントイン
  - [x] エンジンは `options.now = audio.now` のみ受け取る（AudioContext 非依存）
  - [x] `newTarget()` を拍番号ベースに（`hitAt = beatTime(hitBeat)`、ずらすときはパターンごと）
  - [x] cue を transport 時刻（絶対）で渡して `startTime + time` に予約（相対 offset を廃止）
  - [x] BGM 拍を `startTime + n×SPB` で毎回再計算（加算誤差なし）
  - [x] dt クランプを 1/30→0.25秒（物理が transport から遅れない）、予測点の選択に `acc` を加味
  - [x] AudioContext 不可の環境は performance 時計で無音進行（時計が止まらない）
- [x] **TAP TO START**：オーバーレイ全体がスタート（タップ / クリック / Space）。4拍カウントイン（3・2・1・GO）は30秒外
- [x] **初回＝retry＝難易度変更 を同じ `startGame()` 経路に**。retry 時は `game_retry` を emit
- [x] **cue/BGM 分離**：BGM マスター 0.9→0.5、ドンを強化、accent 前後 −5dB ダッキング、前ゲームの BGM バス/cue を切断
- [x] **instrumentation**：`game_over` に判定別件数・`averageAbsTimingOffsetMs`・`averageTimingOffsetMs`・`expiredCount`、
      `hit` に `expired`、game 系イベントに `difficulty`
- [x] docs 整理（廃止仕様を spec 末尾に隔離、持続BGMを実装済みとして反映）
- [x] 検証：ヘッドレスで「hitTime ちょうどに押す」自動プレイ → 16/16 PERFECT（距離 1〜8px）＝ ドン・hitAt・的通過が同じ拍
（当時の「30秒固定」は 60秒1曲版で Superseded）

### Superseded：Phase 1 当初チェックリスト
Phase 1 は完了済み（上の Completed）。当初案のうち次は現行と異なる：
- ~~`timeScale` 通常1.0／鬼1.3~~ → **Deprecated**（全段 timeScale=1）
- ~~ターゲット寿命 TTL=3秒~~ → **Superseded**（`hitAt + 1.2拍`）
- ~~「あと Npx」表示~~ → **Superseded**（NEAR は「◯秒早い/遅い」、`nearMissPx` は payload に残るだけ）

### Superseded：Phase 2（2026-09-27）
- ~~CHAOS FEVER の速度 ×1.3~~ → **Deprecated**（得点×2＋演出＋lead 層のみ）
- ~~Magnet Assist（easy 0.6 / normal 0.82）~~ → **Deprecated**（リズム整合のため撤去）
- ~~engine が `beat` イベントを emit → audio.beat~~ → **Superseded**（持続BGMスケジューラ）

### Superseded：Phase 3 当初案
- ~~判定SEにコンボ層（bass/hihat/melody）を一発音で足す~~ → **Superseded**（持続BGMの層）
- ~~青ターゲット＝+2秒~~ → **Deprecated**（30秒固定）
- 動く的・ボーナス的 → Later へ移動

### Superseded：初回 transport（コミット 7099715）
- `startTransport` を同期で呼び、cue を「今から何秒後」の offset で予約していた → Current の絶対時刻方式に置き換え
- 「初回ゲームのみ AudioContext アンロック前開始で頭出しズレ」→ TAP TO START＋resume 待ちで解消

### 外部レビュー反映（2026-09-27・完了）
BPM 量子化 / difficulty 固定バグ修正 / リトライ主CTA / NEAR と MISS の分離 / 点差拡大 / コンボ節目演出 / 「◯秒早い/遅い」
