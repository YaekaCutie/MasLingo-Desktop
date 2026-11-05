# MasLingo Desktop 架构

桌面应用只加载本地工作台、截图、文档、音视频、历史和设置界面。浏览器内外的文字可以通过 Windows 全局热键捕获，应用的数据和设置由桌面进程独立管理。

- `desktop/main.cjs` 管理窗口、全局快捷键、剪贴板、截图、Windows OCR、本机引擎和音频权限。
- `desktop/bridge.cjs` 校验 IPC 窗口角色，串行写入设置及历史记录。Windows DPAPI 保护落盘内容，读取路径兼容旧版 Electron 加密配置。
- `desktop/media.cjs` 将用户选中的媒体文件流式发送给指定的识别引擎，并将带时间戳的转写进度发给音视频窗口。窗口可翻译并导出字幕，实时模式仅录制选中的音源。
- `backend/desktop_app.py` 复用文档和语音 API，并提供本地引擎健康检查。PyAV 解码本地媒体，Faster Whisper 逐段生成带时间戳的转写。
- `extension/` 保存原浏览器扩展源码和桌面复用的翻译来源、文档与设置界面。浏览器扩展可以从源码独立开发和构建。
