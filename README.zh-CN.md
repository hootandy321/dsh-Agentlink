# dsh-Agentlink

![dsh-Agentlink 棣栧浘](assets/dsh-agentlink-cover.webp)

[![CI](https://github.com/hootandy321/dsh-Agentlink/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hootandy321/dsh-Agentlink/actions/workflows/ci.yml) [![GitHub Stars](https://img.shields.io/github/stars/hootandy321/dsh-Agentlink?style=flat-square&logo=github)](https://github.com/hootandy321/dsh-Agentlink/stargazers) [![License: MIT](https://img.shields.io/github/license/hootandy321/dsh-Agentlink?style=flat-square)](LICENSE) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![DSH plugin](https://img.shields.io/badge/DSH-plugin-4B6BFB?style=flat-square)](https://www.deepseek.com/harness/en/)

[English](README.md) | **绠€浣撲腑鏂?*

dsh-Agentlink 鏄竴涓浣犵洿鎺ュ湪鍘熸湰鐨?AI 宸ヤ綔宸ュ叿閲岃皟鐢?DeepSeek Harness锛圖SH锛夊崗浣滅殑鎻掍欢銆備綘鐨勪富 agent 鍙互鎶婂疄鐜般€佽皟鐮斻€佽皟璇曞拰闀挎棩蹇楁暣鐞嗙瓑浠诲姟浜ょ粰 DSH锛屽啀鍦ㄥ師鏈夊伐浣滄祦涓瀵熴€佺户缁垨鍙栨秷瀵瑰簲浼氳瘽銆傚綋鍓嶆敮鎸?Codex锛屽悗缁鍒掓寔缁€傞厤 Claude Code銆乄orkbuddy 绛変富娴?AI coding 涓?agent 宸ュ叿銆?

## 瀹夎

瀹夎鍓嶅厛鍑嗗鐜锛氬彧闇€瑕?**Node.js 22+**銆?*Codex** 鍜屽彲浠ユ甯歌繍琛岀殑 **DSH CLI**銆傚厛鍦?DSH 涓厤缃竴娆′綘甯屾湜浣跨敤鐨勬ā鍨嬶紝涔嬪悗 dsh-Agentlink 浼氳嚜鍔ㄤ娇鐢ㄥ綋鍓嶈矾鐢便€?

### 璁╀綘鐨?AI agent 甯綘瀹夎

鎶婁笅闈㈢殑浠撳簱鍦板潃鍜屾寚浠ょ洿鎺ュ彂缁?Codex 鎴栧叾浠?coding agent锛?

```text
璇蜂粠 https://github.com/hootandy321/dsh-Agentlink 瀹夎 dsh-Agentlink銆?
鍏堟鏌?Node.js 22+銆丏SH CLI 鍜屾垜鐨?DSH Web Host锛屽湪鎴戠‘璁ょ殑鐩綍涓?clone锛?
杩愯 npm install 鍜?npm run setup -- --yes锛岀劧鍚庢墽琛?npm test 涓?npm run doctor銆?
濡傛灉宸茬粡瀛樺湪 dsh_agentlink 鎴栨棫鐗?dsh_collab 閰嶇疆锛屽厛鍚戞垜灞曠ず鍐茬獊锛屽啀鍐冲畾鏄惁浣跨敤 --replace銆?
涓嶈鏇挎垜鍚姩鎴栧仠姝?dsh web锛屽畬鎴愬悗鍛婅瘔鎴戜綍鏃堕渶瑕侀噸鍚?Codex銆?
```

### 鎵嬪姩瀹夎

1. 妫€鏌ョ幆澧冦€傚綋鍓嶇粡杩囨祴璇曠殑 DSH CLI 鐩爣鏄?`0.1.0-rc.6`銆?

   ```bash
   node --version
   dsh --version
   ```

2. 鍦ㄧ嫭绔嬬粓绔惎鍔ㄥ畼鏂?DSH Web Host銆?

   ```bash
   dsh web
   ```

3. 鍏嬮殕浠撳簱銆佸畨瑁呬緷璧栧苟杩愯閰嶇疆鍚戝銆?

   ```bash
   git clone https://github.com/hootandy321/dsh-Agentlink.git
   cd dsh-Agentlink
   npm install
   npm run setup
   ```

   鍚戝鍙細璇㈤棶 Host 鍦板潃鍜?DSH agent preset锛岄殢鍚庡浠?Codex 閰嶇疆锛屽苟浠?`approval_mode = "prompt"` 瀹夎 MCP 鍏ュ彛銆傚畠涓嶄細鍚姩 DSH锛屼篃涓嶄細鏇夸綘閲嶅惎 Codex銆?

   鏃犱氦浜掍娇鐢ㄩ粯璁ゅ€兼椂杩愯 `npm run setup -- --yes`銆傞渶瑕佹洿鏂板凡鏈夐厤缃椂锛岃鍏堟鏌ュ師閰嶇疆锛屽啀杩愯 `npm run setup -- --replace`銆傞厤缃伐鍏蜂細璇嗗埆鏃х増 `dsh_collab`锛屽苟涓斿彧鍦ㄥ緱鍒拌繖娆℃槑纭殑鏇挎崲鎺堟潈鍚庤縼绉讳负 `dsh_agentlink`銆?

4. 閲嶅惎 Codex锛岀劧鍚庨獙璇佽繛鎺ャ€?

   ```bash
   npm run doctor
   ```

閫氳繃 `/mcp` 鎴?Codex 璁剧疆纭 `dsh_agentlink` 宸茶繛鎺ャ€俤octor 杩樹細浠ュ彧璇绘柟寮忔姤鍛?`DSH_BRIDGE_HOME` 涓嬬殑 fail-closed 閿佷綅缃紝涓斾粠涓嶆竻鐞嗗畠浠紝鍥犳鍗充娇瀛樺湪閿佷篃鑳藉畨鍏ㄨ繍琛屻€傞渶瑕佸畬鍏ㄦ墜鍔ㄧ紪杈?TOML 鎴栨煡鐪嬪叏閮ㄧ幆澧冨彉閲忔椂锛岃闃呰[鎵嬪姩 Codex MCP 閰嶇疆](docs/manual-configuration.zh-CN.md)銆?

褰撳墠婧愮爜琛ヤ竵浼氶樆姝㈡柊鐨?projection/chunk 娲嘲缁х画鎵╁ぇ coordination ledger锛屼絾涓嶄細鑷姩鍘嬬缉宸叉湁鐨?5 MB 浠ヤ笂 ledger銆傝淇濈暀鏃?bridge home 澶囨煡锛涙柊鐨勫娲惧彲浠ラ€夋嫨鐙珛鐨?`DSH_BRIDGE_HOME`銆傚璇濈湡婧愬缁堟槸 DSH `session.history`锛屼笉鏄?bridge ledger銆備繚瀹堟仮澶嶈竟鐣岃[宸茬煡闂](KNOWN_ISSUES.md)銆?

dsh-Agentlink 鏄畨瑁呭湪璋冪敤鏂逛竴渚х殑鎻掍欢锛屼笉鏄?DSH Cordis bundle锛涜涓嶈浣跨敤 `dsh plugin --profile ... add ...` 瀹夎銆?

## 涓轰粈涔堥渶瑕?dsh-Agentlink锛?

### 鍒╃敤 DSH 鐨?Harness 鑳藉姏

DSH 涓哄鏉備换鍔℃彁渚涙寔涔?session銆佸伐鍏疯皟鐢ㄣ€乻ubagent 鍜屼汉宸ョ洃鐫ｇ瓑鑳藉姏銆俤sh-Agentlink 璁?Codex 鑳藉涓庤繖濂楃嫭绔?harness 璁ㄨ骞跺崗浣滐紝鍚屾椂涓嶇寮€浣犲師鏈殑宸ヤ綔鍏ュ彛銆?

![Codex 涓?DeepSeek Harness 鍗忎綔](assets/codex-dsh-collaboration.webp)

*Codex 缁х画璐熻矗瑙勫垝銆佽璁哄拰鎬绘帶锛孌SH 璐熻矗鎵ц harness銆佷細璇濅笌 worker銆?

### 涓嶅彧鏄啀澧炲姞涓€涓師鐢?subagent

鍘熺敓 subagent 浠嶅睘浜庤皟鐢ㄦ柟鑷繁鐨?agent tree銆俤sh-Agentlink 鎺ュ叆鐨勬槸涓€濂楃敱鐢ㄦ埛閰嶇疆鐨勭嫭绔?harness锛氫細璇濆彲浠ュ湪 DSH Web 鎸佺画鏌ョ湅锛屼娇鐢?DSH 鑷繁鐨?worker 涓庢ā鍨嬭矾鐢憋紝骞剁敱 Codex 瑙傚療銆佺户缁垨鍙栨秷銆?

![dsh-Agentlink 涓庡師鐢?subagent 瀵规瘮](assets/dsh-vs-native-subagents.webp)

*涓?agent 涓撴敞鍒ゆ柇鍜岄獙鏀讹紝DSH 浣跨敤浣犻厤缃殑妯″瀷鎵挎媴鏇村ぇ瑙勬ā鐨勬墽琛屽伐浣溿€?

### 鐪佹椂闂淬€佷篃鐪佹垚鏈?

- **鐪佹椂闂淬€?* 鎶婂疄鐜般€佹绱€佽祫鏂欐彁鍙栧拰闀挎棩蹇楁暣鐞嗙瓑鎵ц鍨嬩换鍔′氦缁欎綘鍦?DSH 涓厤缃殑楂橀€熸ā鍨嬶紝渚嬪 DeepSeek V4 璺敱锛屼富 agent 鍙互缁х画瑙勫垝鍜岄獙鏀躲€?
- **鐪佹垚鏈€?* 鎶婂ぇ閲忔墽琛?token 璺敱鍒版垚鏈洿浣庣殑 DeepSeek 妯″瀷锛屽彲浠ュ噺灏戝鏄傝吹涓绘ā鍨嬬殑娑堣€椼€?

瀹為檯閫熷害鍜岃垂鐢ㄥ彇鍐充簬妯″瀷銆佹湇鍔″晢銆侀儴缃叉柟寮忋€佺綉缁滀笌浠诲姟鏈韩銆傚畬鎴愬畨瑁呭悗锛屼綘浠嶇劧鍙互鍍忓钩甯镐竴鏍蜂娇鐢?Codex锛屽彧鍦ㄩ€傚悎浜ょ粰 DSH 鎵ц鏃剁洿鎺ヨ瀹冨彂璧峰娲惧嵆鍙€?

## 濡備綍浣跨敤

鍚姩 `dsh web` 骞惰 Codex 閲嶆柊鍔犺浇 MCP 閰嶇疆鍚庯紝鐩存帴鐢ㄨ嚜鐒惰瑷€鍛婅瘔 Codex锛屼緥濡傦細

> 浣跨敤 dsh-Agentlink锛屾妸褰撳墠浠撳簱閲岀殑杩欎釜瀹炵幇浠诲姟濮旀淳缁?DSH銆備繚鎸佷細璇濆湪 DSH Web 鍙锛屽悜鎴戞姤鍛婅繘搴︼紝浠讳綍 approval 閮藉厛璇㈤棶鎴戙€?

涔嬪悗 Codex 鍙互濮旀淳浠诲姟銆佽瀵熶簨浠躲€佺户缁悓涓€浼氳瘽銆佷笌浣犱竴璧峰洖绛?DSH 鐨勯棶棰橈紝鎴栧彇娑堜换鍔°€傛墦寮€ `http://127.0.0.1:3080`锛屽嵆鍙湪 DSH Web 鏌ョ湅骞舵搷浣滃悓涓€涓?session銆?

## MCP 宸ュ叿

- `dsh_host_status` 鈥?璇诲彇 connect-only Host 鐘舵€佷笌 capabilities
- `dsh_delegate` 鈥?鍒涘缓 root session 骞舵帓闃熷垵濮?prompt锛涢粯璁?detached锛坄waitSeconds=0`锛?
- `dsh_followup` 鈥?浠ユ樉寮?`mode="queue"|"steer"` 缁х画鍚屼竴涓?root session锛涢粯璁?`queue`
- `dsh_continue` 鈥?`dsh_followup` 鐨勫吋瀹瑰埆鍚?
- `dsh_status` 鈥?杩斿洖 availability銆乪xecution銆乴ineage銆乹ueue銆乸ending interaction銆乫inal message 鍜?cursors
- `dsh_tail` 鈥?浣跨敤 bridge task cursor 璇诲彇鏈夌晫浜嬩欢鎽樿
- `dsh_wait` 鈥?鏈€澶氱瓑寰?30 绉掞紝鐩村埌鍑虹幇 durable event銆佺姸鎬佸彉鍖栥€乸ending interaction 鎴?terminal 鐘舵€?
- `dsh_observe` 鈥?`dsh_wait` 鐨勫吋瀹瑰埆鍚嶏紱bridge cursor 鍙栦唬鍘熷 per-session seq cursor
- `dsh_cancel` 鈥?`scope="turn"|"queue"`
- `dsh_list` 鈥?鍒楀嚭 task mapping锛屽苟闄勫甫褰撳墠娲剧敓鐘舵€?
- `dsh_answer_question` 鈥?閫氳繃 pending question rpcId 鎻愪氦绫诲瀷鍖栫瓟妗?
- `dsh_resolve_approval` 鈥?瀵?pending approval rpcId 鎻愪氦 `allow_once|reject`
- `dsh_release_workspace` 鈥?鏄惧紡閲婃斁鎸佷箙鍖?workspace claim锛屼絾涓嶅叧闂?DSH session

姝ｅ父濮旀淳娌℃湁 model 鍙傛暟銆傜洰鏍囨ā鍨嬪彧鍦ㄥ畨瑁呮垨璋冩暣 DSH 鏃堕厤缃€傛瘡娆?delegate 閮戒細璇诲彇 `session.models.current` 骞朵俊浠?Host 杩斿洖鐨?`routable`锛沚ridge 涓嶄細淇敼妯″瀷锛屼篃涓嶄細鏍规嵁 catalog group 鑷鎺ㄥ routability銆?

`dsh_wait` 鍙瀵?bridge 鐨勬寔涔呭寲鐘舵€併€俛ssistant delta/chunk 甯у拰椤跺眰 `session/projection` snapshot 浼氳璺宠繃锛屽洜姝や笉浼?bump task revision锛屼篃涓嶄細鍞ら啋 waiter锛泃urn 缁撴潫鍚庣殑瀹屾暣 final message 浠嶅彲閫氳繃 status/tail 瑙傚療銆?

## 鍚庣画鏂瑰悜

浠ヤ笅鍐呭鏄鍒掓柟鍚戯紝涓嶄唬琛ㄥ凡缁忓疄鐜版垨 release 鎵胯銆?

1. **Claude 涓庡叾浠栧叆鍙?* 鈥?鎺㈢储 Claude Code銆丆laude Desktop MCP銆乄orkbuddy 绛夎皟鐢ㄦ柟鎺ュ叆鍚屼竴涓畼鏂?DSH Web Host銆?
2. **Agent 璋冪敤涓庝俊鎭紶杈?* 鈥?浼樺寲 prompt 缁勭粐銆佷笂涓嬫枃鎵撳寘銆佽緭鍑烘憳瑕佸拰鍘嬬缉绛栫暐锛屽悓鏃剁‘淇濋棶棰樸€佸鎵广€侀敊璇拰鏈€缁堢瓟妗堝彲闈犱紶杈撱€?
3. **鏇村闆嗘垚** 鈥?寰?Codex bridge 涓庡吋瀹规€х害瀹氱ǔ瀹氬悗缁х画鎵╁睍銆?

## 鏇村鏂囨。

- [鏋舵瀯涓庡畨鍏ㄦā鍨媇(docs/architecture.zh-CN.md) 鈥?韬唤銆佺姸鎬併€佹仮澶嶃€佸鎵广€佸彇娑堜笌宸ヤ綔鍖哄崗浣?
- [楠岃瘉鎸囧崡](docs/validation.md) 鈥?鍏煎鎬ф鏌ヤ笌浜哄伐楠屾敹娴佺▼
- [宸茬煡闂](KNOWN_ISSUES.md) 鈥?褰撳墠鍗囩骇涓庡苟鍙戣繍琛岄檺鍒?
- [璐＄尞鎸囧崡](CONTRIBUTING.md)涓嶽瀹夊叏璇存槑](SECURITY.md)

## 璁稿彲璇?

[MIT](LICENSE)

Alpha 璇存槑锛欴SH 浠嶅浜?developer preview锛屾湰椤圭洰鏄嫭绔嬬ぞ鍖洪」鐩紝涓嶄唬琛?DeepSeek 鎴?OpenAI 瀹樻柟鑳屼功銆俙0.1.0-alpha.1` 鍖呭惈涓€涓叡浜处鏈苟鍙戦棶棰橈紱淇宸茶繘鍏ユ簮鐮併€佸皻寰呭彂甯冦€傚崌绾ф垨骞跺彂杩愯 bridge 鍓嶈闃呰[宸茬煡闂](KNOWN_ISSUES.md)銆?

---

## ZCode 閫傞厤鐗堬紙浜屽紑璇存槑锛?
> **鏈粨搴撴槸 [hootandy321/dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink) 鐨勪簩娆″紑鍙戠増鏈€?*
> 鍘熺増闈㈠悜 Codex锛屾湰浠撳簱鍦ㄦ鍩虹涓婇澶栭€傞厤浜?**ZCode** 鎻掍欢浣撶郴锛屼娇鍏跺彲浠ュ湪 ZCode 鐜涓棤缂濅娇鐢ㄣ€?>
> 鏈粨搴撶殑 `main` 鍒嗘敮濮嬬粓涓庝笂娓镐繚鎸佸悓姝ワ紝褰撳師浣滆€呮洿鏂版椂浼氳嚜鍔ㄥ悎骞躲€?
### 鎴戜滑鏂板鐨勫唴瀹?
| 璺緞 | 璇存槑 |
|------|------|
| `.zcode-plugin/plugin.json` | ZCode 鎻掍欢 manifest锛屽惈 MCP 鏈嶅姟鍣ㄩ厤缃€佺敤鎴峰彲閰嶇疆鐨?Host URL 鍜?agent preset |
| `skills/dsh-collab/SKILL.md` | ZCode 涓撶敤鍗忎綔鎶€鑳斤紝鍚畬鏁村伐鍏疯皟鐢ㄦ寚鍗椼€佸伐浣滄祦鍜屽畨鍏ㄨ鍒?|
| `scripts/install.ps1` | ZCode 涓€閿畨瑁呰剼鏈紝鑷姩妫€娴嬬幆澧冨苟鍐欏叆 ZCode 閰嶇疆 |
| `.github/workflows/sync-upstream.yml` | 鑷姩鍚屾涓婃父鏇存柊鐨勫伐浣滄祦锛堟瘡 6 灏忔椂妫€鏌ヤ竴娆★級 |

### 鑷姩鍚屾鏈哄埗

鏈粨搴撻厤缃簡 GitHub Action锛?- **姣?6 灏忔椂**鑷姩妫€鏌ヤ笂娓?`hootandy321/dsh-Agentlink` 鏄惁鏈夋柊鎻愪氦
- 鏈夋柊鏇存柊鏃?*鑷姩鍚堝苟**鍒版湰浠撳簱 `main` 鍒嗘敮
- 鍚堝苟鍐茬獊鏃朵細鍦?Actions 鏃ュ織涓憡璀︼紝闇€鎵嬪姩瑙ｅ喅
- 鎴戜滑鐨?ZCode 閫傞厤鏂囦欢锛坄.zcode-plugin/`銆乣skills/`銆乣scripts/`锛夊缁堜繚鐣欙紝涓嶅彈涓婃父褰卞搷

鎵嬪姩鍚屾鍛戒护锛?```bash
git fetch upstream main
git merge upstream/main --no-edit
npm run build
```

### 涓庡師鐗堢殑鍏崇郴

| 椤圭洰 | 閾炬帴 |
|------|------|
| 鍘熺増锛圕odex锛?| https://github.com/hootandy321/dsh-Agentlink |
| **鏈粨搴擄紙ZCode 閫傞厤锛?* | https://github.com/yyz0313/dsh-Agentlink |

涓ゆ潯鍒嗘敮骞惰缁存姢锛屽姛鑳藉畬鍏ㄥ吋瀹广€傛湰浠撳簱鐨勬彁浜ゅ彧娑夊強 ZCode 閫傞厤鍜屽姛鑳芥€у寮猴紙濡?`sessionId` 鍙傛暟锛夛紝涓嶄細淇敼涓婃父鍘熸湁閫昏緫銆?

