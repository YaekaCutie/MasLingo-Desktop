"""Loopback engine for desktop documents and speech."""
import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .document import router as document_router
from .speech import router as speech_router
from .translation.local_translator import translate_texts

app = FastAPI(title="MasLingo Desktop Engine")
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
app.include_router(document_router)
app.include_router(speech_router)


class TextRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=32)
    source_language: str = Field(default="auto", max_length=64)
    target_language: str = Field(default="zh-CN", max_length=64)
    mode: str = "free-translate"


@app.get("/health")
def health():
    return {"ok": True, "backend": "ready", "speech": os.getenv("MAS_ENABLE_SPEECH") == "1"}


@app.post("/api/translate-text")
async def translate(request: TextRequest):
    items = [item.strip() for item in request.texts if item.strip()]
    if not items or sum(map(len, items)) > 32000:
        raise HTTPException(400, "待翻译文本为空或过长")
    if request.mode not in {"none", "free-translate"}:
        raise HTTPException(400, "请在应用设置选择相应的 AI 翻译来源")
    try:
        result = items if request.mode == "none" else await run_in_threadpool(
            translate_texts, items, request.source_language, request.target_language,
        )
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error
    return {"ok": True, "items": [{"text": text, "translated": translation}
                                   for text, translation in zip(items, result)]}
