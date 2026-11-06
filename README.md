# Huya Mini Player

虎牙直播 Canvas 画中画与弹幕叠加工具，提供两种安装形态：Chromium / Edge 扩展和 Tampermonkey 用户脚本。两种版本共享核心实现，适合不同使用习惯。

## 功能

- 将虎牙直播视频绘制到 Canvas，并通过 Canvas 捕获流输出到画中画（PiP）窗口。
- 从虎牙聊天列表提取消息，作为独立弹幕叠加到小窗画面。
- 弹幕透明度、字体大小、滚动速度和屏蔽词设置。
- 设置通过当前虎牙页面的 `localStorage` 持久化。
- 捕获稳定帧检查、视频源重新绑定与异常恢复。
- 小窗画面不包含声音；声音仍由虎牙网页播放器输出。

## 项目结构

```text
HuyaMiniPlayer/
├── content.js                 # 扩展内容脚本
├── manifest.json              # Chromium Manifest V3
├── README.md
└── userscript/
    └── HuyaMiniPlayer.user.js # Tampermonkey 用户脚本
```

## 方式一：Edge / Chromium 扩展

1. 下载或克隆本仓库。
2. 打开 `edge://extensions`（Chrome 使用 `chrome://extensions`）。
3. 开启开发人员模式，选择“加载解压缩的扩展”。
4. 选择仓库根目录（包含 `manifest.json` 的目录）。
5. 打开虎牙直播间，使用页面右下角的小窗控制按钮。

## 方式二：Tampermonkey 用户脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 Tampermonkey 管理面板，选择“添加新脚本”。
3. 将 `userscript/HuyaMiniPlayer.user.js` 的完整内容复制到编辑器并保存。
4. 刷新虎牙直播间。

## 使用说明

- 页面右下角的“小窗播放”按钮用于准备并启动画中画；小窗打开后可再次点击关闭。
- “设置”按钮打开弹幕设置面板。
- 透明度、字体大小和滚动速度自动保存；屏蔽词编辑后点击“保存屏蔽词”。
- 如果自动 PiP 被浏览器拒绝，按页面提示手动点击“小窗播放”。

## 版本

- 当前版本：`0.2.24`
- 扩展与用户脚本均从同一正式代码基线迁移；用户脚本保留独立安装文件。
- 当前发布内容不包含历史版本快照、临时补丁或开发诊断文件。

## 兼容性与限制

- 目标网站：`https://www.huya.com/` 及其子域名。
- 需要支持 Canvas `captureStream()` 和视频画中画的 Chromium 浏览器。
- 小窗无声音，网页播放器继续负责音频输出。
- 用户脚本在 Tampermonkey 环境中已完成初步实际运行验证；不同浏览器及虎牙页面更新仍可能影响兼容性。