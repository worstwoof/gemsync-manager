# GemSync Chrome 插件

这个插件会在 Gemini 页面上加入几个悬浮学习按钮，用来打开 PDF 面板、保存阅读位置和同步聊天记录。

## 按钮说明

- `PDF`：打开或关闭右侧 PDF 面板。
- `Restore`：回到之前保存的 Gemini 阅读位置。
- `Mark`：保存当前 Gemini 阅读位置。
- `Top`：手动向上加载更早的 Gemini 消息。
- `Stop`：停止正在进行的加载或查找动作。

## 插件读取的数据

PDF 面板会读取下面这些本地生成的配置：

```text
extension/pdf-panel/subjects.json
extension/pdf-panel/subjects/
```

这些文件由 GemSync Manager 生成，里面可能包含本地 PDF 路径和 Gemini 对话链接，所以默认不会上传到 Git。

## 安装方法

1. 打开 `chrome://extensions`。
2. 打开“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `extension` 文件夹。
5. 刷新 Gemini 页面。

## 生成 PDF 面板数据

先在 GemSync Manager 网页里完成课程扫描、Gemini 自动提问和截图准备。

等 Gemini 对话准备好后，点击“写入插件”，管理器会生成 PDF 面板需要的本地配置。
