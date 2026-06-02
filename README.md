# DeckSync

DeckSync 是一个本地学习工具，用来把 Gemini 或 ChatGPT 讲解记录和 PDF/PPT 页面同步到一起看。

它主要做三件事：

1. 把课程里的 PPT、PPTX 或 PDF 转成逐页截图。
2. 自动把每一页截图发给 Gemini 或 ChatGPT，让模型按你的提示词讲解。
3. 生成 Chrome 插件配置，让你在对话记录旁边打开同步 PDF 面板。

这个公开仓库只包含程序源码、插件源码和示例配置。你的课程文件、对话链接、日志、截图和本地配置都会留在你电脑上，不会被上传到 GitHub。

## 界面预览

下面的截图不包含真实课程文件或模型对话记录；缓存相关截图使用演示数据。

### 管理器主界面

![DeckSync 管理器主界面，展示课程来源、自动提问设置和扫描结果](docs/screenshots/manager-overview.png)

### 选择要生成的离线缓存

![生成离线缓存步骤，展示已缓存、待缓存和无对话的 Deck 选择状态](docs/screenshots/offline-cache-selection.png)

### 离线缓存阅读器

![离线缓存阅读器，左侧是本地模型全记录，右侧是同步 PDF 面板](docs/screenshots/offline-reader.png)

## 需要的环境

- Windows 10/11
- Node.js 20 或更新版本
- Google Chrome
- Python 3，并且命令行里能运行 `python`
- Poppler 命令行工具，至少需要 `pdftoppm` 和 `pdfinfo`
- Microsoft PowerPoint 或 LibreOffice，只在需要转换 PPT/PPTX 时使用；Windows 上默认优先用 PowerPoint，LibreOffice 作为开源兜底
- Gemini 路径需要一个可以正常登录 Gemini 的账号
- ChatGPT 路径需要一个可以正常登录 ChatGPT 网页端的账号，不需要 API Key

## 一键配置环境

推荐先运行环境配置脚本：

```powershell
.\scripts\setup-env.ps1
```

这个脚本会自动做这些事：

1. 检测 Node.js、Python、Poppler、PowerPoint、LibreOffice 和 Chrome。
2. 已经安装的环境会直接复用。
3. 缺少的环境会提示你是否用 `winget` 安装。
4. 自动写入 DeckSync 需要的环境变量。
5. 生成本地配置文件 `.decksync.local.ps1`。
6. 自动运行 `npm install` 安装项目依赖。

如果你想不再逐个确认，直接安装缺少的环境：

```powershell
.\scripts\setup-env.ps1 -InstallMissing
```

如果你只想检查，不安装也不写入环境变量：

```powershell
.\scripts\setup-env.ps1 -CheckOnly
```

脚本生成的 `.decksync.local.ps1` 只保存在你的电脑上，已经被 `.gitignore` 忽略，不会上传到 GitHub；旧版 `.gemsync.local.ps1` 仍会被 `start.ps1` 兼容读取。

如果别人从 GitHub 下载这个项目，先运行上面的 `setup-env.ps1` 就行。脚本会复用他们电脑上已有的 PowerPoint；如果没有 PowerPoint，也会尝试安装/使用 LibreOffice。两者都没有时，管理器仍然可以启动和处理 PDF，但准备 PPT/PPTX 截图时会提示安装其中一个转换器。

## 手动配置环境

如果你不想用上面的脚本，也可以手动安装依赖。

安装 Node 依赖：

```powershell
npm install
```

如果 `node`、`python`、`pdftoppm` 或 `pdfinfo` 没有加入 PATH，可以在启动前设置环境变量：

```powershell
$env:GEMSYNC_NODE = "C:\Path\To\node.exe"
$env:GEMSYNC_PYTHON = "C:\Path\To\python.exe"
$env:GEMSYNC_PDFTOPPM = "C:\Path\To\pdftoppm.exe"
$env:GEMSYNC_PDFINFO = "C:\Path\To\pdfinfo.exe"
$env:GEMSYNC_SOFFICE = "C:\Path\To\soffice.exe"
$env:GEMSYNC_CHROME = "C:\Path\To\chrome.exe"
```

PPT/PPTX 转 PDF 默认是 `auto`：先试 PowerPoint，再试 LibreOffice。也可以手动指定：

```powershell
$env:GEMSYNC_PPT_CONVERTER = "powerpoint"   # 或 "libreoffice" / "auto"
```

## 启动管理器

在仓库目录下运行：

```powershell
.\start.ps1
```

也可以运行：

```powershell
npm start
```

然后打开：

```text
http://127.0.0.1:5188
```

## 安装 Chrome 插件

1. 打开 `chrome://extensions`。
2. 打开右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择这个目录：

```text
<repo>\extension
```

