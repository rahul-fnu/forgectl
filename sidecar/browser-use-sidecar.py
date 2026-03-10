"""
browser-use sidecar HTTP server.

Wraps the browser-use Agent library behind a lightweight aiohttp server,
exposing /health, /task, and /shutdown endpoints.  The forgectl
BrowserUseSession adapter starts this script inside the container and
communicates with it over localhost.
"""

import argparse
import asyncio
import json
import logging
import os
import sys
import traceback
from pathlib import Path

from aiohttp import web

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("browser-use-sidecar")

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
runner: web.AppRunner | None = None
shutdown_event: asyncio.Event | None = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

async def handle_health(request: web.Request) -> web.Response:
    """GET /health -- readiness probe."""
    return web.json_response({"status": "ok"})


async def handle_task(request: web.Request) -> web.Response:
    """POST /task -- run a browser-use task."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response(
            {"status": "failed", "output": "", "error": "Invalid JSON body"},
            status=400,
        )

    task = body.get("task", "")
    provider = body.get("provider", "anthropic")
    model = body.get("model", "claude-sonnet-4-20250514")

    if not task:
        return web.json_response(
            {"status": "failed", "output": "", "error": "Missing 'task' field"},
            status=400,
        )

    try:
        llm = _create_llm(provider, model)

        from browser_use import Agent, BrowserConfig

        browser_config = BrowserConfig(headless=True)

        agent = Agent(
            task=task,
            llm=llm,
            browser_config=browser_config,
            generate_gif=False,
            save_conversation_path="/output/conversation.json",
        )

        result = await agent.run()

        # Extract final result text
        final_result = result.final_result() if hasattr(result, "final_result") else str(result)

        # Write report
        report_path = Path("/output/report.md")
        if not report_path.exists():
            report_path.write_text(f"# Browser-Use Task Report\n\n## Task\n{task}\n\n## Result\n{final_result}\n")

        # Write structured data
        action_history = []
        if hasattr(result, "action_results"):
            for action in result.action_results():
                action_history.append(str(action))
        data_path = Path("/output/data.json")
        data_path.write_text(json.dumps({"task": task, "actions": action_history, "result": final_result}, indent=2))

        return web.json_response({"status": "completed", "output": final_result, "error": ""})

    except Exception as exc:
        error_msg = f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
        logger.error("Task failed: %s", error_msg)
        return web.json_response({"status": "failed", "output": "", "error": error_msg})


async def handle_shutdown(request: web.Request) -> web.Response:
    """POST /shutdown -- graceful shutdown."""
    logger.info("Shutdown requested")
    resp = web.json_response({"status": "shutting_down"})
    if shutdown_event is not None:
        shutdown_event.set()
    return resp


# ---------------------------------------------------------------------------
# LLM factory
# ---------------------------------------------------------------------------

def _create_llm(provider: str, model: str):
    """Create a LangChain chat model for the given provider."""
    if provider == "openai":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(model=model)
    else:
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(model_name=model)


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------

async def start_server(port: int) -> None:
    """Start the aiohttp server and wait for shutdown signal."""
    global runner, shutdown_event  # noqa: PLW0603

    # Safety logging for containerised environments
    in_docker = os.environ.get("IN_DOCKER", "").lower() in ("true", "1", "yes")
    no_sandbox = os.environ.get("BROWSER_USE_CHROME_NO_SANDBOX", "").lower() in ("true", "1", "yes")
    if in_docker:
        logger.info("Running inside Docker container")
    if no_sandbox:
        logger.info("Chrome --no-sandbox mode enabled")

    app = web.Application()
    app.router.add_get("/health", handle_health)
    app.router.add_post("/task", handle_task)
    app.router.add_post("/shutdown", handle_shutdown)

    shutdown_event = asyncio.Event()

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logger.info("browser-use sidecar listening on port %d", port)

    # Block until shutdown is requested
    await shutdown_event.wait()
    logger.info("Shutting down...")
    await runner.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description="browser-use sidecar server")
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on (default: 8765)")
    args = parser.parse_args()

    asyncio.run(start_server(args.port))


if __name__ == "__main__":
    main()
