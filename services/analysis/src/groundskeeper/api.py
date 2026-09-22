from fastapi import FastAPI, HTTPException

from groundskeeper.analysis import analyze
from groundskeeper.models import AnalysisReport, AnalysisRequest

app = FastAPI(title="Groundskeeper analysis", version="0.1.0")


@app.get("/healthz")
def health():
    return {"status": "ok", "service": "analysis"}


@app.post("/v1/analyze", response_model=AnalysisReport)
def analyze_claims(request: AnalysisRequest):
    """Internal local API: supplied source is parsed, never executed or fetched."""
    try:
        return analyze(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
