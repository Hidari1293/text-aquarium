# 架构说明

## 一句话

**Rust 只负责"窗口与系统"，JS 只负责"鱼与画"。**
两者之间只有两种通信：Tauri 命令（JS → Rust）和 Tauri 事件（窗口 ↔ 窗口）。

鱼缸窗口是唯一的"大脑"：所有鱼的状态、坐标、越界判定都在它里面。
桌面层不持有任何鱼，它只是一块会画字的透明玻璃。

## 两个窗口

| 窗口 | label | 什么时候存在 | 说明 |
|---|---|---|---|
| 鱼缸 | `tank` | 常驻，`tauri.conf.json` 声明 | 白色、可缩放、系统标题栏可拖动 |
| 桌面层 | `overlay` | 打开边界时创建，最后一条鱼回缸后销毁 | 透明、无边框、置顶、跳过任务栏、默认鼠标穿透 |

`overlay` 不在配置里声明，因为它必须**按主显示器工作区**摆放
（`SPI_GETWORKAREA`），并且要能随时销毁：

```
打开边界 → overlay_show()  创建 + 摆到工作区 + 显示 + 默认穿透
关闭边界 → 所有鱼回缸 → overlay_hide() → destroy()

两个窗口都带 `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`：
Chromium 默认会把“看起来没人看”的窗口的 rAF 节流到 1Hz。桌面宠物被浏览器最大化
挡住时鱼会一起僵住——因为模拟跑在鱼缸窗口里。这不是优化，是正确性。
```

销毁而不是隐藏：隐藏的 WebView2 仍占一个 renderer 并持续合成
（Phase 0 实测多 4% 单核、70MB）。代价是下次打开要重新载入页面（约 300ms），
这段时间由 `TANK_OPENING` 状态盖住——边界真正"打开"是在握手完成之后。

### 为什么窗口创建必须发生在工作线程

`WebviewWindowBuilder::build()` 会向事件循环投递任务并等待其完成。
在主线程（或 `run_on_main_thread` 闭包）里调用它会等待自己 → 死锁。
所以 `overlay_show` 是 **async 命令 + `spawn_blocking`**：
命令本身不在主线程跑，`build()` 才拿得到它要的调度。

（Phase 0 时踩过一次，Phase 2 把同一个坑又踩了一次——因为新写的
`overlay_show` 是同步命令。现在固定在 `overlay.rs` 注释里。）

## 数据流

```
tank: simulation.step(dt)
        │
        ├─ renderer.render(sim)          缸内鱼 → 鱼缸画布
        │
        └─ sim.snapshot()                缸外鱼 → 30Hz 快照
                │  emit("tank-frame", {fish:[...]})
                ▼
          overlay 页面（listen）
                │  只存最新一帧
                └─ requestAnimationFrame → 有变化才重绘
```

- 快照里只有 `space === "desk"` 的鱼，字段：`id / g(字形) / x / y / f(朝向) / m(颜色混合) / c(颜色)`,
  以及 `w(波动相位) / p(俯仰) / a(波幅)`——身体形状要跟着鱼一起过边界，否则接缝处会“直”一下。
- 没有鱼在外时**不发帧**，桌面层的 `requestAnimationFrame` 随之停掉。
- 位置是**桌面坐标**，已经是最终值，桌面层不做任何换算（除了减去自己的原点）。
- 节流 28ms，`seq` 单调递增，方便排查丢帧。
- 暂停时鱼缸循环停止 → 不再发快照 → 桌面层保持最后一帧，鱼静止（实测 2 秒 0 像素变化）。

## 坐标系统

两种坐标，一条边界：

| 坐标 | 原点 | 谁在用 |
|---|---|---|
| 缸内坐标 | 鱼缸画布左上角 | `space === "tank"` 的鱼 |
| 桌面坐标 | 桌面层客户区左上角（= 主显示器工作区） | `space === "desk"` 的鱼、桌面层绘制 |

换算（`coordinates.js`）：

```
桌面坐标 = (屏幕物理坐标 - 桌面层客户区原点) / scale
鱼缸画布在桌面坐标里的位置 = (鱼缸客户区原点 - 桌面层客户区原点) / scale + 画布在客户区内的偏移
```

两个窗口在同一台显示器上，`scale` 相同（本机 1.75），所以一次除法就够。
`tank_placement` 拿鱼缸客户区原点，`work_area` 拿工作区，
两者都由 Rust 直接问系统，前端不猜。

### 为什么鱼要有两个空间

