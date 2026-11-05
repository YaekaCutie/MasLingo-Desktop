"""Optional, bounded local speech transcription for live video captions."""
import asyncio
import io
import json
import os
import tempfile
from functools import lru_cache

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

router = APIRouter()
MAX_BYTES = 2 * 1024 * 1024
MAX_SECONDS = 12
MAX_MEDIA_BYTES = 160 * 1024 * 1024
MAX_MEDIA_SECONDS = 60 * 60
SAMPLE_RATE = 16000
_slot = asyncio.Lock()


@lru_cache(maxsize=1)
def model():
    from faster_whisper import WhisperModel
    return WhisperModel(
        os.getenv("MAS_SPEECH_MODEL", "base"), device="cpu", compute_type="int8",
        cpu_threads=max(1, int(os.getenv("MAS_SPEECH_THREADS", "2"))),
        download_root=os.getenv("MAS_SPEECH_CACHE", ".hf/speech"),
    )


def decode(data):
    """Stop decoding at the duration bound, including malicious containers."""
    import av
    chunks = []
    total = 0
    try:
        with av.open(io.BytesIO(data)) as container:
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            for frame in container.decode(audio=0):
                if frame.samples / frame.sample_rate > MAX_SECONDS:
                    raise HTTPException(413, "音频片段不能超过 12 秒")
                for sample in resampler.resample(frame):
                    total += sample.samples
                    if total > MAX_SECONDS * 16000:
                        raise HTTPException(413, "音频片段不能超过 12 秒")
                    chunks.append(sample.to_ndarray().flatten())
            for sample in resampler.resample(None):
                total += sample.samples
                if total > MAX_SECONDS * 16000:
                    raise HTTPException(413, "音频片段不能超过 12 秒")
                chunks.append(sample.to_ndarray().flatten())
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(415, "无法读取音频片段") from error
    if not chunks:
        raise HTTPException(400, "音频为空")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def transcribe(data, language=None):
    return recognize_samples(decode(data), language)


def recognize_samples(samples, language=None):
    if np.max(np.abs(samples)) < 0.002:
        return {"text": "", "segments": [], "language": ""}
    recognizer = model()
    if language and language not in recognizer.supported_languages:
        raise HTTPException(422, "当前语音模型不支持选择的源语言")
    segments, info = recognizer.transcribe(
        samples, language=language, beam_size=1, vad_filter=True, condition_on_previous_text=False,
        vad_parameters={"min_silence_duration_ms": 350},
    )
    result = [{"start": s.start, "end": s.end, "text": s.text.strip()}
              for s in segments if s.text.strip() and s.no_speech_prob < 0.7]
    return {"text": " ".join(s["text"] for s in result), "segments": result, "language": info.language}


@router.post("/api/transcribe-audio")
async def transcribe_audio(
    audio: UploadFile = File(...), language: str | None = Form(None, pattern=r"^[a-z]{2,3}$")
):
    if os.getenv("MAS_ENABLE_SPEECH", "0") != "1":
        raise HTTPException(503, "语音识别未启用：安装 backend/requirements-speech.txt 并设置 MAS_ENABLE_SPEECH=1")
    data = await audio.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "音频片段不能超过 2 MB")
    if not data:
        raise HTTPException(400, "音频为空")
    # Do not accumulate a stale queue on slow CPUs or shared deployments.
    if _slot.locked():
        raise HTTPException(429, "语音识别繁忙，请稍后重试")
    async with _slot:
        try:
            return await run_in_threadpool(transcribe, data, language)
        except HTTPException:
            raise
        except ImportError as error:
            raise HTTPException(503, "请安装 backend/requirements-speech.txt 后重启后端") from error
        except Exception as error:
            raise HTTPException(503, "语音模型加载或识别失败，请检查模型缓存及后端日志") from error


def media_chunks(source):
    """Yield bounded 30-second mono chunks with their positions on the media timeline."""
    import av

    chunk_samples = 30 * SAMPLE_RATE
    offset = 0.0
    started = False
    total = used = 0
    buffer = np.empty(chunk_samples, dtype=np.int16)
    with av.open(source) as container:
        if not container.streams.audio:
            raise HTTPException(422, "此文件没有音轨")
        if container.duration and container.duration / av.time_base > MAX_MEDIA_SECONDS:
            raise HTTPException(413, "音视频时长不能超过 60 分钟")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)

        def samples():
            for frame in container.decode(audio=0):
                yield from resampler.resample(frame)
            yield from resampler.resample(None)

        for frame in samples():
            if not started:
                offset = max(0.0, frame.time or 0.0)
                started = True
            data = frame.to_ndarray().reshape(-1)
            total += data.size
            if offset + total / SAMPLE_RATE > MAX_MEDIA_SECONDS:
                raise HTTPException(413, "音视频时长不能超过 60 分钟")
            while data.size:
                count = min(chunk_samples - used, data.size)
                buffer[used:used + count] = data[:count]
                used += count
                data = data[count:]
                if used == chunk_samples:
                    yield offset, buffer.astype(np.float32) / 32768.0
                    offset += chunk_samples / SAMPLE_RATE
                    total -= chunk_samples
                    used = 0
        if used:
            yield offset, buffer[:used].astype(np.float32) / 32768.0
        elif not offset:
            raise HTTPException(400, "音频为空")


@router.post("/api/transcribe-file")
async def transcribe_file(
    audio: UploadFile = File(...), language: str | None = Form(None, pattern=r"^[a-z]{2,3}$")
):
    if os.getenv("MAS_ENABLE_SPEECH", "0") != "1":
        raise HTTPException(503, "语音识别未启用，请在本机启动 MasLingo 桌面引擎")
    if audio.size is not None and audio.size > MAX_MEDIA_BYTES:
        raise HTTPException(413, "文件不能超过 160 MB")
    if _slot.locked():
        raise HTTPException(429, "语音识别繁忙，请稍后重试")
    await _slot.acquire()
    source = None
    released = False

    def close():
        nonlocal released
        if released:
            return
        released = True
        if source is not None:
            source.close()
        _slot.release()

    try:
        source = tempfile.TemporaryFile()
        size = 0
        while data := await audio.read(1024 * 1024):
            size += len(data)
            if size > MAX_MEDIA_BYTES:
                raise HTTPException(413, "文件不能超过 160 MB")
            await run_in_threadpool(source.write, data)
        if not size:
            raise HTTPException(400, "文件为空")
        source.seek(0)
    except BaseException:
        close()
        raise

    def line(value):
        return json.dumps(value, ensure_ascii=False) + "\n"

    async def stream():
        chunks = media_chunks(source)
        try:
            while (chunk := await run_in_threadpool(next, chunks, None)) is not None:
                offset, samples = chunk
                recognized = await run_in_threadpool(recognize_samples, samples, language)
                segments = [{"start": round(offset + item["start"], 3), "end": round(offset + item["end"], 3),
                             "text": item["text"]} for item in recognized["segments"]]
                yield line({"segments": segments, "processed": round(offset + len(samples) / SAMPLE_RATE, 2),
                            "language": recognized["language"]})
            yield line({"done": True})
        except HTTPException as error:
            yield line({"error": str(error.detail)})
        except ImportError:
            yield line({"error": "缺少语音识别运行时"})
        except Exception:
            yield line({"error": "无法读取音轨或加载语音模型，请检查文件及后端日志"})
        finally:
            chunks.close()
            close()

    return StreamingResponse(stream(), media_type="application/x-ndjson", background=BackgroundTask(close))
