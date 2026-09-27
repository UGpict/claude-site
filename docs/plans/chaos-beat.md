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

## Current：CHAOS FEVER 強化（2026-09-27 実装）
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

## Next
- [ ] **要オーナー判断：D1 ランキングの初期化**（30秒版スコアは比較不能。手順は履歴「60秒で1曲」参照。自動では実行しない）
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
- [ ] **要オーナー判断：D1 ランキングの初期化**（30秒版のスコアは比較不能）。自動では実行しない。実行する場合：
  ```
  # 念のためバックアップ
  npx wrangler d1 export chaos_pendulum --remote --output=backup-30s.sql
  # 初期化（60秒版の公開直前・直後に）
  npx wrangler d1 execute chaos_pendulum --remote --command="DELETE FROM chaos_pendulum_scores;"
  ```

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