鱼在缸里时必须**跟着窗口走**（拖窗口时鱼不能留在原地），所以缸内鱼用缸内坐标。
鱼出了边界就是桌面上的东西，窗口再动它也不该动，所以缸外鱼用桌面坐标。
越界/回缸的那一帧做一次转换，位置连续、颜色从 0 开始，接缝看不出来：

```
越界：x += tankRect.x; y += tankRect.y;  space = "desk"; state = "outside"; colorMix 0 → 1
回缸：x -= tankRect.x; y -= tankRect.y;  space = "tank"; state = "inside"; colorMix → 0
```

缸外鱼在窗口被拖动/缩放时**不跟着变**，这是正确的，也是 Phase 2 验收里
"窗口移动或调整大小时鱼的位置合理"的含义。

## 绘制分工（不许重复画）

| 鱼的状态 | 谁画 |
|---|---|
| `space === "tank"` | 鱼缸画布（黑色） |
| `space === "desk"` | 桌面层（彩色） |

同一帧里一条鱼只出现在一个画布上。越界那一帧 `colorMix` 正好是 0（还是墨黑），
所以"换画布"这件事在视觉上不可见——这是"不重复出现、不消失"的实现方式。

## 输入策略（不挡鼠标）

桌面层默认 `WS_EX_TRANSPARENT`（`set_ignore_cursor_events(true)`），
点击直接落到下面的程序上。

「捞鱼」模式打开后，桌面层**不是**整屏接管，而是每 55ms 问一次 `cursor_pos`：

```
光标离任一条鱼的字形框 < 14px  → set_ignore_cursor_events(false)  能被点到
否则                            → set_ignore_cursor_events(true)   照常穿透
```

所以"只有小鱼那一小块会接住点击"，屏幕其余部分仍然正常使用。
代价：光标刚离开小鱼的那 55ms 内，桌面层还是可命中的；点空白处会立刻恢复穿透。

## 目录

```
src/
  index.html            鱼缸窗口
  overlay.html          桌面透明层
  styles/base.css       纸白 + 墨黑 + 等宽，全局唯一的视觉基调
  styles/aquarium.css   鱼缸布局、设置面板
  styles/desktop.css    透明页（hunting / can-grab 两个状态类）
  js/main.js            启动、主循环、边界状态机、按钮与面板接线
  js/simulation.js      世界容器：几何、越界/回缸、抓取/拖动/放下、快照
  js/fish.js            单条鱼：空间、状态、颜色、积分、巡航目标、硬边界兜底
  js/fish-behavior.js   纯函数转向：避墙、避让
  js/glyph.js           字形布局：逐字符纵向偏移 = 身体波动 + 头尾俯仰
  js/coordinates.js     桌面坐标、颜色混合、矩形几何
  js/aquarium.js        鱼缸 Canvas 渲染（鱼/海草/气泡/砂砾，离屏背景 + 脏矩形）
  js/desktop-overlay.js 鱼缸这一侧的桌面层控制（创建/销毁/推帧/捞鱼开关/拖动转发）
  js/overlay.js         桌面层页面：收帧、绘制、命中测试、光标探针、拖动
  js/bubbles.js         气泡：稀疏上浮
  js/seaweed.js         海草：分簇、弯曲、摆动
  js/settings.js        设置读写（优先 %APPDATA% 文件，localStorage 兜底）
  js/test-hooks.js      只在 127.0.0.1 下安装的测试通道（见 TEST_REPORT 26）
src-tauri/src/
  main.rs               入口
  lib.rs                命令注册、单实例、关闭时清理桌面层
  overlay.rs            透明窗口：创建、工作区几何、穿透开关、光标位置
  settings.rs           设置落盘（%APPDATA%\TextAquarium\settings.json）
  techcheck.rs          Phase 0 自检（读回系统状态 + A/B 像素探针）
  debug.rs              调试通道：日志、探针/画布导出、窗口列表（测试用）
  win32.rs              手写的极薄 Win32 FFI（不引 windows-sys）
scripts/
  dev-server.mjs        零依赖静态服务器（开发模式）
  make-icon.py          用 Pillow 生成图标源图
  grab.py               截图工具（开发自测用）
  p2test.py             Win32 + 像素工具箱（命中测试、找鱼、窗口几何）
  p2smoke.py            整链路冒烟测试：25 项断言（需要未锁屏的桌面）
  p3drive.py            测试通道客户端：让页面执行命令、导出状态/画布
  p3test.py             Phase 3/4 集成测试：39 项断言
  simtest.mjs           运动/字形/状态逻辑测试：44 项断言，不需要窗口
  perf.py               CPU 与内存实测（整棵进程树）
  soak.py               长跑内存检查
```

## 主循环

