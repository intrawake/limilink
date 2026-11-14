"""Opt-in stock-CLI proof with local scripted responses and network blocked.

PYTHONPATH=src PI_PROOF_NPM_ROOT=/absolute/node_modules python test/pi_output_native_smoke.py
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile

from pi_output import pi_json_reply


with tempfile.TemporaryDirectory(prefix="limilink-output-proof-") as temporary:
    root = Path(temporary)
    npm = Path(os.environ["PI_PROOF_NPM_ROOT"]).resolve()
    package = npm / "@earendil-works/pi-coding-agent"
    manifest = json.loads((package / "package.json").read_text())
    binary = manifest["bin"]
    cli = package / (binary if isinstance(binary, str) else binary["pi"])
    guard = root / "network-guard.mjs"
    guard.write_text(
        "import {Socket} from 'node:net';import {appendFileSync} from 'node:fs';"
        "const deny=()=>{appendFileSync("
        + json.dumps(str(root / "network-attempts"))
        + ", 'blocked\\n');throw Error('Network forbidden');};"
        "globalThis.fetch=deny;Socket.prototype.connect=deny;"
    )
    extension = root / "scripted.mjs"
    extension.write_text("""import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
export default function(pi){
 pi.on('agent_settled',()=>{pi.sendMessage({customType:'subagent-incremental-child-notify',content:'Late child notice',display:false},{triggerTurn:false});});
 pi.registerProvider('output-proof',{api:'output-proof',apiKey:'fixture-only',baseUrl:'http://127.0.0.1:1',
 models:[{id:'reply',name:'reply',reasoning:false,input:['text'],contextWindow:8192,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
 streamSimple(model){
  const stream=createAssistantMessageEventStream();
  const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[{type:'text',text:'Both children finished.'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;
 }});
}
""")
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(root),
        "TMPDIR": str(root),
        "PI_CODING_AGENT_DIR": str(root / "agent"),
        "NODE_OPTIONS": f"--import={guard}",
        "NO_COLOR": "1",
        "CI": "1",
    }
    outputs = {}
    for mode in ("text", "json"):
        command = [
            "node",
            str(cli),
            "--no-extensions",
            "--no-skills",
            "--no-tools",
            "--extension",
            str(extension),
            "--model",
            "output-proof/reply",
            "--session-dir",
            str(root / mode),
            "--mode",
            mode,
            "-p",
            "Fixture",
        ]
        result = subprocess.run(
            command, cwd=root, env=env, capture_output=True, timeout=30
        )
        assert result.returncode == 0, result.stderr.decode()
        outputs[mode] = result.stdout
    assert pi_json_reply(outputs["json"]) == "Both children finished."
    events = [json.loads(line) for line in outputs["json"].split(b"\n") if line]
    messages = [event["message"] for event in events if event["type"] == "message_end"]
    assert messages[-1]["customType"] == "subagent-incremental-child-notify"
    assert not (root / "network-attempts").exists()
    print(
        json.dumps(
            {
                "passed": True,
                "stockVersion": manifest["version"],
                "oldTextPrinterEmpty": not outputs["text"].strip(),
                "jsonReplyPreserved": True,
                "lateNotice": True,
                "realModelProviderCalls": 0,
                "networkAttempts": 0,
            }
        )
    )
