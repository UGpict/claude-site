# plan: CHAOS BEAT 実装手順

spec: [../specs/chaos-beat.md](../specs/chaos-beat.md) / design: [../design/chaos-beat.md](../design/chaos-beat.md)

チェックを1つずつ潰す。plan から外れる判断が出たら、コードより先に spec/design を直す。

## Phase 1 — コアループ（これだけで化ける）

> ✅ 2026-09-27 実装・デプロイ済み（下記チェック項目は概ね完了）。手触りは実機で検証中。
> 音は判定SEのみ（ビート音は Phase 2）。BPM脈動は視覚のみ実装。
### エンジン（chaos-pendulum.ts）
- [ ] 状態機械を `playing/slowmo/over` に作り替え、`GAME_TIME=30` の実時間カウントに変更
- [ ] `timeScale` を導入し、物理積分に掛ける（slowmo≈0.15／通常1.0／鬼1.3）
- [ ] ターゲットを `{x,y,r,bornAt}` 化し、`newTarget()` で1つずつ出す
- [ ] **ターゲット寿命 TTL=3秒**：超過で MISS（コンボ切断・0点）→即次
- [ ] **入力ロック**：act() 先頭で `if (state !== 'playing') return;`
- [ ] 叩く act()：距離→判定(kind)→**GOOD以上なら combo+1→倍率再計算→`score += round(pts×mult)`**（NEAR/MISS は0点・combo=0）→ maxCombo 更新 →slowmo→次の的
- [ ] 判定しきい値（0.35R/0.7R/R/1.25R、超or寿命切れ=miss）とラベル(kind)を実装
- [ ] **BPM脈動（視覚）**：BPM=130 で描画時に的半径を脈動（判定距離は素のR）
- [ ] 「あと Npx」用に nearMissPx を算出して payload へ
- [ ] onEvent を作り替え（game_start / hit / game_over）。round_complete 等の5R名残を削除
- [ ] 5ラウンド・「次へ」・timeout(15秒)・over時ボタン隠しなどの旧仕様を撤去
- [ ] 30秒で game_over。setDifficulty/restart は維持（restart=即リトライ）

### 描画・演出
- [ ] HUD：残り時間バー（30秒）、スコア、コンボ、倍率
- [ ] 判定ラベル（PERFECT/GREAT/GOOD/MISS/NEAR MISS）を大きくポップ表示（既存 popT 流用）
- [ ] 成功パーティクル（既存 burst 流用）を kind で強弱
- [ ] slowmo 中の視覚（軽い残像 or フラッシュ）

### 音（audio.ts）
- [ ] 判定SEを kind 別に（PERFECT 豪華／GREAT/GOOD 軽め／MISS 濁り）※ビート/レイヤーは Phase 2/3

### コンポーネント（ChaosPendulum.astro）
- [ ] HUD DOM（スコア/コンボ/タイム）と結果パネル（スコア＋最大コンボ＋即リトライ）に作り替え
- [ ] onEvent 橋渡しを hit/game_over に更新（GA4・音・自己ベスト・ランキング）
- [ ] 「1から始める」→「もう一回」（即リトライ）に。5R前提のコピー撤去
- [ ] 難易度セレクター・ランキングタブは流用

### 保存・通信・DB
- [ ] storage.ts：自己ベストを {score, maxCombo} に
- [ ] migration 0003：`max_combo` 追加。切替時に既存行 DELETE
- [ ] scores.ts：payload に maxCombo/hits、検証を新レンジに、保存に max_combo
- [ ] ranking.ts（front/back）：maxCombo を返し、並びに副キー追加。行に最大コンボ併記
- [ ] D1 マイグレーション適用（--remote）＋既存行クリア

### 仕上げ
- [ ] ゲームページのコピー（lead/how-to）を30秒・コンボ・判定に更新
- [ ] `npx astro build` 通過を確認 → コミット → プッシュ → 実機で手触り確認

## Phase 2 — 気持ちよさ ✅ 2026-09-27 実装・デプロイ済み
- [x] CHAOS FEVER（PERFECT3連→速度1.3×・得点2×・縁の明滅＋FEVER表示・MISS/NEARで解除）
- [x] Magnet Assist（easy assist=0.6／normal=0.82／hard・oni=なし。的付近90pxでスロー）
- [x] BPM 拍の音（engine が `beat` イベントを emit → audio.beat。4拍ごとにアクセント）。的の視覚脈動は Phase 1 済み

## Phase 3 — アーケード化
- [ ] コンボで曲が層を増す（drum→bass→synth→melody）
- [ ] 動く的（ステージ進行でゆっくり移動）
- [ ] ボーナス的（赤3倍／青+2秒／虹FEVER）

