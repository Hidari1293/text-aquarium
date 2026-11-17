<div align="center">

# Text Aquarium · 文本鱼缸

**三条字符小鱼住在一个纯白文本鱼缸里。打开边界，它们会游进你的真实桌面。**

`><(((o>`　`<°)))彡`　`><(((*>`

[![版本](https://img.shields.io/badge/version-1.2.1-111111?style=flat)](https://github.com/Hidari1293/text-aquarium/releases)
[![平台](https://img.shields.io/badge/platform-Windows%2010%2B-0078D6?style=flat)](#)
[![许可证](https://img.shields.io/badge/license-CC%20BY--NC--ND%204.0-888888?style=flat)](LICENSE)
[![技术栈](https://img.shields.io/badge/Tauri%202%20%2B%20%E5%8E%9F%E7%94%9F%20ES%20Module-FFC131?style=flat)](#)

[English](README.en.md) | 简体中文

<img src="https://cdn.jsdelivr.net/gh/Hidari1293/text-aquarium@main/docs/screenshot-tank.png" alt="鱼缸" width="640" />

</div>

## 灵感

我想要一个属于自己的宠物系统——不是传统的电子宠物：**不需要喂养，不会饿、不会病、不会死**，没有签到、任务和成就。它只需要安静地存在、自由活动，偶尔让我看上一眼。

于是有了这个鱼缸：三条鱼由字符组成，住在纯白的文本世界里。而鱼缸有一个特别的机制——**边界可以打开**。边界打开后，小鱼会从文本世界里游出来，进入真实的电脑桌面，由黑白变成彩色，在你的窗口上方游来游去。那一刻，整个桌面都变成了它们的海洋。

> 极简、低打扰、无需照料、长期运行。

## 特性

**鱼缸**

- 760 × 480 的纯白鱼缸窗口，可拖动、可缩放
- 默认五条字符小鱼（可调 3–8 条），造型、速度、转向习惯各不相同
- 每条鱼都**游向某个地方**：头朝哪就游向哪，转弯平滑，不会漫无目的地漂
- 掉头是**整鱼调转**（字符反序 + 逐个镜像），身体随游动轻微摆动
- 海草与气泡用字符绘制，轻微摆动；大量留白，安静
- 暂停 / 继续（空格键），暂停不重置位置

**边界与桌面**

- 打开边界后，鱼**只从左右两侧**、朝自己面对的方向游出，绝无割裂感
- 出去的鱼会变彩色并**逐渐加粗**；**颜色跟着背景走**——深色壁纸上自动变亮、浅色壁纸上稍压暗，怎么都显眼
- 鱼出缸后**一直留在桌面**，只有渔网或合上边界才会带它们回家；鱼缸最小化也照游不误
- 桌面层完全透明、置顶、不挡任务栏；默认**鼠标全穿透**，不影响其他软件
- 边界只在主显示器上可用

**与鱼互动**

- 鼠标靠近，鱼会**惊跳逃开**：迎面来的鼠标让它急转往回逃（真实鱼类的 C 型惊跳），背后偷袭的鼠标让它加速前冲
- 鼠标久放不动，游到附近的鱼会好奇地凑过来，**用鼻尖**嘬两下再走
- **捞鱼**：点击「捞鱼」后拖动框住小鱼，它们就会游回鱼缸；Esc 或右键收网

**自定义**

- 设置面板：海草、气泡、高帧率 60、**鱼的数量（3–8）、大小（12–22px）、活泼程度**（速度与好奇心）
- **自定义小鱼**：输入任意字符（≤16 个）即可养一条自己的鱼，头朝右/左可切

## 截图

<div align="center">
  <img src="https://cdn.jsdelivr.net/gh/Hidari1293/text-aquarium@main/docs/screenshot-tank.png" alt="鱼缸" width="420" />
  <img src="https://cdn.jsdelivr.net/gh/Hidari1293/text-aquarium@main/docs/screenshot-desktop.png" alt="游到桌面上的鱼" width="420" />
</div>

## 快速开始

### 直接安装（推荐）

从 [Releases](https://github.com/Hidari1293/text-aquarium/releases/latest) 下载 `Text Aquarium_x64-setup.exe`，双击安装即可：

- 按当前用户安装（`%LOCALAPPDATA%\Text Aquarium`），**不需要管理员权限**
- 依赖 WebView2 Runtime：Windows 10 1803+ / Windows 11 自带，无需额外安装
- 卸载重装后设置仍然保留（`%APPDATA%\TextAquarium\settings.json`）
- 运行时不联网、无账号、无服务器

### 从源码运行

需要 **Node.js 20+** 与 **Rust 1.77+**（MSVC 工具链）：

```bash
npm install
npm run dev          # 开发模式：自带静态服务器（端口 5183）+ 热刷新
npm run build        # 生成 Windows 安装包（NSIS）
```

产物位置：`src-tauri/target/release/bundle/nsis/`。

> 打包时 Tauri CLI 会从 GitHub 下载 NSIS 工具链；网络直连 GitHub 不通时改用镜像：
>
> ```bash
> TAURI_BUNDLER_TOOLS_GITHUB_MIRROR="https://ghfast.top/https://github.com/" \
>   npx tauri build --bundles nsis
> ```

## 测试

五套测试各自负责不同的问题，全部零依赖（node / python），可单独运行：

```bash
node scripts/simtest.mjs       # 81 项：运动、字形、越界、回缸、框选、躲闪方向、
                               #        好奇、侧向出口、设置、自定义鱼（无需窗口）
python scripts/p3test.py       # 49 项：真程序集成——开边界/游出/框选/回缸/鱼鼠交互
python scripts/p2smoke.py      # 26 项：真实鼠标 + 屏幕像素（需要未锁屏的桌面）
python scripts/p5test.py       # 26 项：设置落盘、安装/启动/卸载、交付版无调试通道
python scripts/perf.py         # CPU / 内存实测
python scripts/soak.py 12      # 长跑：预热 3 分钟后量内存斜率
```

性能与验证细节见 [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md)。

## 项目结构

```
src/                  前端（原生 HTML / CSS / ES Module，无框架、无打包器）
  index.html          鱼缸窗口
  overlay.html        桌面透明层
  js/                 main · simulation · fish · fish-behavior · glyph ·
                      coordinates · aquarium · desktop-overlay · overlay ·
                      bubbles · seaweed · settings · test-hooks
src-tauri/            Rust：窗口、置顶、鼠标穿透、工作区几何、光标与背景采样、
                      设置落盘、自检（手写 Win32 FFI，不引 windows-sys）
scripts/              零依赖开发服务器、图标生成、五套测试与性能脚本
docs/                 架构、开发日志、测试报告、任务书
```

## 技术栈与设计原则

| | |
|---|---|
| 桌面框架 | Tauri 2 |
| 前端 | 原生 HTML / CSS / JavaScript（ES Module） |
| 后端 | Rust（仅窗口与系统功能） |
| 数据 | 本地 JSON（`%APPDATA%\TextAquarium\settings.json`） |

- **鱼缸是唯一的大脑**：所有鱼的状态、坐标、越界判定都在鱼缸窗口里；桌面层只是一块会画字的透明玻璃，只收 30Hz 快照
- 鱼的运动基于时间差、有速度上限与转向速率上限——**不瞬移、不重复、不消失**
- 视觉上只有纸白与墨黑：不渐变、不阴影、不贴图；**彩色只属于游到桌面上的鱼**
- 不引入 React / Vue / Electron / 云端服务 / 在线资源

## 版本历史

| 版本 | 日期 | 内容 |
|---|---|---|
| v1.0.0 | 2026-11-17 | 字符鱼缸 + 桌面透明层（首个完整版本） |
| v1.1.0 | 2026-11-17 | 鱼鼠交互、框选捞鱼、可调数量/大小/活泼度、侧向出口 |
| v1.2.0 | 2026-11-17 | 背景自适应颜色与加厚渲染、惊跳式躲闪、鼻尖嘬鼠标、自定义小鱼 |
| v1.2.1 | 2026-11-18 | 方向性躲闪（C 型惊跳）、鱼常驻桌面、出缸无缝 |

## 许可证

[CC BY-NC-ND 4.0](LICENSE) — 署名-非商业性使用-禁止演绎：允许个人自由使用；未经许可，不得用于商业用途或再分发修改版本。

---

<div align="center">
  <sub>鱼不需要喂养，也不会死。它只是在那里游。</sub>
</div>