加载或重新加载插件后，刷新 Gemini 页面。

## 基本使用流程

1. 启动 DeckSync。
2. 选择一门课所在的文件夹，里面可以放 PPT、PPTX 或 PDF。
3. 点击“扫描文件夹”。
4. 如果还没有截图，点击“准备截图”。
5. 在“提问路径”里选择 Gemini 或 ChatGPT。ChatGPT 可以在管理器里选择网页端已有的模型，并在一个下拉框里选择 `Thinking 进阶`、`Thinking 标准` 或 `Instant`。
6. 点击“打开模型标签页”，第一次使用时先在自动化 Chrome 里登录 Gemini 或 ChatGPT。
7. 点击“启动自动问”。
8. 等所选模型全部讲完后，点击“写入插件”。
9. 勾选要缓存的对话，点击“生成离线缓存”或“同步缓存”，把完整聊天、公式、代码和动态组件保存到本地。
10. 重新加载 Chrome 插件。
11. 打开 Gemini 页面，点击悬浮的 `PDF` 按钮，就可以在旁边看同步 PDF 面板。

“自动提问设置”里可以填写“对话开头预提示词”。这个提示词只会在每个新模型对话开头单独发送一次，用来说明后续回答风格；后面的每一页仍然按“重复发送的提示词”正常提问。如果不填写，流程和以前一样。

同一个设置区也可以选择“每次提问页数”：支持一次上传 1、2 或 3 页 PPT 截图。这个设置会同时写入自动提问进度、插件配置和离线缓存映射；例如一次问 2 页时，PDF 第 1-2 页默认对应同一条用户消息，第 3-4 页对应下一条。设置了预提示词时，第 1 组 PPT 仍然从预提示词后面的第一条图片消息开始。

ChatGPT 路径和 Gemini 一样走自动化 Chrome：程序会打开 ChatGPT 网页，复用网页登录态上传截图、发送提示词、选择网页端模型，并保存 ChatGPT 网页对话链接和本地 transcript，再写进离线阅读器。这里不需要也不会使用 OpenAI API Key。

管理器支持并行多开任务：可以让一个课程文件夹跑 Gemini，另一个课程文件夹跑 ChatGPT。不同文件夹和不同提问路径会使用各自的进度文件，例如 Gemini 使用 `gemini_progress.json`，ChatGPT 使用 `chatgpt_progress.json`，不会互相覆盖。默认情况下 Gemini 使用自动化 Chrome `9222` 端口，ChatGPT 使用单独的 `9223` 端口和单独登录配置，避免两个网页互相抢输入框。前端会按课程文件夹记住各自的提问路径和模型设置。

新生成的课程运行数据会统一放在：

```text
<课程目录>\DeckSync
```

其中截图默认在 `DeckSync\shots`，任务日志在 `DeckSync\logs`，自动化 Chrome 配置在 `DeckSync\profiles`。旧版生成的 `gemini_ppt_screenshots_full`、`chrome-gemini-automation-profile` 等目录仍然兼容读取；你也可以在管理器里点击“整理目录”，把旧结构收进新的 `DeckSync` 文件夹。

如果课程文件夹里后来又新增 PPT，重新扫描后会在“准备截图”步骤显示待截图课件；点击后只追加这些新课件，不会重做已经生成过截图的旧 Deck。子文件夹里的课件也会扫描；如果不同文件夹里有同名 PPT，会优先按完整路径判断，内部 PDF 会带上 deck 编号避免互相覆盖。Office 临时文件（例如 `~$course2.ppt`）会被忽略。

Gemini 自动提问会在新对话开始后把对话重命名为对应课件/deck 名。即使之前某次重命名失败，也不会被误记为成功；下次运行会继续尝试恢复命名。

PDF 面板和离线缓存面板默认按模型对话顺序同步页面；如果设置了预提示词，第 1 页默认从第 2 条用户图片消息开始。你点击“校准本页”后，这一页和当前对话位置会被写死为固定映射；重复页、漏问页或多出来的对话不会把已经校准过的页自动推到下一页。

## 离线缓存版

“生成离线缓存”会把每个 Deck 的聊天记录保存到插件目录：

```text
<repo>\extension\pdf-panel\subjects\<subject-id>\transcripts
```

如果 Gemini 回复里有动态演示组件，程序也会尽量保存成可交互的本地 HTML；ChatGPT 网页路径会保存回答文字、网页对话链接和本地截图映射：

```text
<repo>\extension\pdf-panel\subjects\<subject-id>\interactives
```

