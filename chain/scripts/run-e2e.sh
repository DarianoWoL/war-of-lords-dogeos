#!/bin/bash
# Stawia lokalny stos (Mongo :27119, hardhat node :8545 z chainId 6281971, serwer gry :3101), odpala e2e-local.js, sprzata.
export CHAIN_PRICE_SCALE=${CHAIN_PRICE_SCALE:-0.1}  # testy licza na cenie 0.1
export PATH="/e/Programy/NodeJS22:$PATH"
ROOT="/e/Gry/War of Lords"; cd "$ROOT/chain"
DB="$ROOT/runtime/mongodb-chaintest"; rm -rf "$DB"; mkdir -p "$DB"
"/e/Programy/MongoDB/bin/mongod.exe" --dbpath "$(cygpath -w "$DB")" --port 27119 --bind_ip 127.0.0.1 --logpath "$(cygpath -w "$ROOT/runtime/mongodb-chaintest.log")" >/dev/null 2>&1 &
MONGO_PID=$!
HH_CHAIN_ID=6281971 npx hardhat node --port 8545 >"$ROOT/runtime/hhnode.log" 2>&1 &
HH_PID=$!
sleep 8
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ADDR=$(HH_CHAIN_ID=6281971 CHAIN_ORACLE_KEY=$KEY npx hardhat run scripts/deploy.js --network localhost 2>&1 | tee "$ROOT/runtime/deploy.log" | grep -o 'WarOfLordsArena: 0x[0-9a-fA-F]*' | awk '{print $2}')
echo "kontrakt: $ADDR"
cd "$ROOT"
DOGEOS_CLIENT_ID=${DOGEOS_CLIENT_ID-} INVITE_TOKEN=${INVITE_TOKEN-} CHAIN_ORACLE_KEY=$KEY CHAIN_CONTRACT=$ADDR DOGEOS_RPC_URL=http://127.0.0.1:8545 MONGO_URI=mongodb://127.0.0.1:27119/wol_chain_e2e PORT=3101 HOST=127.0.0.1 node src/server.js >"$ROOT/runtime/wolserver.log" 2>&1 &
SRV_PID=$!
sleep 8
MONGO_URI=mongodb://127.0.0.1:27119/wol_chain_e2e CHAIN_ORACLE_KEY=$KEY CHAIN_CONTRACT=$ADDR DOGEOS_RPC_URL=http://127.0.0.1:8545 node chain/scripts/${1:-e2e-local.js}
CODE=$?
kill $SRV_PID $HH_PID $MONGO_PID 2>/dev/null; powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8545 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }" >/dev/null 2>&1
echo "--- ogon logu serwera ---"; tail -15 "$ROOT/runtime/wolserver.log"
exit $CODE