## 共通トランスポート＋TAP TO START（2026-09-27）＝拍の位相を全部揃える
- [x] ① `transportStart` に BGM・cue・アプローチリング・hitAt・gameTime を統一。`audio.startTransport/now` を追加し
      エンジン `options.now` に注入（gameTime=now()）。BGMの `currentTime+0.1` 別クロックを撤廃（位相ズレ~0.36s を解消）
- [x] ② TAP TO START：`autostart:false`＋idleプレビュー→START/スペースで resume＋4拍カウントイン（3・2・1・GO）→拍0で開始。
      もう一回・難易度変更も startGame（transport張り直し）に統一。初回Autoplay問題も解消
- [x] ③ cue/BGM音量分離（cueは高め・BGM控えめ、bgmGain別系統）＝予告が埋もれない
- [ ] ④ 実プレイ20〜30回で判定感・カウントイン長・音量の最終調整（次段）
- [ ] 曲の作り込み（1小節→4小節 basic/variation/build/climax）は④の後（次段）

## 譜面シーケンス＋持続BGM（2026-09-27）＝「曲が完成していく」化
- [x] Part1: `RHYTHM_SEQUENCES`＋`EASY_SEQUENCES`。`nextPattern()` でシーケンスを順番消化・直前と同じ回避・序盤は易しいのみ。random 廃止
- [x] Part2: audio に持続BGMスケジューラ（先読み25ms / lookahead0.12s / bgmGain 別系統）
- [x] レイヤー：drum(常時) / +bass(combo3) / +hihat(combo5) / +melody(combo10) / +lead(FEVER)。切替は拍に同期
- [x] MISS で combo0→次の拍から drum だけに自然減。game_over で 0.3s フェードアウト。retry で拍頭から再開
- [x] judgment のコンボ一発層は撤去（役割分担：judgment=SE / scheduler=BGM）。cue(ドン)は低音BGMと分離して埋もれさせない
- [x] 節目ポップに ♪BASS/♪HAT/♪MELODY を表示（層追加を視覚でも）
- [ ] （残）初回ゲームのみ AudioContext アンロック前開始で頭出しズレの可能性（retry以降は正確）。必要なら[TAP TO START]

## リズム入力システム（2026-09-27）＝「音を聞いて押す」化
- [x] `RHYTHM_PATTERN` データ構造＋初期4パターン（A/B/C/D、タン・タン・ドン系＋裏拍）
- [x] ターゲット生成をパターンの入力拍(hitBeat)に量子化。hitAt=次の拍+hitBeat×BEAT の予測軌道点へ
- [x] `rhythm_pattern` イベントで cue の offset 配列を渡し、`audio.scheduleRhythm` が AudioContext.currentTime で先読み予約（fps非依存）
- [x] **リズム整合の不変条件**：的が生きている間 timeScale=1。フィーバー速度×1.3・Magnet Assist・鬼speed を全廃（音とズレるため）
- [x] アプローチリング（外側から縮む輪が的に重なった瞬間＝入力拍）で視覚同期
- [x] `timingOffsetMs`（予定入力拍とのズレ）を hit payload に追加。near は「◯秒早い/遅い」に使用
- [x] コンボで判定SEに層を足す（3=bass/5=hihat/10=melody/FEVER=lead、MISSで剥がれる）＝最小の曲成長
- [ ] （残）専用BGMループ／さらに凝ったパターン／FEVER超強化（⑨）は次段

## 外部レビュー反映（2026-09-27）
- [x] ① ターゲット到達時刻を **BPM に量子化**（次の拍＋1〜3拍先の軌道点に配置）＝リズム×カオス化
- [x] ② 結果送信の **difficulty 固定バグ修正**（lastResult に難易度を保存し、それで送信）
- [x] ③ リトライを結果画面の**主CTA**に（大ボタン＋スペース/Enterで即リトライ）。ランキング登録は副導線
- [x] ④ **NEAR MISS と MISS を分離**（near=「◯秒早い/遅い！」、miss=「MISS」のみ）
- [x] ⑤ PERFECT–GOOD の**点差拡大**（PERFECT90-100/GREAT70-90/GOOD40-70、内部100点は維持）
- [x] ⑥ **コンボ節目演出**（3/5/10で「×倍率!」ポップ＋「あと1回で×N」ヒント）
- [x] ⑦ **「◯秒早い/遅い」**（軌道予測±0.45秒で最接近時刻を探索）
- [ ] ⑧ 曲レイヤー（0→kick / 3→bass / 5→hihat / 10→melody / FEVER→lead、MISSで層が剥がれる）※次回
- [ ] ⑨ FEVER 超強化（虹的・軌跡2倍・微シェイク・背景フラッシュ・巨大×2表示）※次回

## あとで（別タスク）
- [ ] 制作記録記事 `chaos-pendulum-tsukutta` を作り替え後の内容に加筆（updatedDate 更新）
- [ ] タイトルを「CHAOS BEAT」にするか最終決定（表記・OGP・スラッグ）
