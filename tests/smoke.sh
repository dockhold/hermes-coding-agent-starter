#!/usr/bin/env bash
# Smoke test for the hermes-coding-agent-starter image.
#
# Dockhold's runtime, as this test reproduces it: user 1001, every capability
# dropped, no privilege escalation, 1 GB of memory and no swap, App storage
# mounted at /data owned root:1001 with mode 2770, a fixed PORT, secrets and
# variables as environment variables.
#
# Two restrictions go further than Dockhold, and apply to the start-up checks
# only: no outbound network (proves the app downloads nothing to start) and a
# read-only root file system with a tmpfs /tmp (proves it writes nothing
# outside /data and /tmp). A real task run needs the network, because the
# agent must reach its model provider and GitHub, so no real task runs here.
# One task runs against fakes on the loopback address (a fake GitHub API, a
# local repository, a fake agent that misbehaves); the loop itself is tested
# end to end with fakes in tests/loop.test.mjs.
#
# Usage: tests/smoke.sh <image>
# Needs: docker, bash 4 or newer. Exits non-zero if any case fails.
# Prints one PASS or FAIL line per case, INFO lines for measurements, and the
# container log after a failure.
set -euo pipefail

IMAGE=${1:?usage: tests/smoke.sh <image>}
CURL_IMAGE=curlimages/curl:8.16.0
HELPER_IMAGE=alpine:3.24
RUN="agentsmoke-$$-$RANDOM"
NET="$RUN-net"
APP="$RUN-app"
CURL="$RUN-curl"
PORT=8080
URL="http://agent:$PORT"
BASE=$(mktemp -d "${TMPDIR:-/tmp}/agentsmoke.XXXXXX")
STORAGE_LINE="This app keeps its work on App storage. Turn on App storage in the Size tab; the app restarts on its own."
VARS="on this app's Variables tab and restart."

PASS_COUNT=0
FAIL_COUNT=0
HTTP_CODE=000
HTTP_BODY=""

pass() { echo "PASS  $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() {
  echo "FAIL  $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "----- container log ($APP) -----"
  docker logs "$APP" 2>&1 | tail -n 40 || true
  echo "-------------------------------"
}
report() { if [ "$2" = true ]; then pass "$1"; else fail "$1"; fi; }
info() { echo "INFO  $1"; }

cleanup() {
  docker rm -f "$APP" "$CURL" "$RUN-gh" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker run --rm -v "$BASE:/b" "$HELPER_IMAGE" sh -c 'rm -rf /b/* /b/.[!.]* 2>/dev/null; true' >/dev/null 2>&1 || true
  rmdir "$BASE" 2>/dev/null || true
}
trap cleanup EXIT

rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

# A fresh host dir shaped like the platform's App storage mount.
new_datadir() {
  local d
  d=$(mktemp -d "$BASE/data.XXXXXX")
  docker run --rm -v "$d:/data" "$HELPER_IMAGE" sh -c 'chown 0:1001 /data && chmod 2770 /data' >/dev/null
  echo "$d"
}

# start_app [docker run args...]: the fixed runtime shape, plus the two extra
# start-up restrictions (internal network, read-only root), plus whatever the
# case adds.
start_app() {
  docker rm -f "$APP" >/dev/null 2>&1 || true
  docker run -d --name "$APP" --network "$NET" --network-alias agent \
    --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges \
    --memory 1g --memory-swap 1g \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    -e "PORT=$PORT" "$@" "$IMAGE" >/dev/null 2>"$BASE/run.err" || { cat "$BASE/run.err"; return 1; }
}

