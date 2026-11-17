# Phase 0 — 环境检查与技术可行性报告

日期：2026-11-17
结论：**Tauri 2 在本机完全可行**。透明置顶窗口、鼠标穿透、双窗口并存、IPC 事件全部实测通过（12/12）。

---

## 1. 开发环境实测

| 项目 | 情况 |
|---|---|
| 操作系统 | Windows（win32, x86_64） |
| 显示 | 2560 × 1600，缩放 175%（DPI 168） |
| Node.js | v22.22.2 |
| npm | 10.9.7 |
| Rust | **初始未安装** → 现场安装 rustup 1.100.0，`stable-x86_64-pc-windows-msvc` |
| MSVC | Visual Studio 生成工具 2026（18.4.11605），MSVC 14.50.35717 |
| Windows SDK | 10.0.26100.0 |
| WebView2 Runtime | 148.0.3967.70（已预装） |
| Tauri CLI | 2.12.5（`@tauri-apps/cli`，npm 安装） |
| tauri crate | 2.12.6 |
| Git | 2.55.0 |

安装 Rust 只用了 rustup 的最小配置（`--profile minimal`），编译与 MSVC 链接验证通过
（`rustc m.rs` 生成并运行可执行文件成功）。

没有使用 React / Vue / Electron / 任何打包器：前端是原生 ES Module，
由 `scripts/dev-server.mjs`（Node 自带 `http`，零依赖）在开发模式下直接提供。

## 2. 技术验证项与结果

自检代码在 `src-tauri/src/techcheck.rs`，全部结论来自**系统 API 回读**，
不是"我觉得应该可以"。

| # | 验证项 | 方法 | 结果 |
|---|---|---|---|
| 1 | 透明窗口能创建 | `WebviewWindowBuilder::transparent(true)` + 像素采样 | PASS |
| 2 | 背景真的透明 | 同一屏幕像素在"显示/隐藏"两层状态下比较 | PASS（都是 `(31,31,31)`） |
| 3 | 置顶 | `GetWindowLongPtr(GWL_EXSTYLE)` 读 `WS_EX_TOPMOST` | PASS（exstyle `0xc0138`） |
| 4 | 不遮挡任务栏 | `GetWindowRect` 与 `SPI_GETWORKAREA` 比对 | PASS（`(0,0,2560,1516)`，任务栏 84px 未被覆盖） |
| 5 | 默认鼠标穿透 | 读 `WS_EX_TRANSPARENT` | PASS |
| 6 | 穿透真的生效 | `WindowFromPoint` 命中测试：命中下层窗口而非透明层 | PASS |
| 7 | 能切回可交互 | `set_ignore_cursor_events(false)` 后 `WindowFromPoint` 命中透明层 | PASS |
| 8 | 能恢复穿透 | 再切回后再测 | PASS |
| 9 | 两个 webview 窗口并存 | `webview_windows()` | PASS（`["overlay","tank"]`） |
| 10 | 主窗口 → 前端 的事件通道 | `emit("tech-report")` → 面板里显示报告 | PASS |
| 11 | DPI 可读 | `GetDpiForWindow` | PASS（168 / 1.75） |
| 12 | 关闭后无残留 | `tasklist` | PASS |

原始报告落在 `%TEMP%\text-aquarium-techcheck.txt`，也可以在
设置面板里点「运行」现场复现（桌面会短暂出现一层彩色小鱼）。

## 3. 踩到并解决的坑

### 3.1 从命令里创建窗口会死锁

`tech_check` 命令最初直接调用 `ensure_overlay()`，界面卡在"正在检测…"永不返回，
Rust 侧也没有任何输出。

原因：`WebviewWindowBuilder::build()` 内部会向事件循环投递任务并**等待**其完成。
无论这段代码跑在主线程（命令同步执行时）、还是套在 `run_on_main_thread` 闭包里，
都会等自己 → 死锁。

解法：把创建动作放到**普通工作线程**里执行（`std::thread::spawn`），
让 `build()` 的内部投递真正落到主线程。已加注释固化这个结论。

### 3.2 隐藏 WebView2 不等于停止渲染

第一版自检结束后用 `hide()` 收起透明层。结果进程树里长期多出一个 renderer
（多占 ~4% CPU、~70MB），因为它仍在按 30fps 合成。

解法：自检结束用 `destroy()` 销毁窗口；`overlay.js` 里也补了
`visibilitychange` 时停 rAF。需要时再按需创建。

### 3.3 透明窗口必须"按工作区"摆放

直接全屏会盖住任务栏。用 `SPI_GETWORKAREA` 拿主显示器工作区（物理像素）后
再用 `set_position/set_size` 设置，才既铺满桌面又不碰任务栏。
`GetWindowRect` 会比视觉窗口大 7px 左右（不可见边框/阴影），做像素比对时要按内容区裁剪。

## 4. 性能实测（本机，3 条鱼 + 海草 + 气泡）

| 场景 | 单核 CPU | 进程 | 合计内存 |
|---|---|---|---|
| 30 fps（默认，前台） | ≈ 11.9% | 7 | 364 MB |
| 60 fps（打开"高帧率 60"） | ≈ 17.4% | 7 | 366 MB |
| 暂停 | ≈ 0% | 7 | 364 MB |

拆分（30fps 场景）：`text-aquarium.exe` 0%、WebView2 浏览器进程 1.4%、
GPU 进程 5.8%、renderer 4.7%。

说明：CPU 主要在 WebView2 的合成与文字绘制上，不在 Rust 侧。
机器是 24 线程，所以"单核 12%"约等于整机 0.5%。
内存的大头是 WebView2 基线（三个子进程），Tauri 应用无法避开这一层。

## 5. 已知限制（第一版即接受）

1. **仅主显示器**：透明层按主显示器工作区摆放；多屏留到后续。
2. **键盘自动化无法验证**：测试环境的 `SendInput` 被安全策略拦截，
   空格暂停 / Esc 关闭面板只能靠代码审查，鼠标路径是实测的。
3. **GetPixel 采样不适用于独占全屏程序**：全屏视频之上透明层仍可见（已实测），
   但像素采样在这种场景会失真，自检时选的是桌面区域。
4. **不追求"只有鱼身区域接收鼠标"**：按任务书用显式的「捞鱼模式」切换整层命中，
   这是更稳且可预期的一版。

## 6. 结论

Phase 0 的所有关键技术点都在这台机器上实测通过，
可以直接进入 Phase 1（基础鱼缸）与后续的桌面层实现。