`main.js` 里只有一个 `requestAnimationFrame` 循环，规则：

1. **按时间推进**：`dt` 来自真实时间戳，与帧率无关；`dt` 上限 0.1s，卡顿后不会瞬移。
2. **按预算跳帧**：目标帧率 = 前台 `30`（可选 `60`）/ 后台 `24`；用 `elapsed < 0.85 * budget`
   判断跳过，避免 60Hz 屏被误砍成 30。
3. **暂停即停循环**：`cancelAnimationFrame`，不是空转；暂停时 CPU 归零、位置保留。
4. **隐藏即停循环**：`visibilitychange` 同样处理。

渲染侧：

- `ctx.font` 只在变化时赋值（赋值会重新解析 CSS 字体简写）；`canvas.width` 赋值会重置
  上下文状态，所以 `resize()` 必须清掉字体缓存，否则会用 10px 的字画 15px 的布局。
- 坐标吸附到 0.5px（字形清晰但不抖）。
- 鱼缸：水草/气泡/砂砾画进离屏画布，14Hz 刷新；鱼只擦自己上一帧的方框，再从离屏背景
  把那块补回来。全画布 clear + blit 是这一层最贵的事。
- 桌面层：只清/画有墨的矩形，设备像素比上限 1.5（15px 字形再高看不出差别）。
- 桌面层的绘制循环**没有常驻 rAF**：有帧或有交互才排一帧，画完就停。

## 鱼的行为模型

每条鱼持有一份参数（速度、转向速率、游荡幅度、游荡间隔）。
**它永远在游向某个点**：有任务时游向任务点（出口 / 回家的缸内点），
没有任务时游向一个 `cruise` 目标——离自己至少 240px（或缸宽 40%），
到达 34px 内或每隔 0.8–5.4 秒重选一次。

```
目标向量 = 目标点方向（+ 慢速摆动）+ 避墙力 × 3.0 + 邻鱼排斥力 × 2.4
朝向以 turnRate 为上限向目标旋转（永不瞬变）
速度按 accel 缓动，靠近墙时降到 65%，有任务时 ×1.7
```

这一条是“鱼头朝哪就游向哪、不漫无目的飘”的实现：heading 就是身体朝向，
身体朝向就是速度方向；随机性只体现在“选哪个目标点”和沿路的轻微摆动上。

### 身体形状（`glyph.js`）

一行字符转不了，但可以弯。每个字符有自己的纵向偏移：

```
u    = i / (n-1)                          0 = 头，1 = 尾
wave = sin(phase - u*3.1) * amp * (0.25 + 0.75u)   尾部摆幅是头的 4 倍
tilt = sin(heading) * 3.2 * (1 - 2u)               向下游时头低于尾巴
```

`phase` 按 `bobSpeed*1.6 + speed*0.05` 推进。两个画布共用这份布局，
所以鱼过边界时形状不变（快照里带着 `w/p/a`）。

- **避墙力**来自"离墙 margin(58px) 之内的距离比例"，所以鱼在**碰到墙之前**就开始转。
- 边界关闭时硬边界（`keepInside`）兜底；边界打开时关掉兜底，鱼才能真的出去。
- **有目标时**（越界 / 回缸）不用避墙力，速度 ×1.7、加速度 ×1.6，
  这样一趟往返是几秒而不是一分钟；到达后自动降回原速。
- **不重叠**：62px 内互相排斥（桌面层更宽，78px）。
- 撞墙时把 `targetHeading` 重置为反弹后的朝向，并推迟下次游荡决策，避免"撞墙—立刻转回墙里"。

## 状态机

程序级（`main.js` 的 `setStage`，所有切换必经此处）：

```
CLOSED ──点开边界──> OPENING ──握手完成──> OPEN
  ▲                                          │
  └──── 所有鱼回缸 + 桌面层销毁 ── RETURNING ◀┘
                PAUSED（随时可进入，冻结一切；进入时自动退出捞鱼模式）
```

规则：

- `OPENING` 期间按钮禁用（这一刻没有可取消的东西，连点会造成两次创建）。
  `RETURNING` 期间按钮变成「重新打开」：点了就取消回缸，鱼继续留在桌面。
  人想反悔时第一反应就是再点一次，禁用按钮只会让人以为程序卡住。
- 外游计时只在 `openBoundary()` 里发放：每条鱼 `exitAt = now + 1.0~7.0s`（错开，不会三条一起冲出去）。
- `closeBoundary()` 立刻停止生成外游意图，并给缸外鱼 `returnAt = now + 0~1.6s`（错开，不会挤在同一个点上）。
- 回缸完成由主循环判定（`counts().desk === 0`），然后才销毁桌面层——顺序不能反，否则鱼会凭空消失。