缓存版不会改写模型原回答。Gemini 路径保存的是 Gemini 页面里已经生成的文字、Markdown、LaTeX、代码块、表格和动态组件；ChatGPT 路径保存的是 ChatGPT 网页里已经生成的回答文本。
Gemini 生成缓存前，需要自动化 Chrome 的 `9222` 端口打开，并且这个 Chrome 配置里已经登录 Gemini。ChatGPT 路径的回答在自动问时已经生成 transcript，“同步缓存”会把 transcript 写进插件目录。
管理器页面里可以勾选要缓存的 Deck；已经生成过的缓存可以直接点“打开缓存”查看。
已经有本地缓存的 Deck 会显示“已缓存”并禁止重复勾选；如果选中的内容都已经缓存，管理器不会重写插件配置，也不会重新抓取 Gemini。

离线缓存页右侧的 PDF 章节切换只显示已经生成过本地 transcript 的章节。没有生成缓存的章节不会出现在离线阅读器的下拉框里，避免误以为已经缓存完成；切换章节时也会继续停留在离线缓存界面。

本地课程记录不会提交到 GitHub。`.gitignore` 默认忽略 `extension/pdf-panel/subjects.json`、`extension/pdf-panel/subjects/`、运行日志和课程截图目录；这些位置会保存你的 PDF、截图、对话链接和离线 transcript。

也可以直接用命令行生成缓存：

```powershell
node .\scripts\cache_gemini_subject.mjs `
  --workspace "D:\你的课程文件夹" `
  --subject-id "your-subject-id" `
  --extension-root ".\extension"
```

ChatGPT 路径的命令行自动问也走网页登录态。先确保自动化 Chrome 已经打开并登录 ChatGPT，然后运行：

```powershell
node .\scripts\chatgpt_ppt_one_by_one.mjs
```

通常不需要手动调用它；管理器会自动传入课程截图目录、提示词、模型和进度文件。


## 验证

改完结构或升级环境后，可以先跑完整验证：

```powershell
npm run verify
```

它会依次检查服务端语法、PowerShell 脚本语法、首装环境配置脚本、运行环境、自检项、Chrome 扩展静态资源、启动端口回退、真实 `start.ps1 -NoOpen` 启动和完整本地烟测。只想看环境是否齐全时，可以单独跑：

```powershell
npm run doctor
```

只想检查 Windows 启动和配置脚本有没有语法问题时，可以单独跑：

```powershell
npm run check:ps
```

只想验证一键配置脚本本身能正常探测环境、但不安装也不写入环境变量时，可以单独跑：

```powershell
npm run check:setup
```

只想跑临时课程全流程烟测时，可以单独跑：

```powershell
npm run smoke
```

烟测会使用临时课程目录启动 DeckSync，验证扫描、PDF 转截图、插件写入、命令桥、旧目录整理、页面加载，以及 Gemini/ChatGPT 自动问脚本的离线 dry-run 恢复能力；测试结束会清理临时文件，不会写入你的真实课程目录。

只想验证真实启动脚本和管理器页面是否能打开时，可以单独跑：

```powershell
npm run smoke:real-start
```

如果默认 `5188` 端口被占用，`server.mjs` 和 `start.ps1` 都会自动选择后续可用端口；Chrome 扩展也会在 `5188` 之后继续寻找正在运行的 DeckSync。脚本测试或只想启动服务不打开浏览器时，可以用：

```powershell
.\start.ps1 -NoOpen
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `GEMSYNC_MANAGER_PORT` | 管理器端口，默认是 `5188`。 |
| `GEMSYNC_MANAGER_PORT_FALLBACK` | 可选，`GEMSYNC_MANAGER_PORT` 写错时使用的回退起始端口，默认是 `5188`。 |
| `GEMSYNC_NODE` | 后台任务使用的 Node 程序，默认使用当前 Node 或 `node`。 |
| `GEMSYNC_PYTHON` | PPT 转截图辅助脚本使用的 Python，默认是 `python`。 |
| `GEMSYNC_PDFINFO` | `pdfinfo` 的路径，默认是 `pdfinfo`。 |
| `GEMSYNC_PDFTOPPM` | `pdftoppm` 的路径，默认是 `pdftoppm`。 |
| `GEMSYNC_SOFFICE` | LibreOffice `soffice.exe` 的路径；没有 PowerPoint 或指定 LibreOffice 转换时使用。 |
| `GEMSYNC_PPT_CONVERTER` | PPT/PPTX 转 PDF 方式，默认 `auto`，可设为 `powerpoint` 或 `libreoffice`。 |
| `GEMSYNC_CHROME` | Chrome 程序路径，默认会尝试找常见安装位置。 |
| `GEMSYNC_AUTOMATION_SCRIPTS` | 自动化脚本目录，默认是 `<repo>\scripts`。 |
| `GEMSYNC_DEFAULT_WORKSPACE` | 可选，默认课程文件夹；已配置时 `npm run doctor` 会检查路径是否存在且可写。 |
| `GEMSYNC_DEFAULT_PROVIDER` | 可选，默认提问路径，`gemini` 或 `chatgpt`。 |
| `GEMSYNC_DEFAULT_CHATGPT_MODEL` | 可选，ChatGPT 路径主模型，默认 `5.5`，可选 `5.5`、`5.4`、`5.3`、`5.2`、`o3`。 |
| `GEMSYNC_DEFAULT_CHATGPT_THINKING` | 可选，ChatGPT 思考模式，默认 `thinking`，可选 `thinking` 或 `instant`。 |
| `GEMSYNC_DEFAULT_CHATGPT_THINKING_EFFORT` | 可选，ChatGPT Thinking 强度，默认 `advanced`，可选 `advanced` 或 `standard`。 |
| `GEMSYNC_GEMINI_CHROME_PORT` | 可选，Gemini 自动化 Chrome 端口，默认 `9222`。 |
| `GEMSYNC_CHATGPT_CHROME_PORT` | 可选，ChatGPT 自动化 Chrome 端口，默认 `9223`。 |
| `CHATGPT_CHROME_DEBUG_URL` | 可选，ChatGPT 网页自动化连接地址，默认 `http://127.0.0.1:9223`。 |
| `CHATGPT_RESPONSE_TIMEOUT_MS` | 可选，等待 ChatGPT 单次回复完成的超时时间，默认 `900000`。 |
| `GEMSYNC_DEFAULT_PRE_PROMPT` | 可选，每个新模型对话开头单独发送一次的预提示词。 |
| `GEMSYNC_DEFAULT_PROMPT` | 可选，默认重复发送给模型的提示词。 |
| `GEMSYNC_DEFAULT_PAGES_PER_PROMPT` | 可选，默认每次发给模型的 PPT 页数，支持 `1`、`2`、`3`。 |