app_running() { [ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" = true ]; }
app_logs() { docker logs "$APP" 2>&1 || true; }

wait_health() {
  local _
  for _ in $(seq 1 120); do
    app_running || return 1
    if docker exec "$CURL" curl -sf -m 3 -o /dev/null "$URL/health" 2>/dev/null; then return 0; fi
    sleep 0.25
  done
  return 1
}

# Prints the exit code once the container has exited, or "running".
wait_exit() {
  local _
  for _ in $(seq 1 80); do
    if ! app_running; then docker inspect -f '{{.State.ExitCode}}' "$APP"; return 0; fi
    sleep 0.25
  done
  echo running
}

# http METHOD PATH: sets HTTP_CODE and HTTP_BODY.
http() {
  local out
  if out=$(docker exec "$CURL" curl -s -m 10 -X "$1" -w $'\n%{http_code}' "$URL$2" 2>/dev/null); then
    HTTP_CODE=${out##*$'\n'}
    HTTP_BODY=${out%$'\n'*}
  else
    HTTP_CODE=000
    HTTP_BODY=""
  fi
}

# A refused start: the container must exit 1 with exactly the expected line.
expect_one_line_refusal() { # NAME EXPECTED_LINE [docker run args...]
  local name=$1 expected=$2
  shift 2
  start_app "$@"
  local code lines ok=true
  code=$(wait_exit)
  lines=$(app_logs | wc -l | tr -d ' ')
  [ "$code" = 1 ] || { ok=false; echo "  exit code: $code (want 1)"; }
  [ "$lines" = 1 ] || { ok=false; echo "  log lines: $lines (want 1)"; }
  [ "$(app_logs)" = "$expected" ] || { ok=false; echo "  log line differs: $(app_logs | head -n 1)"; }
  for v in "$KEY" "$GHT"; do
    if app_logs | grep -qF -- "$v"; then ok=false; echo "  the log contains a secret value"; fi
  done
  report "$name" $ok
}

# ---------------------------------------------------------------------------
echo "==== hermes-coding-agent-starter smoke test: $IMAGE"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$CURL" --network "$NET" --entrypoint sh "$CURL_IMAGE" -c 'sleep 100000' >/dev/null

KEY="sk-or-v1-smoke$(rand_hex 16)"
GHT="github_pat_smoke$(rand_hex 16)"
DHT="dh_smoke$(rand_hex 16)"
REPO="octo-org/website"
APPENV=(-e "AGENT_API_KEY=$KEY" -e "GITHUB_TOKEN=$GHT" -e "AGENT_REPO=$REPO" -e "AGENT_MODEL=test/model")
PINNED=$(sed -n 's/^ARG HERMES_REF=v\([0-9][0-9.]*\)$/\1/p' "$(dirname "$0")/../Dockerfile" | head -n 1)
info "pinned Hermes Agent release: ${PINNED:-unknown}"
info "image size: $(( $(docker image inspect "$IMAGE" --format '{{.Size}}') / 1048576 )) MiB (uncompressed)"

# ---------------------------------------------------------------------------
echo "==== Refusals"
D_RO=$(new_datadir)
D_REF=$(new_datadir)
expect_one_line_refusal "no App storage (DATA_DIR unset): one line, exit 1" "$STORAGE_LINE" "${APPENV[@]}"
expect_one_line_refusal "App storage mounted read-only: one line, exit 1" "$STORAGE_LINE" -e DATA_DIR=/data -v "$D_RO:/data:ro" "${APPENV[@]}"
expect_one_line_refusal "no model key: one line, exit 1" \
  "AGENT_API_KEY is missing or empty. Add it as a secret $VARS" \
  -e DATA_DIR=/data -v "$D_REF:/data" -e "GITHUB_TOKEN=$GHT" -e "AGENT_REPO=$REPO" -e AGENT_MODEL=test/model
expect_one_line_refusal "no GitHub token: one line, exit 1" \
  "GITHUB_TOKEN is missing or empty. Add it as a secret $VARS" \
  -e DATA_DIR=/data -v "$D_REF:/data" -e "AGENT_API_KEY=$KEY" -e "AGENT_REPO=$REPO" -e AGENT_MODEL=test/model
expect_one_line_refusal "AGENT_REPO not owner/name: one line, exit 1" \
  "AGENT_REPO must be a repository as owner/name, for example octo-org/website. Fix it $VARS" \
  -e DATA_DIR=/data -v "$D_REF:/data" "${APPENV[@]}" -e "AGENT_REPO=https://github.com/octo-org/website"
expect_one_line_refusal "AGENT_PROVIDER unknown: one line, exit 1" \
  "AGENT_PROVIDER must be a model provider Hermes signs in to with an API key, such as openrouter, anthropic, gemini or deepseek, or custom with AGENT_BASE_URL for any OpenAI-compatible endpoint. Fix it $VARS" \
  -e DATA_DIR=/data -v "$D_REF:/data" "${APPENV[@]}" -e AGENT_PROVIDER=nous
expect_one_line_refusal "AGENT_POLL_MINUTES 0: one line, exit 1" \
  "AGENT_POLL_MINUTES must be a whole number from 1 to 1440. Fix it $VARS" \
  -e DATA_DIR=/data -v "$D_REF:/data" "${APPENV[@]}" -e AGENT_POLL_MINUTES=0

# ---------------------------------------------------------------------------
echo "==== The pinned Hermes accepts the command line the app builds"
# The exact argument list, environment and config.yaml from agent/lib.mjs,
# with every optional part on (the Dockhold token). An unknown or renamed
# option makes Hermes's argument parser exit 2 at once; a valid list gets
# as far as calling the model provider, which this network never reaches.
argcheck=$(docker run --rm --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges \
  --network none --read-only --tmpfs /tmp --entrypoint node "$IMAGE" --input-type=module -e "
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import * as lib from '/app/agent/lib.mjs';
const providers = JSON.parse(fs.readFileSync('/app/agent/providers.json', 'utf8'));
const { config } = lib.parseConfig({ DATA_DIR: '/tmp', AGENT_API_KEY: 'sk-or-v1-argcheck00', GITHUB_TOKEN: 'github_pat_argcheck000000000000', AGENT_REPO: 'octo-org/website', AGENT_MODEL: 'test/model', DOCKHOLD_API_TOKEN: 'dh_argcheck00' }, providers);
fs.mkdirSync(config.hermesHome, { recursive: true });
fs.writeFileSync(config.hermesHome + '/config.yaml', lib.hermesConfigYaml(config));
const args = lib.buildHermesArgs(config);
const child = spawn('hermes', args, { cwd: '/tmp', env: lib.hermesEnv(process.env, config) });
let all = '';
child.stderr.on('data', (d) => { all += d; });
child.stdout.on('data', (d) => { all += d; });
child.stdin.end('hello');
const t = setTimeout(() => { child.kill('SIGKILL'); }, 90000);
child.on('exit', (code) => {
  clearTimeout(t);
  const bad = code === 2 || /unrecognized arguments|invalid choice|error: argument|configured yet/i.test(all);
  console.log(!bad ? 'ok ' + args.filter((a) => a.startsWith('-')).join(' ') : 'bad exit=' + code + ' ' + all.slice(-300).replace(/\\s+/g, ' '));
  process.exit(0);
});
" 2>&1 | tail -n 1 || true)
report "every option the app passes is accepted: ${argcheck#ok }" "$(case "$argcheck" in ok*) echo true ;; *) echo false ;; esac)"

# ---------------------------------------------------------------------------
echo "==== Nothing planted in the checkout is loaded or run"
# tests/foothold-check.mjs runs the real Hermes with the app's arguments,
# environment and config.yaml against a fake model API on the loopback
# address, in a checkout full of planted context files, a project plugin, a
# project .env and a project config with an MCP server and a hook. The
# control run drops --ignore-rules and installs the same plugin in Hermes's
# own home, and must see the planted context files and run the plugin, or
# the check proves nothing.
foothold() { # [--control]
  docker run --rm --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges \
    --network none --read-only --tmpfs /tmp --memory 1g --memory-swap 1g \
    -v "$(cd "$(dirname "$0")" && pwd)/foothold-check.mjs:/check/foothold-check.mjs:ro" \
    --entrypoint node "$IMAGE" /check/foothold-check.mjs "$@" 2>&1 | tail -n 1
}
FH=$(foothold)
FH_CONTROL=$(foothold --control)
info "foothold check: $FH"
info "foothold control: $FH_CONTROL"
ok=true
expect='{"code":0,"exit_code":0,"calls":3,"planted":[],"ran":[]}'
[ "$FH" = "$expect" ] || { ok=false; echo "  a planted file reached the model, or planted code ran"; }
case "$FH_CONTROL" in
  *'"exit_code":0'*PLANTED-HERMES-MD*PLANTED-SUBDIR-AGENTS-MD*ran-project-plugin*) ;;
  *) ok=false; echo "  control: without the protections the planted items were not seen, so the check proves nothing" ;;
esac
report "no planted context file reaches the model, no planted plugin, MCP server or hook runs; the control run sees them" $ok

# ---------------------------------------------------------------------------
echo "==== Start, no outbound network, read-only root"
D_MAIN=$(new_datadir)
start_app -e DATA_DIR=/data -v "$D_MAIN:/data" "${APPENV[@]}" -e "DOCKHOLD_API_TOKEN=$DHT"
report "starts: /health answers 200" "$(wait_health && echo true || echo false)"

http GET /health
report "/health body is {\"status\":\"ok\"}" "$([ "$HTTP_CODE" = 200 ] && [ "$HTTP_BODY" = '{"status":"ok"}' ] && echo true || echo false)"

http GET /
ok=true
[ "$HTTP_CODE" = 200 ] || { ok=false; echo "  GET / returned $HTTP_CODE"; }
printf '%s' "$HTTP_BODY" | grep -qF "$REPO" || { ok=false; echo "  the page does not name the repository"; }
for v in "$KEY" "$GHT" "$DHT" "${KEY:0:20}" "${GHT:0:20}"; do
  if printf '%s' "$HTTP_BODY" | grep -qF -- "$v"; then ok=false; echo "  the page shows a secret or part of one"; fi
done
report "/ shows the repository and no secret" $ok

http GET /nope
report "unknown path: 404" "$([ "$HTTP_CODE" = 404 ] && echo true || echo false)"
http POST /
report "POST /: 405" "$([ "$HTTP_CODE" = 405 ] && echo true || echo false)"
head_code=$(docker exec "$CURL" curl -s -m 10 -I -o /dev/null -w '%{http_code}' "$URL/health" 2>/dev/null || echo 000)
report "HEAD /health: 200" "$([ "$head_code" = 200 ] && echo true || echo false)"

ok=true
mode=$(docker exec --user 1001:1001 "$APP" stat -c '%a %u' /data/home 2>&1) || ok=false
# 2700 when the mount is setgid, as Dockhold's is: the folder keeps the group.
case "$mode" in "700 1001"|"2700 1001") ;; *) ok=false; echo "  /data/home: $mode" ;; esac
docker exec --user 1001:1001 "$APP" sh -c 'touch /data/home/.w && rm /data/home/.w' >/dev/null 2>&1 || { ok=false; echo "  /data/home is not writable"; }
report "HOME is /data/home, mode $mode (owner only), writable" $ok

