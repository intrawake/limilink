"""Opt-in stock-SDK cutover/rollback rehearsal; no providers or credentials.

PI_RELOCATE_PACKAGE=/absolute/pi-package python test/relocate_state_native_smoke.py
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from tool.relocate_state import relocate, sdk
from main import _add_activity_observer
from session_activity import activity_snapshot

package = Path(os.environ["PI_RELOCATE_PACKAGE"]).resolve()
repo = Path(__file__).resolve().parents[1]


def node(script, *args):
    return json.loads(
        subprocess.check_output(
            [
                "node",
                "--input-type=module",
                "-e",
                script,
                str(package),
                *map(str, args),
            ],
            text=True,
        )
    )


with tempfile.TemporaryDirectory(prefix="limilink-relocation-roundtrip-") as temporary:
    base = Path(temporary)
    old, new = base / "old", base / "new"
    old.mkdir()
    for name in (".delivery-owner", ".lease-session_a", ".execution-session_a"):
        (old / name).touch()
    session = old / "session_a"
    journals = session / ".pi/agent/session"
    journals.mkdir(parents=True)
    fixture = node(
        """
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const {SessionManager}=await import(pathToFileURL(require.resolve(process.argv[1])));
const s=SessionManager.create(process.argv[2],process.argv[3]);
s.appendMessage({role:'user',content:'Remember marker: tangerine.',timestamp:1});
s.appendMessage({role:'assistant',api:'fixture',provider:'fixture',model:'fixture',content:[{type:'text',text:'Remembered.'}],stopReason:'stop',timestamp:2,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
const answer=s.getEntries()[1].message,branch=s.getLeafId();
s.appendMessage({role:'user',content:'Discarded branch still belongs in the archive.',timestamp:3});
s.branch(branch);
const keep=s.appendMessage({role:'user',content:'Retained branch.',timestamp:4});
s.appendMessage({...answer,timestamp:5});
s.appendCompaction('Summary preserves tangerine.',keep,20);
s.appendCustomEntry('relocation-proof',{retained:'custom state'});
const decoy=SessionManager.create(process.argv[2],process.argv[3]);
decoy.appendMessage({role:'user',content:'Wrong older context.',timestamp:1});decoy.appendMessage(answer);
console.log(JSON.stringify({file:s.getSessionFile(),id:s.getSessionId(),count:s.buildSessionContext().messages.length,decoy:decoy.getSessionFile()}));
""",
        session,
        journals,
    )
    source = Path(fixture["file"])
    source_bytes = source.read_bytes()
    os.utime(fixture["decoy"], (source.stat().st_mtime - 5, source.stat().st_mtime - 5))
    sidecar = journals / "child-artifact/private.txt"
    sidecar.parent.mkdir()
    sidecar.write_text("retained sidecar")
    (old / "session_empty").mkdir()
    (old / "channel_sessions.json").write_text('{"42":"session_a"}')
    (session / "chat_history.json").write_text(
        '[{"role":"user","content":"visible history"}]'
    )
    (session / ".media").mkdir()
    (session / ".media/fixture").write_bytes(b"retained media")
    activity_script = """
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {SessionManager}=await import(pathToFileURL(require.resolve(process.argv[1])));
const {installActivityBridge}=await import(pathToFileURL(process.argv[2]));
const cwd=process.argv[3],env=JSON.parse(process.argv[4]),manager=SessionManager.open(env.LIMILINK_ACTIVITY_ROOT_FILE,cwd+'/.pi/agent/session');
const handlers=new Map(),bus=new Map();
const pi={on:(name,handler)=>handlers.set(name,handler),events:{on:(name,handler)=>{bus.set(name,handler);return()=>bus.delete(name);},emit:(name,data)=>bus.get(name)?.(data)}};
const ctx={cwd,sessionManager:manager,model:{id:'fixture'},isIdle:()=>true,getContextUsage:()=>undefined};
installActivityBridge(pi,{env,setInterval:()=>({unref(){}}),clearInterval(){},registerChildExtensions:()=>({dispose(){}})});
await handlers.get('session_start')({},ctx);
handlers.get('tool_execution_start')({toolCallId:'native-proof',toolName:'read'},ctx);
handlers.get('tool_execution_end')({toolCallId:'native-proof',toolName:'read',isError:false},ctx);
handlers.get('session_shutdown')({},ctx);
const snapshot=JSON.parse(readFileSync(cwd+'/.activity.json','utf8'));
if(snapshot.sessionTracking?.available!==true||!snapshot.events.some(row=>row.kind==='tool'))throw Error('Full bridge failed to record the host-pinned root');
console.log(readFileSync(cwd+'/.activity-sessions/.owner.json','utf8'));
"""

    def activity_owner(cwd):
        args, env = [], {"LIMILINK_ACTIVITY_CHILD_SESSIONS": "1"}
        _add_activity_observer(args, env, str(cwd))
        assert args[args.index("--session") + 1] == env["LIMILINK_ACTIVITY_ROOT_FILE"]
        result = node(
            activity_script, repo / "tool/activity-bridge.mjs", cwd, json.dumps(env)
        )
        assert activity_snapshot(cwd / ".activity.json", False)["available"] is True
        return result

    owner = activity_owner(session)
    inode = (old / ".lease-session_a").stat().st_ino
    before = {
        str(p.relative_to(old)): p.read_bytes() for p in old.rglob("*") if p.is_file()
    }
    assert relocate(old, new, package)["state"] == "planned"
    assert before == {
        str(p.relative_to(old)): p.read_bytes() for p in old.rglob("*") if p.is_file()
    }
    forward = relocate(old, new, package, apply=True, workers_finished=True)
    row = next(r for r in forward["sessions"] if "source" in r)
    assert (new / row["original_archive"]).read_bytes() == source_bytes
    archive = new / row["archive"]
    assert (
        archive / "previous-session/child-artifact/private.txt"
    ).read_text() == "retained sidecar"
    assert (new / ".lease-session_a").stat().st_ino == inode
    assert not (new / "session_a/.activity-sessions").exists()
    fresh = activity_owner(new / "session_a")
    assert fresh["scopeKey"] != owner["scopeKey"] and fresh["token"] != owner["token"]
    current = new / "session_a/.pi/agent/session" / row["fork_name"]
    after = node(
        """
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);const {SessionManager}=await import(pathToFileURL(require.resolve(process.argv[1])));
const s=SessionManager.open(process.argv[2]);
s.appendMessage({role:'user',content:'Post-cutover work must survive rollback.',timestamp:3});
console.log(JSON.stringify({count:s.buildSessionContext().messages.length,id:s.getSessionId()}));
""",
        current,
    )
    assert after == {"count": fixture["count"] + 1, "id": fixture["id"]}
    latest = current.read_bytes()
    reverse = relocate(new, old, package, apply=True, workers_finished=True)
    back = next(r for r in reverse["sessions"] if "source" in r)
    assert (old / back["original_archive"]).read_bytes() == latest
    assert (old / "session_a/.pi/agent/session" / back["fork_name"]).read_text().find(
        "Post-cutover work"
    ) >= 0
    assert (old / row["original_archive"]).read_bytes() == source_bytes
    assert (old / "session_a/chat_history.json").read_bytes() == before[
        "session_a/chat_history.json"
    ]
    assert (old / "session_a/.media/fixture").read_bytes() == b"retained media"
    assert (old / "channel_sessions.json").read_bytes() == before[
        "channel_sessions.json"
    ]
    bad = base / "bad-journal.jsonl"
    rows = [json.loads(line) for line in source_bytes.splitlines()]
    corruptions = [
        ("newline", source_bytes[:-1]),
        ("JSONL", source_bytes + b"{broken\n"),
    ]
    cycle = json.loads(json.dumps(rows))
    cycle[1]["parentId"] = cycle[1]["id"]
    corruptions.append(
        ("Cyclic", ("".join(json.dumps(row) + "\n" for row in cycle)).encode())
    )
    for expected, raw in corruptions:
        bad.write_bytes(raw)
        try:
            sdk(package, "inspect", [dict(source=str(bad), id=fixture["id"])])
        except RuntimeError as error:
            assert expected in str(error)
        else:
            raise AssertionError("Malformed source was accepted")
        assert bad.read_bytes() == raw
    print(
        json.dumps(
            {
                "passed": True,
                "uid": os.geteuid(),
                "stockSdk": forward["pi_version"],
                "dryRunUnchanged": True,
                "branchedCompactedContextAndNewestSelection": True,
                "malformedUnterminatedAndCyclicJournalsRefused": True,
                "originalSha256": hashlib.sha256(source_bytes).hexdigest(),
                "piUuidPreserved": True,
                "postMoveContextCount": after["count"],
                "rollbackUsesLatestContext": True,
                "activityFreshScope": True,
                "fullBridgeAndApiAvailableAfterMigration": True,
                "sidecarsAndApplicationStatePreserved": True,
                "providerCalls": 0,
            }
        )
    )
