#!/usr/bin/env python3
"""Disposable real-owner/fake-Pi integration service; never points at live sessions."""

import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HARNESS = """#!/usr/bin/env python3
import json, os, sys, time, uuid
from pathlib import Path
root = Path(os.environ['DELIVERY_FIXTURE'])
session = Path.cwd().name
rpc = '--mode' in sys.argv and sys.argv[sys.argv.index('--mode')+1] == 'rpc'
message = '!compact' if rpc else sys.argv[-1]
def event(kind):
    model = sys.argv[sys.argv.index('--model')+1] if '--model' in sys.argv else None
    record = {'kind':kind,'session':session,'message':message,'pid':os.getpid(),'model':model}
    fd=os.open(root/'events.jsonl',os.O_APPEND|os.O_CREAT|os.O_WRONLY,0o600)
    try: os.write(fd,(json.dumps(record)+'\\n').encode())
    finally: os.close(fd)
if rpc:
    request=json.loads(sys.stdin.readline())
    assert request['type']=='compact'
event('start')
gate=root/('compact.gate' if rpc else 'normal.gate')
if rpc or message.startswith('HOLD'):
    while gate.exists(): time.sleep(.02)
pi=Path('.pi/agent/session/fixture.jsonl')
pi.parent.mkdir(parents=True,exist_ok=True)
with pi.open('a') as out:
    out.write(json.dumps({'type':'compaction' if rpc else 'message','id':uuid.uuid4().hex,'message':{'role':'user','content':message}})+'\\n')
event('finish')
if rpc:
    print(json.dumps({'type':'response','command':'compact','success':True,'data':{'tokensBefore':1000,'estimatedTokensAfter':100,'summary':'Fixture compaction'}}),flush=True)
    for line in sys.stdin: pass
else:
    assert sys.argv[sys.argv.index('--mode')+1] == 'json'
    print(json.dumps({'type':'message_end','message':{'role':'assistant','stopReason':'stop','content':[{'type':'text','text':'Fixture '+message}]}}),flush=True)
    print(json.dumps({'type':'agent_settled','aborted':False}),flush=True)
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--port", type=int, default=11018)
    parser.add_argument("--hold-prior", choices=["session_a", "session_b", "session_c"])
    parser.add_argument("--paused", choices=["session_a", "session_b", "session_c"])
    args = parser.parse_args()
    repo = Path(args.repo).resolve()
    with tempfile.TemporaryDirectory(prefix="limilink-delivery-e2e-") as directory:
        root = Path(directory)
        sessions = root / "sessions"
        sessions.mkdir()
        for suffix in "abc":
            session = sessions / f"session_{suffix}"
            session.mkdir()
            (session / "chat_history.json").write_text("[]")
            pi = session / ".pi/agent/session"
            pi.mkdir(parents=True)
            (pi / "fixture.jsonl").write_text("{}\n")
        harness = root / "fixture-pi"
        harness.write_text(HARNESS)
        harness.chmod(0o700)
        config = root / "config.sxpb"
        config.write_text(
            "(agent_by_alias () (pi-a (harness pi) (model model-a)) "
            "(pi-b (harness pi) (model model-b)))\n"
            f'(pi_agent_exepath "{harness}")\n'
            f'(env_dict (DELIVERY_FIXTURE "{root}"))\n'
        )
        for name in ("normal.gate", "compact.gate"):
            (root / name).write_text("hold\n")
        os.environ.update(
            LIMILINK_CONFIG=str(config),
            LIMILINK_SESSIONS_DIR=str(sessions),
            OTEL_SDK_DISABLED="true",
        )
        sys.path.insert(0, str(repo / "src"))
        import main as application
        import uvicorn

        if args.paused:
            from delivery import write_operation

            directory = sessions / args.paused / ".web-requests"
            directory.mkdir()
            for number, state in ((1, "running"), (2, "queued")):
                rid = f"{number:032x}"
                write_operation(
                    directory / f"{rid}.json",
                    {
                        "version": 2,
                        "id": rid,
                        "session_id": args.paused,
                        "sequence": number,
                        "revision": 0,
                        "state": state,
                        "message": "uncertain before crash"
                        if number == 1
                        else "must never resume",
                        "execution_id": "prior-attempt" if number == 1 else None,
                        "outcome": None,
                    },
                    create=True,
                )
        prior = None

        @application.app.get("/__fixture/events")
        def events():
            path = root / "events.jsonl"
            return {
                "events": [json.loads(line) for line in path.read_text().splitlines()]
                if path.exists()
                else []
            }

        @application.app.post("/__fixture/release/{kind}")
        def release(kind: str):
            if kind == "prior" and prior is not None and prior.stdin is not None:
                prior.stdin.close()
                prior.wait(timeout=5)
                return {"released": kind}
            if kind not in ("normal", "compact"):
                raise application.HTTPException(400, "Unknown fixture gate")
            (root / f"{kind}.gate").unlink(missing_ok=True)
            return {"released": kind}

        # Production's final static mount precedes fixture routes added here.
        # Place only the disposable control routes before that catch-all mount.
        application.app.router.routes.sort(
            key=lambda route: (
                0 if str(getattr(route, "path", "")).startswith("/__fixture/") else 1
            )
        )
        with ExitStack() as cleanup:
            if args.hold_prior:
                code = """import sys
from pathlib import Path
from delivery import lock_file
from session_lease import session_lease
root, sid = Path(sys.argv[1]), sys.argv[2]
with session_lease(root, sid):
    fd = lock_file(root / ('.execution-' + sid))
    assert fd is not None
    print('owned', flush=True)
    sys.stdin.buffer.read(1)
"""
                prior = cleanup.enter_context(
                    subprocess.Popen(
                        [sys.executable, "-c", code, str(sessions), args.hold_prior],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        env={**os.environ, "PYTHONPATH": str(repo / "src")},
                    )
                )
                assert prior.stdin is not None and prior.stdout is not None
                cleanup.callback(prior.stdin.close)
                if prior.stdout.readline() != b"owned\n":
                    raise RuntimeError(
                        "Prior-writer fixture could not acquire ownership"
                    )
            print(f"Disposable fixture root: {root}", flush=True)
            uvicorn.run(
                application.app, host="127.0.0.1", port=args.port, log_level="warning"
            )


if __name__ == "__main__":
    main()