ver=$(docker exec --user 1001:1001 -e HOME=/data/home -e HERMES_HOME=/data/home/.hermes "$APP" hermes --version 2>&1 | head -n 1 || true)
report "hermes --version runs as uid 1001 on the read-only root: $ver" \
  "$([ -n "$PINNED" ] && printf '%s' "$ver" | grep -qF "$PINNED" && echo true || echo false)"

report "process 1 is tini" "$([ "$(docker exec "$APP" cat /proc/1/comm)" = tini ] && echo true || echo false)"

# Both tini (process 1) and the program (its child) start with the app's
# environment. Neither may be readable by another process of user 1001.
ok=true
NODE_PID=$(docker exec "$APP" sh -c 'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = node ] && [ "$(cut -d" " -f4 $p/stat)" = 1 ] && echo ${p#/proc/}; done; true')
[ -n "$NODE_PID" ] || { ok=false; echo "  the program is not tini's child"; }
for pid in 1 $NODE_PID; do
  if docker exec --user 1001:1001 "$APP" sh -c "cat /proc/$pid/environ" 2>/dev/null | tr '\0' '\n' | grep -q GITHUB_TOKEN; then
    ok=false; echo "  another uid 1001 process read the environment of process $pid"
  fi
  [ "$(docker exec "$APP" stat -c %u "/proc/$pid/environ")" = 0 ] || { ok=false; echo "  /proc/$pid/environ is not hidden from uid 1001"; }
