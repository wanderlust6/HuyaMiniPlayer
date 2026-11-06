# Huya Mini Player

虎牙直播 Canvas 画中画与弹幕叠加工具，提供 Chromium / Edge 扩展和 Tampermonkey 用户脚本两种安装形态。

## 功能

- 将虎牙直播视频绘制到 Canvas，并通过 Canvas 捕获流输出到画中画（PiP）窗口
- 从虎牙聊天列表提取消息，作为独立弹幕叠加到小窗画面
- 支持弹幕透明度、字体大小、滚动速度和屏蔽词设置
- 设置通过当前虎牙页面的 localStorage 持久化
- 自动等待直播视频就绪，并排除脚本自身的 Canvas 输出视频，避免将输出重新选作输入源
- 支持视频源重新绑定与异常恢复
- 小窗画面不包含声音；声音仍由虎牙网页播放器输出

## 项目结构

HuyaMiniPlayer/
├── content.js
├── manifest.json
├── README.md
└── userscript/
    └── HuyaMiniPlayer.user.js

## 安装

### Chromium / Edge 扩展

1. 下载或克隆本仓库。
2. 打开 edge://extensions（Chrome 使用 chrome://extensions）。
3. 开启开发人员模式，选择“加载解压缩的扩展”。
4. 选择仓库根目录（包含 manifest.json 的目录）。
5. 打开虎牙直播间，使用页面右下角的小窗控制按钮。

### Tampermonkey 用户脚本

1. 安装 Tampermonkey。
2. 打开 Tampermonkey 管理面板，选择“添加新脚本”。
3. 将 userscript/HuyaMiniPlayer.user.js 的完整内容复制到编辑器并保存。
4. 刷新虎牙直播间。

## 使用说明

- 页面右下角的“小窗播放”按钮用于准备并启动画中画；小窗打开后可再次点击关闭。
- “设置”按钮打开弹幕设置面板。
- 透明度、字体大小和滚动速度自动保存；屏蔽词编辑后点击“保存屏蔽词”。
- 如果浏览器拒绝自动开启 PiP，按页面提示手动点击“小窗播放”。

## 版本

当前版本：0.3.0

本版本重点修复 Canvas 小窗输出视频被误选为输入源时可能形成的自我捕获反馈回路，并改进视频就绪等待和失败重试入口。扩展与用户脚本共享核心实现，启动去重逻辑按各自运行环境保留必要差异。

## 兼容性与限制

- 目标网站为虎牙直播及其子域名
- 需要支持 Canvas captureStream() 和视频画中画（PiP）的 Chromium 内核浏览器
- 小窗无声音，网页播放器继续负责音频输出
- 虎牙页面结构或浏览器行为变化仍可能影响兼容性