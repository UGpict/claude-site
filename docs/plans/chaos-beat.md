# plan: CHAOS BEAT

spec: [../specs/chaos-beat.md](../specs/chaos-beat.md) / design: [../design/chaos-beat.md](../design/chaos-beat.md)

plan から外れる判断が出たら、コードより先に spec/design を直す。
**現行仕様は spec/design が正**。下の「履歴」は経緯の記録で、Superseded/Deprecated の項目を現行仕様と読まないこと。

## Completed
- [x] **Phase 1 core loop**：30秒固定・1的ずつ・寿命切れ MISS・距離判定（PERFECT/GREAT/GOOD/NEAR/MISS）・
      NEAR/MISS 0点・0.2秒スロー＋入力ロック・コンボ倍率・BPM脈動・即リトライ
- [x] **rhythm input**：`RHYTHM_PATTERNS` A〜D・入力拍に量子化した未来軌道点へ配置・cue 先読み予約・
      アプローチリング・`timingOffsetMs`・リズム整合（timeScale=1）
- [x] **sequence**：`RHYTHM_SEQUENCES`／`EASY_SEQUENCES`、順番消化・直前回避・序盤は易しい方のみ
- [x] **persistent music**：drum / +bass(3) / +hihat(5) / +melody(10) / +lead(FEVER)、MISS で次拍から drum のみ、game_over でフェード
- [x] **ranking**：難易度別・今日/今週/歴代、score＋maxCombo、自己ベスト、GA4

## Current（2026-09-27 実装）
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

## Next
- [ ] **playtest tuning**：実機 20〜30 回＋GA4 の `averageTimingOffsetMs`・判定分布で、カウントイン長・音量・ダッキング量・
      出力レイテンシ補正の要否を決める（判定ロジックは変えない。必要なら timingOffset を補助条件にする案を spec に起こしてから）
- [ ] **FEVER polish**（控えめに。速度は変えない）

## Later
- [ ] moving targets（動く的。hitAt で必ず軌道と交わる設計が前提）
- [ ] bonus targets（赤＝スコア3倍 / 青＝次の数秒×2 or コンボ保護 / 虹＝FEVER。**時間延長は不可**）
- [ ] article update：制作記録 `chaos-pendulum-tsukutta` を現行仕様に加筆（updatedDate 更新）
- [ ] 曲の作り込み（4〜8小節の basic/variation/build/climax）

---

## 履歴（記録のみ。現行仕様ではない）

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