done
report "the environment (GITHUB_TOKEN) of tini and of the program is not readable by another uid 1001 process" $ok

ok=false
for _ in $(seq 1 120); do
  http GET /
  if printf '%s' "$HTTP_BODY" | grep -q 'could not reach the GitHub API'; then ok=true; break; fi
  sleep 0.25
done
app_running || { ok=false; echo "  the app exited"; }
app_logs | grep -q '^poll failed: could not reach the GitHub API' || { ok=false; echo "  no 'poll failed' log line"; }
report "no network: the first poll fails, the page shows the error, the app keeps running" $ok
report "Dockhold MCP server reported on in the start log" "$(app_logs | grep -q 'Dockhold MCP server on' && echo true || echo false)"

sleep 3
info "idle memory: $(docker stats --no-stream --format '{{.MemUsage}}' "$APP")"

t0=$(date +%s%N)
docker stop -t 30 "$APP" >/dev/null
t1=$(date +%s%N)
ms=$(( (t1 - t0) / 1000000 ))
code=$(docker inspect -f '{{.State.ExitCode}}' "$APP")
report "SIGTERM: exit code $code in $ms ms (want 0, under 10000)" "$([ "$code" = 0 ] && [ "$ms" -lt 10000 ] && echo true || echo false)"

ok=true
for v in "$KEY" "$GHT" "$DHT"; do
  if app_logs | grep -qF -- "$v"; then ok=false; echo "  the log contains a secret value"; fi
