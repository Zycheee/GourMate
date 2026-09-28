"""Development runner with reload excludes.

``uvicorn --reload`` watches the whole ``backend/`` tree. Model weights written
into ``data/`` would restart the server mid-session and drop the WebSocket — so
that path is excluded here.

Usage (from ``backend/``):

    .venv\\Scripts\\python.exe run.py
"""

from __future__ import annotations

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8080,
        reload=True,
        reload_excludes=[
            "data/*",
            "*.wav",
            "*.log",
        ],
    )