鱼级：`inside | crossing | outside | returning | dragging`

- `crossing` 是"正朝边界游"，中心一过边线就切成 `outside` 并换空间。
- 边界打开时，缸外的鱼过 14~30 秒可能自己游回来（自由进出），回来后过 8~20 秒又可能再出去。
- 关闭边界时 `returning` 优先于一切：目标点取离它最近的缸内点，并夹在屏幕内（缸挂在屏幕外时不会把鱼拖出屏幕）。
- 如果夹住之后目标根本进不去（缸几乎完全出屏），鱼会在目标附近停住：2.5 秒后
  `rescue()` 把它放回缸内。这一跳只发生在缸本身看不见的时候，但避免了
  “回缸永不完成 → 透明层永不关闭”的死状态。
- `dragging`：鼠标按住时位置由 `dragFish()` 直接赋值，物理与转向都不参与；
  2.5 秒收不到拖动事件就当作松手（层崩了 / 鼠标丢了）。

## 捞鱼链路

```
overlay: pointerdown 命中鱼 → emit overlay-grab
tank:    grabFish(id) → state = dragging
overlay: pointermove → 本地即时绘制 + 每 16ms emit overlay-drag(桌面坐标)
tank:    dragFish(id, x, y)  → 位置、朝向（拖动方向）
overlay: pointerup → emit overlay-drop(桌面坐标)
tank:    dropFish(id, x, y) → 缸内: enterTank（立即变黑）/ 缸外: outside（18 秒内不再自己往回游）
```

拖动期间桌面层始终可命中；松手后立刻回到“光标靠近鱼才接住”的判定。

## 单实例

第二个实例启动时创建同名 mutex 失败，直接把已有窗口提到前台并退出。
两个鱼缸 = 两组鱼 + 两层桌面，必须避免。

## 视觉约束落点

| 约束 | 实现位置 |
|---|---|
| 纯白 / 纯黑 | `base.css` 的 `--paper` / `--ink` |
| 等宽字体 | `FONT_STACK`（Cascadia Mono → Consolas → monospace） |
| 不用渐变/阴影/贴图 | 全局没有 box-shadow / gradient / 图片；两块画布都只 `fillText` |
| 鱼缸内只有黑 | `fish.tankColor` 恒为 `#111`；海草 0.45、气泡 0.22–0.32 透明度 |
| 桌面才彩色 | `coordinates.blend()` 把墨黑混向 `fish.oceanColor`（橙 / 蓝 / 青绿），`colorMix` 0→1 |
| 大量留白 | 3 条鱼 + 6 簇海草 + ≤6 个气泡，其余是空白 |
| 边界打开要有反馈 | 鱼缸边框由实线变虚线（`.tank.is-open`） |

## 内存与"为什么它看起来在涨"

一个长期开着的桌面宠物，最容易被误判的就是内存。这里的口径写清楚，免得下次自己吓自己：

- **工作集（Task Manager 默认那列）不是泄漏证据**。它包含缓存页，Windows 会随时修剪：
  实测同一轮长跑里出现过 482 MB → 445 MB → 481 MB 的回落。`scripts/perf.py` 因此另外读
  `PrivateUsage`（commit），这个数只在进程真的申请内存时才涨。
- **冷启动的头几分钟一定会涨**：WebView2 的合成层、V8 堆、字形缓存都是懒分配。
  实测鱼缸模式 375 → 392 MB（约 1.5 分钟）后走平；桌面模式因为多一块全屏透明画布，
  涨到第 5 分钟才平。所以 `scripts/soak.py` 先预热再量斜率。
- **两块画布的代价不对称**：鱼缸画布 1281×707，桌面层是整块工作区（2560×1600，dpr 1.5
  → 3834×2400 ≈ 37 MB/缓冲）。要再压内存，先压低桌面层的 dpr 或者干脆改成
  单窗口 + `WS_EX_LAYERED` 直接画，而不是继续挤鱼缸。

这几条都在 `docs/TEST_REPORT.md` 第 29 节有对应实验，留的是数字不是结论口号。

## 依赖清单（刻意保持很短）

- Rust：`tauri` 2、`serde`
- 前端：无运行时依赖，原生 ES Module
- 开发：`@tauri-apps/cli`
- 自测脚本：Python + Pillow / numpy（仅开发用，不进产物）

Win32 调用是手写的 15 个函数声明（`win32.rs`），没有引入 `windows` / `windows-sys`，
避免类型版本漂移，也让编译时间更短。