done
report "no secret value in the container log" $ok

# ---------------------------------------------------------------------------
echo "==== A process the agent leaves behind never sees the GitHub token"
# One task against fakes, with no network: a fake GitHub API (tests/fake-github.mjs)
# in a second container whose loopback address the app shares, a local
# repository as the remote, and a fake agent that detaches a scanner. The
# scanner keeps forking and reads every process's environment and command
# line, looking for the token, while the app fetches and pushes with it.
# The remote's pre-receive hook holds the push open for 2 seconds, so the
# git process that carries the token lives long enough to be seen; with the
# protections taken out of the image, the scanner does find the token.
# After the task: the scanner is gone, the token was never seen, and no
# zombie is left (tini reaps what the app kills).
TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
ADV=$(mktemp -d "$BASE/adv.XXXXXX")
mkdir -p "$ADV/bin" "$ADV/gh"
cat > "$ADV/bin/hermes" <<'AGENT'
#!/bin/sh
cat > /dev/null
setsid sh -c 'while :; do ( for p in /proc/[0-9]*; do tr "\0" "\n" < $p/environ 2>/dev/null | grep -E "GIT_CONFIG_VALUE|GITHUB_TOKEN" >> /data/stolen; tr "\0" " " < $p/cmdline 2>/dev/null | grep -iE "github_pat|basic " >> /data/stolen; done ) & sleep 0.05; done' > /dev/null 2>&1 < /dev/null &
echo $! > /data/scanner.pid
sleep 1
echo hello > hello.txt
echo '{"type":"result","session_id":"s","exit_code":0,"text":"Added hello.txt.","tokens":{"input":1,"output":1,"total":2},"duration_ms":1}'
AGENT
docker run --rm --user 0:0 -v "$ADV:/a" --entrypoint sh "$IMAGE" -c '
  set -e
  chmod 0755 /a /a/bin /a/bin/hermes
  chown 1001:1001 /a/gh
  git init -q --bare -b main /a/remote.git
  git init -q -b main /tmp/seed && cd /tmp/seed && echo seed > README.md && git add -A
  git -c user.name=t -c user.email=t@t commit -qm seed && git push -q /a/remote.git main
  printf "#!/bin/sh\nsleep 2\n" > /a/remote.git/hooks/pre-receive
  chmod 0755 /a/remote.git/hooks/pre-receive
  chown -R 1001:1001 /a/remote.git' >/dev/null
