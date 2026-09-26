from fastapi import FastAPI

from app.api.v1.router import router

app = FastAPI(
    title="D&D Rules Engine",
    description="A rules engine for D&D 5e mechanics.",
    version="0.1.0",
)

app.include_router(router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
