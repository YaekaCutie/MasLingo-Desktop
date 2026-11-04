# MasLingo Desktop

MasLingo 是 Windows 全局翻译工具。可从文本、剪贴板、屏幕选区、本地图片或文档开始翻译。Chrome／Edge 浏览器伴侣在你平时使用的浏览器中提供网页、漫画和视频翻译。

## 使用方式

| 场景 | 操作 |
| --- | --- |
| 电脑上的任何窗口 | 按 `Ctrl+Alt+S`，拖动选区。应用识别画面文字并显示原文与译文 |
| 可复制的文字 | 复制选中的文字，按 `Ctrl+Alt+T` |
| 手动输入 | 在工作台编辑原文并点击「翻译」 |
| 本地图片 | 点「打开图片」，选择 PNG 或 JPEG |
| 本地文档 | 点「文档翻译」。支持预览和下载双语或纯译文 |
| 浏览器内的网页、漫画和视频 | 点「浏览器伴侣」，按步骤在 Chrome 或 Edge 加载扩展。伴侣支持网页双语、悬停和划词、漫画覆盖、字幕预翻译与导出 |

屏幕框选使用鼠标所在显示器，按 Esc 取消。屏幕和图片 OCR 使用 Windows 已安装的识别语言，工作台可切换语言。识别在本机完成，只有待翻译的文字会发给所选翻译服务。初始翻译来源为 DeepSeek，请在「设置」填写密钥，或切换到可用的免密钥来源。

浏览器伴侣需要一次手动加载。伴侣和桌面应用分别保存翻译设置，可以连接同一个识别后端。网页译文与漫画修复层显示在原网页，当前查词结果与快捷设置可从伴侣弹窗打开独立的翻译窗口。

## Windows 便携版

解压整个文件夹，运行 `MasLingo Desktop.exe`。程序运行期间可从其他窗口调用全局快捷键。文本与截图识别无需 Python。浏览器漫画 OCR、文档处理和无字幕视频语音识别需要 MasLingo 后端。

## 从源码运行

在 Windows PowerShell 中执行。需要 Node.js 24+。

```powershell
npm ci
npm start
```

需要本机漫画 OCR 或文档处理时，安装 Python 3.12，再运行 `.\setup-local.ps1`。桌面应用会自动启动同一目录下的 `.venv` 后端，默认监听 `127.0.0.1:8001`。也可在设置里连接已有后端。通过 `MAS_DESKTOP_PYTHON` 可指定已有的 Python 运行时，通过 `MAS_DESKTOP_NO_BACKEND=1` 可只使用外部后端。

- 文档上限 15 MB，支持 Office、OpenDocument、PDF、EPUB、纯文本、Markdown、HTML、CSV / TSV 及 SRT / WebVTT。
- 扫描 PDF 需安装 `backend/requirements-document-ocr.txt` 中的依赖。旧版 Office 和 RTF 需要 LibreOffice。
- 浏览器视频语音识别需安装 `backend/requirements-speech.txt` 中的依赖。首次识别会下载 Whisper 模型。
- 漫画画面、完整文档和浏览器录音会发给配置的后端。Windows 桌面版使用系统加密保存本机设置和凭据。

## 打包

```powershell
npm run package:win
```

Windows x64 输出位于 `dist/MasLingo Desktop-win32-x64`。便携版包含浏览器伴侣和后端源码。若已有原 MasLingo 打包阶段生成的 `runtime/` 和 `models/`，可将 `MAS_DESKTOP_ENGINE_DIR` 指向两者所在目录，把运行时和模型一并打包。

[架构说明](ARCHITECTURE.md) · [第三方声明](THIRD_PARTY_NOTICES.md)