D_ADV=$(new_datadir)
docker rm -f "$APP" "$RUN-gh" >/dev/null 2>&1 || true
docker run -d --name "$RUN-gh" --network none --user 1001:1001 \
  -v "$TESTS_DIR:/tests:ro" -v "$ADV/gh:/gh" \
  --entrypoint node "$IMAGE" /tests/fake-github.mjs serve 4010 /gh/state.json >/dev/null
docker run -d --name "$APP" --network "container:$RUN-gh" \
  --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges \
  --memory 1g --memory-swap 1g --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  -e PORT=8080 -e DATA_DIR=/data -v "$D_ADV:/data" \
  -v "$ADV/bin:/fakebin:ro" -v "$ADV/remote.git:/remote.git" \
  -e PATH=/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "${APPENV[@]}" -e CODING_AGENT_TEST_GITHUB_API=http://127.0.0.1:4010 \
  -e CODING_AGENT_TEST_GIT_URL=file:///remote.git "$IMAGE" >/dev/null
ok=false
for _ in $(seq 1 120); do
  if app_logs | grep -q '^#1: pull request '; then ok=true; break; fi
  sleep 0.5
done
report "the task ran: fetch, agent, push and pull request" $ok
sleep 1
# Every process in the app, seen from a process started with docker exec
# (which is left out, as are its own children).
PROCS=$(docker exec "$APP" node -e '
const fs = require("fs");
const rows = [];
for (const n of fs.readdirSync("/proc")) {
  if (!/^[0-9]+$/.test(n) || Number(n) === process.pid) continue;
  try {
    const s = fs.readFileSync(`/proc/${n}/stat`, "utf8");
    const r = s.slice(s.lastIndexOf(")") + 2).split(" ");
    rows.push(`${n}:${s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"))}:${r[0]}`);
  } catch {}
}
console.log(rows.join(" "));' 2>&1)
info "processes after the task: $PROCS"
zombies=$(printf '%s' "$PROCS" | tr ' ' '\n' | grep -c ':Z$' || true)
others=$(printf '%s' "$PROCS" | tr ' ' '\n' | grep -vcE '^1:tini:|^[0-9]+:node:' || true)
report "the scanner is gone: only tini and the program are left ($others others)" "$([ "$others" = 0 ] && echo true || echo false)"
report "no zombie left ($zombies)" "$([ "$zombies" = 0 ] && echo true || echo false)"
# Control: the scanner ran and could read command lines (it records its own,
# which name what it looks for). Without this the 0 below proves nothing.
lines=$(docker exec "$APP" sh -c 'cat /data/stolen 2>/dev/null | wc -l' || echo 0)
report "control: the scanner ran and recorded $lines lines of its own" "$([ "${lines:-0}" -gt 0 ] && echo true || echo false)"
B64=$(printf 'x-access-token:%s' "$GHT" | base64 | tr -d '\n')
seen=$(docker exec "$APP" sh -c "cat /data/stolen 2>/dev/null | grep -cF -e '$GHT' -e '$B64'" || true)
report "the scanner saw the token, or its header, ${seen:-0} times (want 0)" "$([ "${seen:-0}" = 0 ] && echo true || echo false)"
t0=$(date +%s%N)
docker stop -t 30 "$APP" >/dev/null
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
code=$(docker inspect -f '{{.State.ExitCode}}' "$APP")
report "SIGTERM after a task: exit code $code in $ms ms (want 0, under 10000)" "$([ "$code" = 0 ] && [ "$ms" -lt 10000 ] && echo true || echo false)"

# ---------------------------------------------------------------------------
echo "==== Summary: $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
