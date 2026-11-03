"""Capture zeta-images.json from a real zeta server (not run in CI).

Usage, from a zeta checkout: .venv/bin/python <this file> <out.json>
A real ZetaServer runs one turn with zeta's scripted test backend: the model calls the real `read` tool on a real
PNG (approved, as a user would), so `tool_end` is exactly what `zeta serve` sends. Then `session_history` for that session, and zeta's own
serializers for the two shapes a scripted turn cannot produce: an assistant message image (ImageContent.to_dict)
and an MCP tool image with caption and size (ToolResult.from_dict validates it as zeta does, then to_dict).
"""

import asyncio
import base64
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

sys.path.insert(0, ".")
from tests.support.scripted_provider import ScriptedFakeBackend, parse_fake_script  # noqa: E402
from zeta.protocol.types import ImageContent, Message, MessageRole, TextContent, ToolResult, flatten_tool_content  # noqa: E402
from zeta.server import ZetaServer  # noqa: E402

SCRIPT = {
    "version": 1,
    "rules": [{"responses": [
        {"steps": [{"type": "tool_call", "name": "read", "arguments": {"path": "chart.png"}}]},
        {"steps": [{"type": "text", "text": "Read the chart."}]},
    ]}],
}


def png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (215, 153, 33)).save(out, format="PNG")
    return out.getvalue()


async def rpc(reader, writer, request_id, method, params):
    writer.write((json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n").encode())
    await writer.drain()
    while True:
        frame = json.loads(await asyncio.wait_for(reader.readline(), 10))
        if frame.get("id") == request_id:
            if "error" in frame:
                raise RuntimeError(f"{method}: {frame['error']}")
            return frame["result"]


async def event(reader, name):
    while True:
        frame = json.loads(await asyncio.wait_for(reader.readline(), 10))
        if frame.get("params", {}).get("event") == name:
            return frame["params"]


async def capture(tmp: Path) -> dict:
    (tmp / "chart.png").write_bytes(png(4, 3))
    script = parse_fake_script(SCRIPT)
    server = ZetaServer(
        home=tmp / "home", cwd=tmp, socket_path=Path("/tmp") / f"zeta-fulcrum-{tmp.name}.sock", provider="codex",
        backend_factory=lambda _p, model, _h: (ScriptedFakeBackend(script, model=model or "gpt-5.6-luna"), model or "gpt-5.6-luna"),
    )
    await server.start()
    reader, writer = await asyncio.open_unix_connection(str(server.socket_path))
    try:
        await rpc(reader, writer, 1, "hello", {"protocol_version": "1.2"})
        session = await rpc(reader, writer, 2, "new_session", {"provider": "codex"})
        await rpc(reader, writer, 3, "send", {"text": "read the chart"})
        # The temporary directory is not a git project, so zeta asks before the read.
        approval = await event(reader, "approval_request")
        await rpc(reader, writer, 5, "approve", {"request_id": approval["request_id"]})
        tool_end = await event(reader, "tool_end")
        await event(reader, "turn_end")
        history = await rpc(reader, writer, 4, "session_history", {"session_id": session["session"]["session_id"]})
    finally:
        writer.close()
        await server.close()
    image = base64.b64encode(png(640, 480)).decode("ascii")
    blocks = [{"type": "image", "data": image, "mimeType": "image/png", "caption": "revenue by quarter", "width": 640, "height": 480, "size": len(base64.b64decode(image))}]
    # As zeta's agent loop builds it (agent/tool_results.py): content is the flattened blocks.
    mcp = ToolResult.from_dict({"tool_call_id": "call_mcp", "content": flatten_tool_content(blocks), "is_error": False, "content_blocks": blocks}).to_dict()
    message = Message(MessageRole.ASSISTANT, [TextContent("the chart:"), ImageContent(image, "image/png", path="/work/out/chart.png", size=len(base64.b64decode(image)))]).to_dict()
    return {"tool_end": tool_end, "history": history, "mcp_tool_result": mcp, "assistant_message": message}


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        result = asyncio.run(capture(Path(tmp)))
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    result["source"] = f"zeta {commit}, captured by packages/zeta/test/fixtures/capture-zeta-images.py"
    Path(sys.argv[1]).write_text(json.dumps(result, indent=1) + "\n")
