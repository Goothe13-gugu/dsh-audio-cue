# dsh-audio-cue

DeepSeek Harness **思考和工作时自动播放环境音**，需要你介入时提示一声。

[English](./README.md) · 安装 · [判定原理](#判定原理) · [常见问题](#常见问题)

<!-- 录好演示 GIF 后放到这里：
![演示](./docs/demo.gif)
-->

- **工作中**——只要还有任何会话（含子代理）处于进行中的回合，柔和的 4 秒环境音就淡入并持续播放。
- **等你处理**——代理请求审批时，环境音淡出并响一声两音提示音。
- **空闲**——环境音自动淡出，工作停下来就不会有声音残留。
- **左下角 22px 开关**一键静音，选择会被记住。没有设置页，没有配置文件。

## 安装

```sh
dsh plugin --profile web add dsh-audio-cue
```

装完**重启该 profile**，宿主才会挂载新的插件行。

桌面版：profile 在应用自己的 harness home 下。先把 CLI 指过去，或等本包被市场收录后直接在应用内的插件市场安装：

```powershell
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
dsh plugin --profile web add dsh-audio-cue
```

卸载：

```sh
dsh plugin --profile web remove dsh-audio-cue
```

## 判定原理

宿主半订阅会话事件流，把四个事件归约成一个状态：

| 会话事件 | 效果 |
| --- | --- |
| `turn/start` | 该会话进入**工作中** |
| `turn/end` | 该会话回到空闲 |
| `approval/asked` | 该会话进入**等你处理** |
| `approval/decided` | 恢复工作中 |

结果通过 `Server-Sent Events` 发布在 `/dsh-audio-cue/events`，浏览器半把它变成声音：

```
working === 0               -> 静音
working > 0, waiting === 0  -> 环境音淡入循环
waiting > 0                 -> 静音 + 每次转换响一声提示音
```

这个设计顺带得到几个性质：

- **子代理也算工作**。任何有未结束回合的会话都会让环境音继续，委派出去的工作不会变成静音。
- **刷新页面不会继承过期状态**。每条连接先收到一次全量快照，而宿主只把状态放在内存里。
- **宿主挂了就静音**。事件流带心跳，心跳停了页面会自动安静，而不是永远循环下去。

状态可以自己查：

```sh
curl http://127.0.0.1:8151/dsh-audio-cue/state.json
# {"bootId":"k3f9a1","seq":7,"working":1,"waiting":0}
```

## 设置

没有配置文件，全部在页面里：

| 做什么 | 怎么做 |
| --- | --- |
| 静音 / 恢复 | 点左下角的 🔇 按钮 |
| 跨刷新记住 | `localStorage["dsh-audio-cue.enabled"]`（`"on"` / `"off"`） |
| 脚本控制 / 调试 | `window.__DSH_AUDIO_CUE__` —— `.toggle()`、`.setEnabled(bool)`、`.state()` |
| 新浏览器的默认值 | 默认**开启**；把该 storage 键设为 `"off"` 可改默认 |

音量常量（`LOOP_VOLUME`、`CHIME_VOLUME`、`FADE_FACTOR`）在 `client/audio-cue.js` 顶部。

## 换成你自己的音频

替换 `assets/` 里的文件并重启宿主即可。**文件名要保持不变**——客户端是按名字取的：

| 文件 | 用途 | 说明 |
| --- | --- | --- |
| `loop.ogg` | 工作循环音 | 首选：Ogg/Opus，在 Chromium 里无缝循环 |
| `loop.mp3` | 循环音兜底 | 只在不支持 Ogg 的环境使用 |
| `needs-you.mp3` | 提示音 | 每次进入"等你处理"响一次 |

两个循环文件会按顺序用 `canPlayType` 探测，所以只放一个也能用。

**随包音频是占位素材**，用 `ffmpeg` 的正弦分量合成（命令见 `CHANGELOG.md`）。请替换成你喜欢的声音——并且无论你放什么，**先确认你有使用权**。不无缝的循环每次重复都会"咔"一声；随包这个的拼接点实测约 −96 dBFS。

## 常见问题

**完全没声音。** 浏览器在用户手势之前拒绝播放音频。在页面里随便点一下即可——插件监听了首次点击或按键，并在下一次状态变化时开始循环。桌面版的窗口是通过 HTTP 从本机 harness 服务加载的（Electron 默认自动播放策略通常直接放行），用浏览器打开 `127.0.0.1:8151` 才是最严格的情况。

**有声音但按钮显示静音。** 按钮反映的是 `localStorage["dsh-audio-cue.enabled"]`，点一下即可恢复。

**同时听到两路声音。** 你在多个标签页开了同一个页面，每个标签页都会独立播放，静音掉一个。

**装完没反应。** 新的 bundle 行需要宿主重启才会挂载——重启 profile，而不只是刷新页面。

**一直响个不停。** 看一下 `state.json`：如果没有任何任务在跑而 `working` 仍大于 0，请把这个响应体贴进 issue。

## 开发

```sh
git clone https://github.com/OWNER/dsh-audio-cue
cd dsh-audio-cue
dsh plugin --profile web add link:$PWD   # link 安装，不用发包
```

然后改 `lib/index.js`（宿主）或 `client/audio-cue.js`（浏览器）并重启 profile。客户端脚本以 `Cache-Control: no-store` 提供，所以宿主重启后普通刷新就能拿到浏览器侧的改动。

测试把宿主半挂进一个假的 Cordis 上下文，覆盖状态机、路由、素材白名单，以及浏览器半引用的素材名——不需要 harness，也没有依赖：

```sh
npm test
```

目录结构：

```
lib/index.js          宿主半：事件状态机、SSE、资源路由、注入
client/audio-cue.js   浏览器半：状态 -> 声音（普通脚本，无需构建）
assets/               音频素材本体
test/smoke.test.mjs   宿主半测试，用 node:test 运行
cordis.patch.yml      挂载声明
```

## 兼容性

已对照 DeepSeek Harness `0.1.2-alpha.1`（DSH Desktop `0.7.1`）验证。插件依赖 `webServer` 服务和四个会话事件名，不从 harness 里 import 任何东西，因此不绑定某条发布线。

注入优先使用结构化注入表（`webserver/index-inject`），对不渲染该表的宿主回退到原始 `tapIndex`。

浏览器半只用相对 URL。桌面窗口是通过 HTTP 从本机服务加载 harness 页面的，因此事件流与素材请求在桌面端和浏览器标签页里走的是同一条路径。

## 许可

MIT
