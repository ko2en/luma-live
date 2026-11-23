#!/usr/bin/env bash
# 单主播保护回归测试：两个 host 会话抢同一个直播间
set -u
PORT=3999
KEY=testkey
BASE="http://127.0.0.1:$PORT"
TMP=$(mktemp -d)
cd "$(dirname "$0")/.." || exit 1

PORT=$PORT STREAM_KEY=$KEY node server.js >"$TMP/server.log" 2>&1 &
SRV=$!
sleep 2

hdr() { echo; echo "===== $* ====="; }

A="$TMP/a"
B="$TMP/b"

hdr "1) A 上线"
curl -sN --max-time 6 -c "$A.jar" -b "$A.jar" "$BASE/api/events?role=host&id=aaaaaaaa-1111&name=Luma&key=$KEY" >"$A.out" &
CA=$!
sleep 1.5
grep -c "event: welcome" "$A.out" | sed 's/^/A welcome 帧: /'

hdr "2) B 上线（应当接管，A 收到 host-taken 并断开）"
curl -sN --max-time 5 -c "$B.jar" -b "$B.jar" "$BASE/api/events?role=host&id=bbbbbbbb-2222&name=Luma&key=$KEY" >"$B.out" &
CB=$!
sleep 2
wait $CA 2>/dev/null
echo "A 收到 host-taken: $(grep -c 'event: host-taken' "$A.out")"
echo "A 帧尾: $(tail -c 120 "$A.out" | tr '\n' ' ')"
echo "B welcome 帧: $(grep -c 'event: welcome' "$B.out")"

hdr "3) host-status"
curl -s "$BASE/api/host-status?id=aaaaaaaa-1111"; echo
curl -s "$BASE/api/host-status?id=bbbbbbbb-2222"; echo

hdr "4) A 不带 takeover 重连（应当 403）"
curl -s -o "$TMP/a403.txt" -w "HTTP %{http_code}\n" -c "$A.jar" -b "$A.jar" \
  "$BASE/api/events?role=host&id=aaaaaaaa-1111&name=Luma&key=$KEY"
cat "$TMP/a403.txt"; echo

hdr "5) A 带 takeover=1 重连（应当接管，B 收到 host-taken）"
curl -sN --max-time 4 -c "$A.jar" -b "$A.jar" \
  "$BASE/api/events?role=host&id=aaaaaaaa-1111&name=Luma&key=$KEY&takeover=1" >"$TMP/a2.out" &
CA2=$!
sleep 2
wait $CB 2>/dev/null
wait $CA2 2>/dev/null
echo "A 重新拿到 welcome: $(grep -c 'event: welcome' "$TMP/a2.out")"
echo "B 收到 host-taken: $(grep -c 'event: host-taken' "$B.out")"
curl -s "$BASE/api/host-status?id=aaaaaaaa-1111"; echo

hdr "6) 新口令错的 host 仍然 401"
curl -s -o /dev/null -w "HTTP %{http_code}\n" -c "$TMP/c.jar" -b "$TMP/c.jar" \
  "$BASE/api/events?role=host&id=cccccccc-3333&name=Luma&key=wrong"

hdr "7) 同 id 重连（刷新页面）不会被误判"
curl -sN --max-time 3 -c "$A.jar" -b "$A.jar" \
  "$BASE/api/events?role=host&id=aaaaaaaa-1111&name=Luma&key=$KEY" >"$TMP/a3.out" &
sleep 1.5
echo "同 id 重连 welcome: $(grep -c 'event: welcome' "$TMP/a3.out")  host-taken: $(grep -c 'event: host-taken' "$TMP/a3.out")"

hdr "server.log 尾部"
tail -n 5 "$TMP/server.log"

kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
rm -rf "$TMP"