## Chrome 自动化说明

Gemini 和 ChatGPT 自动提问都需要连接 Chrome DevTools。Gemini 默认地址是：

```text
http://127.0.0.1:9222
```

ChatGPT 默认地址是：

```text
http://127.0.0.1:9223
```

启动自动问前，管理器会先检查是否已经有截图 Deck、对应自动化 Chrome DevTools 端口是否可用；不满足时会直接提示下一步该做什么，不会启动一个注定失败的长任务。管理器可以帮你打开自动化 Chrome 标签页，并会确认对应 DevTools 端口已经可用；如果 Chrome 路径写错，会在启动时直接报出清晰错误。如果你想手动启动 Chrome，可以使用：

```powershell
chrome.exe --remote-debugging-port=9223 --user-data-dir="%TEMP%\decksync-chatgpt" https://chatgpt.com/
```

第一次使用时，需要在这个 Chrome 配置里登录对应网页端账号。管理器里的“打开模型标签页”会按当前提问路径打开 Gemini 或 ChatGPT。

如果 ChatGPT 网页端提示额度用完、message cap、rate limit、需要升级，或“稍后再试”，DeckSync 会把当前页码和对话链接写入进度文件，标记为额度暂停后停止任务；下次额度恢复后重新点“启动 ChatGPT 自动问”会从未完成页继续，不会重发已经完成的页面。管理器会在流程提示里显示这是额度/限流暂停，而不是普通任务崩溃。

真实自动问之前，可以先跑一次网页登录态自检：

```powershell
npm run doctor:live
```

它不会发送提示词，也不会上传课件，只会检查 Gemini/ChatGPT 的自动化 Chrome 端口、当前标签页和输入框是否可用。如果只想检查其中一路，可以运行：

```powershell
npm run doctor:live -- --provider gemini
npm run doctor:live -- --provider chatgpt
```

如果某一路没有登录、标签页不对，或者页面还没加载出输入框，这个命令会用非 0 退出码结束，并在输出里写清楚要处理哪一步；这表示真实网页状态还没准备好，不代表本地项目安装坏了。

如果你只想在发布或巡检脚本里收集状态、不想因为网页未登录中断整个脚本，可以用软检查和 JSON 输出：

```powershell
npm run doctor:live -- --soft --json
npm run doctor:live -- --provider chatgpt --wait 20
npm run doctor:live -- --provider chatgpt --repair
```

`--wait` 会在页面刚打开、输入框还没加载出来时等待并重试；`--repair` 会在标签页不对、页面卡住或输入框不可用时，优先通过正在运行的 DeckSync 管理器重新打开对应模型页，再复查一次；输出里的 `action` 是下一步处理建议。

## 使用提醒

- Gemini 自动提问运行时，不要手动点击 Gemini 的发送按钮。
- 如果中途失败，可以重新运行，进度会保存在你选择的课程文件夹里。
- PDF/PPT 文件本身不会自动上传到 GitHub。只有当你启动自动问时，程序才会把页面截图发给所选模型。
