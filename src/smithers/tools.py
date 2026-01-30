"""Tool registry and built-in tool implementations."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, TypeVar, overload

from pydantic import BaseModel, create_model

from smithers.errors import ToolError

F = TypeVar("F", bound=Callable[..., Any])


@dataclass
class ToolSpec:
    """Definition of an executable tool."""

    name: str
    description: str
    input_model: type[BaseModel]
    handler: Callable[..., Awaitable[Any]]

    def schema(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_model.model_json_schema(),
        }

    async def invoke(self, payload: dict[str, Any]) -> Any:
        try:
            validated = self.input_model.model_validate(payload)
            data = validated.model_dump()
            return await self.handler(**data)
        except Exception as exc:
            raise ToolError(self.name, str(exc)) from exc


_tool_registry: dict[str, ToolSpec] = {}


@overload
def Tool(fn: F) -> F: ...


@overload
def Tool(
    fn: None = None,
    *,
    name: str | None = None,
    description: str | None = None,
) -> Callable[[F], F]: ...


def Tool(
    fn: F | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
) -> F | Callable[[F], F]:
    """Decorator to register a function as a Smithers tool."""

    def decorator(func: F) -> F:
        tool_name = name or func.__name__
        tool_description = description or (func.__doc__ or "").strip() or tool_name
        input_model = _build_input_model(tool_name, func)
        handler = _ensure_async(func)
        _tool_registry[tool_name] = ToolSpec(
            name=tool_name,
            description=tool_description,
            input_model=input_model,
            handler=handler,
        )
        return func

    if fn is not None:
        return decorator(fn)
    return decorator


def get_tool(name: str) -> ToolSpec | None:
    """Return a tool spec by name."""
    return _tool_registry.get(name)


def get_all_tools() -> dict[str, ToolSpec]:
    """Return all registered tools."""
    return dict(_tool_registry)


def _ensure_async(func: Callable[..., Any]) -> Callable[..., Awaitable[Any]]:
    if inspect.iscoroutinefunction(func):
        return func

    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(func, *args, **kwargs)

    return wrapper


def _build_input_model(name: str, func: Callable[..., Any]) -> type[BaseModel]:
    sig = inspect.signature(func)
    # Build field definitions for create_model
    # Each field is (annotation, default) or just annotation if required
    field_definitions: dict[str, Any] = {}
    for param in sig.parameters.values():
        annotation = param.annotation if param.annotation is not inspect.Parameter.empty else Any
        if param.default is inspect.Parameter.empty:
            # Required field: just the annotation
            field_definitions[param.name] = (annotation, ...)
        else:
            # Optional field: (annotation, default)
            field_definitions[param.name] = (annotation, param.default)
    return create_model(f"{name}Input", **field_definitions)  # type: ignore[call-overload]


@Tool
async def Read(path: str, encoding: str | None = None) -> dict[str, Any]:
    """Read file contents."""
    file_path = Path(path)
    if not file_path.exists():
        raise FileNotFoundError(f"No such file: {path}")
    content = file_path.read_text(encoding=encoding or "utf-8")
    return {"path": str(file_path), "content": content}


@Tool
async def Edit(path: str, content: str, encoding: str | None = None) -> dict[str, Any]:
    """Overwrite a file with new content."""
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(content, encoding=encoding or "utf-8")
    return {"path": str(file_path), "written": len(content)}


@Tool
async def Glob(pattern: str, root: str = ".") -> dict[str, Any]:
    """Find files by glob pattern."""
    search_root = Path(root)
    matches = [str(p) for p in search_root.glob(pattern)]
    return {"matches": matches}


@Tool
async def Grep(
    pattern: str,
    path: str = ".",
    *,
    regex: bool = True,
    max_matches: int = 1000,
) -> dict[str, Any]:
    """Search file contents for a pattern."""
    base = Path(path)
    files = [base] if base.is_file() else list(base.rglob("*"))
    compiled = re.compile(pattern) if regex else None
    matches: list[dict[str, Any]] = []

    for file_path in files:
        if len(matches) >= max_matches or not file_path.is_file():
            continue
        try:
            content = file_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for idx, line in enumerate(content.splitlines(), start=1):
            found = compiled.search(line) if compiled else (pattern in line)
            if found:
                matches.append(
                    {
                        "path": str(file_path),
                        "line": line.strip(),
                        "line_number": idx,
                    }
                )
                if len(matches) >= max_matches:
                    break

    return {"matches": matches}


@Tool
async def Bash(command: str, cwd: str | None = None) -> dict[str, Any]:
    """Execute a shell command."""
    result = subprocess.run(
        command,
        shell=True,
        cwd=cwd or os.getcwd(),
        capture_output=True,
        text=True,
    )
    return {
        "command": command,
        "exit_code": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


@Tool(name="web_search")
async def web_search(query: str, max_results: int = 5) -> dict[str, Any]:
    """Search the web using DuckDuckGo Instant Answer API."""
    params = urllib.parse.urlencode({"q": query, "format": "json", "no_redirect": 1, "no_html": 1})
    url = f"https://api.duckduckgo.com/?{params}"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise ToolError("web_search", f"Web search failed: {exc}") from exc

    results: list[dict[str, Any]] = []
    if payload.get("AbstractText"):
        results.append(
            {
                "title": payload.get("Heading"),
                "snippet": payload.get("AbstractText"),
                "url": payload.get("AbstractURL"),
            }
        )
    for topic in payload.get("RelatedTopics", []):
        if isinstance(topic, dict) and "Text" in topic:
            results.append(
                {
                    "title": topic.get("Text"),
                    "snippet": topic.get("Text"),
                    "url": topic.get("FirstURL"),
                }
            )
        if len(results) >= max_results:
            break

    return {"results": results[:max_results]}


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self._parts.append(text)

    def text(self) -> str:
        return " ".join(self._parts)


@Tool(name="read_web_page")
async def read_web_page(url: str, max_chars: int = 20000) -> dict[str, Any]:
    """Fetch and read a URL."""
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            content_type = response.headers.get("Content-Type", "")
            raw = response.read().decode("utf-8", errors="ignore")
    except Exception as exc:
        raise ToolError("read_web_page", f"Failed to fetch URL: {exc}") from exc

    text = raw
    if "html" in content_type.lower():
        parser = _HTMLTextExtractor()
        parser.feed(raw)
        text = parser.text()

    if len(text) > max_chars:
        text = text[:max_chars]

    return {"url": url, "content": text}
