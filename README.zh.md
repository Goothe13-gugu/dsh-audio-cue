# dsh-audio-cue

DeepSeek Harness **思考和工作时自动播放环境音**，需要你介入时提示一声。

[English](./README.md) · [安装](#安装) · [面板](#面板) · [判定原理](#判定原理) · [常见问题](#常见问题)

<!-- 录好演示 GIF 后放到这里：
![演示](./docs/demo.gif)
-->

- **工作中**——只要还有任何会话（含子代理）处于进行中的回合，环境音就淡入并持续播放。
- **需要你**——代理**请求审批**或**向你提问**时，环境音停下并响一声提示音。
- **空闲**——环境音自动淡出，工作停下来就不会有声音残留。
- **侧边栏旁一个小按钮**打开面板，不需要手改配置文件。

## 安装

```sh
dsh plugin --profile web add dsh-audio-cue
```

然后**重启该 profile**，宿主才会挂载新的插件行。

桌面版的 profile 在应用自己的 harness home 下，所以先把 CLI 指过去：

```powershell
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
dsh plugin --profile web add dsh-audio-cue
```

卸载：

```sh
dsh plugin --profile web remove dsh-audio-cue
```

### 交给 AI 安装

如果你不想手动执行这些步骤，把下面这段直接发给你正在对话的 agent。它是按"宁可报错也不要谎报成功"写的，因为其中每一步都有一个安静的失败方式。

<details>
<summary>给 AI agent 的 prompt</summary>

```text
请为我把 DeepSeek Harness 插件 `dsh-audio-cue` 安装到 `web` profile 并完成验证。
不要发布任何东西，也不要修改该插件的仓库。

有两件事不先确认就会走错路：

1. DSH_HOME。profile 位于 `$DSH_HOME/profiles/<名字>`，默认 home 是 `~/.dsh`；
   而桌面版用的是它自己的 home（Windows 下为
   `%APPDATA%\dsh-desktop\harness`）。装到错误的 home 会安静地创建出第二套空
   profile——里面连其他插件都没有。所以先确认正在运行的 harness 用的是哪个
   home，并在每条命令上都设置 DSH_HOME。
2. CLI。`dsh` 不一定在 PATH 上：桌面版把它打包在应用资源里，路径形如
   `…/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js`，可用紧邻的
   `…/resources/app/node_modules/node/bin/node` 运行。另外 `dsh plugin` 会把参数
   转发给 pnpm，所以 pnpm 也必须在 PATH 上。

然后：

1. 告诉我你找到的 harness home，以及你将要安装到哪个 profile。
2. 执行：dsh plugin --profile web add dsh-audio-cue
3. 向我展示该 profile 的 package.json 里，`dsh-audio-cue` 已同时出现在
   `dependencies` 和 `dsh.profile.bundles` 中。
4. 请我重启宿主，然后停在这里等我确认：插件行只在宿主启动时挂载，而重启会
   终止你自己的会话，所以这件事由我来做，不是由你。
5. 重启后逐项验证，并给出每一步的真实输出：
   - GET http://127.0.0.1:<端口>/dsh-audio-cue/state.json 返回 200，JSON 中含
     `working` 与 `waiting`。<端口> 是 GUI 实际监听的端口；桌面版当前地址
     （含 token）在宿主日志 `%APPDATA%\dsh-desktop\logs\harness.log` 的
     `dsh web:` 那一行。
   - 页面 HTML 中包含 `<script src="/dsh-audio-cue/client.js">`。
   - 插件被使用过一次之后，`$DSH_HOME/dsh-audio-cue/settings.json` 存在。
6. 明确告诉我哪些检查通过了、哪些没有，并附上响应内容。如果有失败，就说失败，
   不要把它概括成"已完成"。

卸载：dsh plugin --profile web remove dsh-audio-cue，然后再次重启宿主。
```

</details>

## 面板

点击侧边栏旁边的按钮打开。

```
┌────────────────────────────────────────┐
│ dsh-audio-cue                      ×   │
│  启用       [🔊 已开启]                 │
│  音量       [======●=====]       65%   │
│  播放方式   [继续播放 ▾]                │
│  工作中音效 [let me go（默认）▾] ▶ 导入…│
│  需审批音效 [默认 ▾]           ▶ 导入… │
│                                        │
│  已导入                                │
│    my-loop.mp3   1.2 MB   ▶   删除     │
└────────────────────────────────────────┘
```

| 控件 | 作用 |
| --- | --- |
| 启用 | 全部静音，角上的图标随之变化 |
| 音量 | 循环音与提示音共用一个音量 |
| 播放方式 | **继续播放**＝从停下的地方接着放；**从头开始**＝每次重新响起时回到开头 |
| 工作中音效 | **无**（静音）、默认音轨，或你导入的文件 |
| 需审批音效 | 提示音的同类选择 |
| 导入… | 上传文件并把该槽位切到它 |
| ▶ | 试听：循环音试听 3 秒，提示音响一次 |
| 删除 | 删除导入文件，并把引用它的槽位重置为默认 |

音量同时作用于提示音，所以**音量为 0 就是完全静音**——面板会相应地显示静音图标，而不只是"调小了"。

### 配置存在哪里

在宿主，不在浏览器：

```
$DSH_HOME/dsh-audio-cue/
  settings.json      静音、音量、播放方式、两个槽位各用哪个音效
  uploads/           你导入的文件与其索引
```

所以配置跟着 harness home 走：清浏览器缓存、换浏览器、重启都还在。而指向**另一个 home** 的会话有它自己的存储——以及没有这个插件。

配置写入走临时文件 + rename，崩溃不会留下半个文件；文件损坏或不可读时回落默认值而不是拒绝加载；槽位指向的文件若已消失，会被修复回默认，而不是留下一个不明所以的静音。

### 控制台接口

用于脚本化，以及面板不够用的时候：

```js
__DSH_AUDIO_CUE__.state()                       // { enabled, volume, last, legacy }
__DSH_AUDIO_CUE__.toggle()                      // 返回新的开关状态
__DSH_AUDIO_CUE__.setVolume(0.4)
__DSH_AUDIO_CUE__.setEnabled(false)             // false = 静音
__DSH_AUDIO_CUE__.open()                        // 打开/关闭面板
__DSH_AUDIO_CUE__.settings()                    // 宿主最近一次返回的配置
__DSH_AUDIO_CUE__.refresh()                     // 重新读取存储
__DSH_AUDIO_CUE__.history()                     // 最近的状态变化，以及各自触发了什么
__DSH_AUDIO_CUE__.setPosition(520)              // 挪动按钮；resetPosition() 撤销
```

## 判定原理

宿主订阅会话事件流，把它归约成一个状态：

| 会话事件 | 效果 |
| --- | --- |
| `turn/start` | 该会话进入**工作中** |
| `turn/end` | 回到空闲，并清除未回答的提问 |
| `approval/asked` | 进入**等你处理** |
| `approval/decided` | 恢复工作中 |
| 向你提问的 `tool/call` | 进入**等你处理** |
| 回答它的 `tool/result` | 恢复工作中 |
| `assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`step/start`、`step/end` | 若该会话尚未打开，则标记为**工作中** |

结果通过 `Server-Sent Events` 发布在 `/dsh-audio-cue/events`：连接时先给一次全量快照，之后每 15 秒一次快照心跳。浏览器半把它变成声音：

```
working === 0               -> 静音
working > 0, waiting === 0  -> 环境音淡入循环
waiting > 0                 -> 静音 + 每次转换响一声提示音
```

这个设计顺带得到几个性质：

- **子代理也算工作**。任何有未结束回合的会话都会让环境音继续，委派出去的工作不会静音。
- **本宿主启动前就已开始的回合也算数**。流式输出、工具调用、步骤推进只可能发生在回合内，所以它们会自行把回合打开。中途挂载、漏掉一帧都能自愈；也不会把声音卡住——只有 `turn/end` 会关闭会话。
- **提问不是审批，但对你来说表现一样**。会话日志里没有 question 事件——提问工具就是一次普通 `tool/call`，所以按工具名识别（`ask_user_question`，或任何参数里带 `questions` 的工具），并用答案的 `sourceEventSeqs` 精确回指，避免并行的其他工具结果提前解除等待态。
- **刷新页面不会继承过期状态**。每条连接先收到一次全量快照，而宿主只把状态放在内存里。
- **宿主挂了就静音**。事件流带心跳，心跳停了页面会安静下来并重连，而不是永远循环。

状态也可以直接取 JSON，这是最快的排障方式。其中 `sessions` 是计数背后的明细——**任何**会话在工作都会让声音继续，所以它是"为什么还在响"这个问题的答案：

```sh
# 端口用 GUI 实际监听的（见 DSH_WEB_URL），每次启动都可能不同
curl http://127.0.0.1:<port>/dsh-audio-cue/state.json
# {"bootId":"k3f9a1","seq":7,"working":1,"waiting":0,"sessions":[{"id":"27410d27","waiting":false}]}
```

## 换成你自己的音频

在面板里导入，或替换 `assets/` 里的内置音效后重启宿主。导入的文件会被复制进存储，原文件之后可以移动或删除。

| | |
| --- | --- |
| 支持格式 | `mp3`、`ogg`/`oga`/`opus`、`wav`、`m4a`、`aac`、`flac`、`webm` |
| 单文件上限 | 8 MB |
| 类型判定 | 优先用 `Content-Type`，浏览器给出不透明类型时回退到文件名 |

随包音效：

- **`let me go`**——工作中音效的默认音轨。**第三方作品，经作者授权打包**，详见 [CREDITS.md](./CREDITS.md)。以 AAC（`.m4a`）格式随包，因为所有浏览器都能解码（含 Safari）；它下面那组合成的 Ogg/MP3 是**解码器兜底**，让不能播 AAC 的浏览器仍有声音，而不是拿到 404。
- **提示音**——合成的两音占位素材，由 `ffmpeg` 生成（命令见 [CHANGELOG.md](./CHANGELOG.md)）。

不无缝的循环每次重复都会"咔"一声。合成占位素材的拼接点实测约 −96 dBFS，而你自己的曲子不一定——这正是**从头开始 / 继续播放**这个选项存在的原因。

## 路由

插件提供的所有内容都在 `/dsh-audio-cue/` 下。排障时有用：

| 路由 | 用途 |
| --- | --- |
| `GET /events` | 状态流（SSE） |
| `GET /state.json` | 同一份快照的 JSON 形式 |
| `GET /api/settings` | 一次取回整个存储 |
| `PUT /api/settings` | 替换它（会校验） |
| `POST /api/uploads?slot=` | 存入一个导入：请求体是原始音频，文件名放在 `x-file-name`，因此不需要 multipart 解析器 |
| `DELETE /api/uploads/<id>` | 删除导入，并重置所有引用它的槽位 |
| `GET /uploads/<id>` | 取单个导入文件（面板试听用） |
| `GET /audio/<slot>` | 槽位解析结果：关闭时 404、导入文件、或内置音效 |
| `GET /asset/<name>` | 随包素材 |
| `GET /client.js` | 浏览器半 |

音频响应在 URL 能锁定字节时**缓存一年**：`/audio/<slot>?v=…` 里的版本令牌包含宿主启动标识与该槽位解析到的文件；`/uploads/<id>` 用永不重复的 id 寻址。不带版本令牌的请求、以及作者可能就地替换的内置素材，都不缓存。

## 常见问题

**完全没声音。** 浏览器在用户手势之前拒绝播放音频：在页面里点一下即可（打开面板也算），环境音随后开始。桌面版的窗口是通过 HTTP 从本机服务加载的，通常直接允许出声，用浏览器打开才是最严格的情况。另外检查音量——0 是完全静音，面板此时会显示静音图标。

**页面上没有按钮。** 浏览器半是注入进 index 的；若缺失，先确认 profile 的 `dsh.profile.bundles` 里确实有 `dsh-audio-cue`，然后重启宿主（插件只在宿主启动时挂载）。

**本来好好的，标签页突然失效。** 宿主重启了：**端口和 token 每次启动都会变**，所以已打开的标签页和书签都会失效。当前地址在宿主日志里：

```powershell
Select-String -Path "$env:APPDATA\dsh-desktop\logs\harness.log" -Pattern 'dsh web:' | Select-Object -Last 1
```

**浏览器会话里不但没有本插件，其他插件也全都不见了。** 那个会话用的是另一个 harness home——最常见的是没设 `DSH_HOME` 就跑了 `dsh web`，它会落到 `~/.dsh` 并初始化一个没有任何插件的全新 profile。

**同时听到两路声音。** 同一页面开了多个标签页，每个都会独立播放。静音掉一个。

**一直响个不停。** 看一下 `state.json`：如果没有任何任务在跑而 `working` 仍大于 0，请把这个响应体贴进 issue。

## 安全

插件的路由**没有鉴权**，这与当前插件生态的其余部分一致。默认绑定回环地址时仅限本机；如果 profile 绑定 `0.0.0.0`，这些路由就能被网络访问——而 `POST /api/uploads` 会在 `$DSH_HOME` 下写文件——所以请把局域网绑定视为把它们暴露出去。

## 开发

```sh
git clone https://github.com/Goothe/dsh-audio-cue
cd dsh-audio-cue
dsh plugin --profile web add link:$PWD   # link 安装，不用发包
npm test
```

两半代码的迭代代价不同：

| | 文件 | 改动后需要 |
| --- | --- | --- |
| 宿主 | `lib/index.js` | 重启宿主（模块在挂载时载入） |
| 浏览器 | `client/audio-cue.js` | 只需刷新页面（从磁盘以 `no-store` 提供） |

```
lib/index.js          宿主半：事件状态机、存储、路由、注入
client/audio-cue.js   浏览器半：状态 -> 声音，以及面板（无需构建）
assets/               随包音频
test/smoke.test.mjs   宿主半，跑在假的 Cordis 上下文里
test/client-load.test.mjs  浏览器半，在 DOM 桩里真正执行
cordis.patch.yml      挂载声明
```

`npm test` 不需要任何依赖，也不需要 harness：宿主套件把插件挂进假上下文并请求它的路由，浏览器套件则**真正运行**客户端脚本——所以语法错误或挂载失败会在构建阶段失败，而不是在用户那里失败。

## 兼容性

已对照 DeepSeek Harness `0.1.2-alpha.1`（DSH Desktop `0.7.1`）验证。插件依赖 `webServer` 服务和若干会话事件名，不从 harness import 任何东西，因此不绑定某条发布线。

桌面窗口是通过 HTTP 从本机服务加载 harness 页面的，所以事件流与素材请求在桌面端和浏览器标签页里走的是同一条路径。

## 贡献

欢迎 issue 与 PR。提 PR 前请跑一遍 `npm test`——最近两次回归都是被这两套测试在发布前拦下的，而不是发布之后。

## 许可

代码为 MIT。随包音轨是第三方作品、经授权使用，详见 [CREDITS.md](./CREDITS.md)。
