# DeckSync Mac 版使用说明

这个文件夹是给 macOS 准备的干净版本。里面不包含你的个人课程缓存、日志、Chrome 配置、`.env` 或 `node_modules`。

## 第一次使用

1. 把整个 `DeckSync-mac` 文件夹复制到 Mac。
2. 如果 macOS 提示不能打开 `.command` 文件，打开终端进入这个文件夹后运行：

```bash
chmod +x setup-mac.command start.command scripts/setup-mac.sh
```

3. 双击 `setup-mac.command`，它会安装项目依赖并检查环境。
4. 双击 `start.command`，它会启动服务并自动打开网页。

## 需要安装的软件

建议用 Homebrew 安装：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node poppler
brew install --cask google-chrome libreoffice
```

必需项：

- Node.js 20 或更新版本：运行网页服务。
- Google Chrome：连接 Gemini / ChatGPT 网页端。
- Poppler：把 PDF 截成图片。

建议安装：

- LibreOffice：把 PPT / PPTX 转成 PDF 后再截图。

## 怎么启动

双击 `start.command`。启动后会自动打开：

```text
http://127.0.0.1:5188
```

如果 5188 被占用，程序会自动尝试后面的端口，启动脚本也会自动打开实际可用的页面。

## 怎么多开

在网页里点“多开实例”可以新开一个 DeckSync 页面。常见用法：

- 第一个页面选择文件夹 A，连接 Gemini。
- 第二个页面选择文件夹 B，连接 ChatGPT。
- 两个页面可以同时工作，但每个页面要用自己的课程文件夹。

Gemini 和 ChatGPT 可以在同一个 Chrome 里开两个网站；如果登录额度、网页状态或模型切换不同，按页面里的提示分别连接对应窗口。

## 文件路径怎么填

Mac 路径通常长这样：

```text
/Users/你的用户名/Documents/course-a
```

如果点“选择文件夹”没有弹出系统窗口，网页会让你手动粘贴路径。

## 数据在哪里

新的课程缓存会写到：

```text
extension/pdf-panel/subjects
```

这个 Mac 版交给别人之前，我已经把旧课程缓存清空了。
