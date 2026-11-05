# MasLingo Desktop

独立运行的 Windows 翻译工作台。解压 Windows x64 便携包后运行 `MasLingo Desktop.exe`。完整版随包提供文档引擎、语音运行时和 Whisper 模型，应用启动时自动启动本机引擎。翻译来源可在工作台或设置中选择。

| 场景 | 操作 |
| --- | --- |
| 手动翻译 | 输入文字，选择源语言和目标语言，点击「翻译」或按 `Ctrl+Enter`。支持互换语言、朗读、复制和收藏 |
| 屏幕翻译 | 在浏览器或其他应用中按 `Ctrl+Alt+S`，框选屏幕上的文字。按 Esc 取消 |
| 剪贴板翻译 | 复制原文后按 `Ctrl+Alt+T` |
| 图片翻译 | 在工作台打开 PNG 或 JPEG，先用 Windows OCR 提取文字，再翻译 |
| AI 查词 | 选中原文里的词或短语，点击「查词」查看词性、义项、例句和上下文义项。需要配置 AI 翻译来源 |
| 文档和字幕文件 | 打开「文档翻译」，预览原文与译文，导出双语或纯译文 |
| 本地音视频 | 打开「音视频翻译」，选择文件并开始转写。可翻译已有字幕并导出 SRT、WebVTT 或纯文本 |
| 实时语音 | 在「音视频翻译」点击「麦克风」或「系统声音」。可置顶字幕窗口，停止后导出已有结果 |
| 历史与收藏 | 搜索、复制、收藏或在工作台重新打开记录。可按需启用自动保存 |

## 格式与处理位置

- 音视频单文件上限 160 MB、60 分钟，支持常见的 WAV、MP3、M4A、FLAC、MP4、MKV、WebM 等格式。音轨由本机引擎识别。实时采集仅在用户开启时运行。
- 文档上限 15 MB，支持常见 Office、OpenDocument、PDF、EPUB、纯文本、Markdown、HTML、CSV、TSV、SRT 和 WebVTT。旧版 Office 与 RTF 的处理依赖 LibreOffice。扫描 PDF 识别取决于页面质量。
- 截图与图片识别采用 Windows 已安装的 OCR 语言。朗读使用 Windows 语音。截图框选使用鼠标所在显示器。
- 默认翻译来源为 Google 翻译。可配置 DeepSeek、自定义 OpenAI 兼容接口或本机 Ollama。语音识别和文档解析在默认本机引擎中运行，文字交给所选翻译来源。通过设置指定自建引擎后，文档和音频会发给该引擎。
- 历史记录默认关闭自动保存，手动收藏和已保存的记录以 Windows 用户级加密保存在本机。

## 从源码运行与打包

文本、截图、查词和收藏只需运行桌面应用。要构建独立的本机文档与语音引擎，请使用 Node.js 24+ 和 Python 3.12 x64。

```powershell
npm ci
.\setup-desktop-runtime.ps1
npm start
npm run package:win
```

可向 `setup-desktop-runtime.ps1` 提供 `-SpeechModelDir`，指向包含 `config.json`、`model.bin`、`tokenizer.json` 和 `vocabulary.txt` 的 Faster Whisper Base 模型目录，便携包即可同时携带模型。模型缺省时首次识别会下载。构建产物位于 `dist/MasLingo Desktop-win32-x64`，需分发整个目录。

本机引擎默认监听 `127.0.0.1:8001`。如有需要可在应用设置中指定其他引擎地址，或用 `MAS_DESKTOP_PYTHON` 指向已安装 `backend/requirements-desktop.txt` 的 Python 运行时。设置 `MAS_DESKTOP_NO_BACKEND=1` 可使用现有的外部引擎。

[架构说明](ARCHITECTURE.md) · [第三方声明](THIRD_PARTY_NOTICES.md)
