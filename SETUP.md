# Setup

This is a guide to setting up a Polytone connection between two chains.

1. Set up
   [Hermes](https://hermes.informal.systems/tutorials/production/setup-hermes.html)
   for new chain by adding chain to config.toml

```toml
[[chains]]
id = "<CHAIN_ID>"
type = "CosmosSdk"
rpc_addr = "<RPC>"
websocket_addr = "<WEBSOCKET>"
grpc_addr = "<GRPC>"
rpc_timeout = "10s"
batch_delay = "500ms"
trusted_node = false
account_prefix = "<BECH32_ADDRESS_PREFIX>"
key_name = "key"
key_store_type = "Test"
store_prefix = "ibc"
default_gas = 100000
max_gas = 4000000
gas_multiplier = 1.3
max_msg_num = 30
max_tx_size = 180000
max_grpc_decoding_size = 33554432
clock_drift = "5s"
max_block_time = "30s"
ccv_consumer_chain = false
memo_prefix = ""
sequential_batch_tx = false
gas_price = { price = 0.1, denom = "<NATIVE_DENOM>" }
trust_threshold = { numerator = "1", denominator = "3" }
address_type = { derivation = "cosmos" }

[chains.packet_filter]
policy = "allow"
list = [
#    ["*", "channel-201"]
]
```

2. Add key to new chain

```bash
# Add key to new chain
hermes keys add --key-name key --chain <chain_id> --mnemonic-file ./mnemonic
```

3. Fund accounts on both chains

4. Upload contracts to new chain

```bash
for f in ./artifacts/*.wasm
do
  tx=$(BINARY tx wasm store $f --from ADDRESS --gas-prices 0.1DENOM --gas auto --gas-adjustment 2 --yes --output json | jq -r '.txhash')
  echo "$(basename $f) $tx"
  sleep 12
  code_id=$(BINARY query tx $tx --output json | jq -r '.logs[0].events[1].attributes[1].value')
  echo "$(basename $f) $code_id"
done
```

5. Deploy contracts on both chains

```bash
# REPLACE BELOW:
# - SRC_BINARY
# - DEST_BINARY

SRC_NOTE_CODE_ID=
SRC_LISTENER_CODE_ID=
SRC_ADDRESS=
SRC_GAS_PRICES=
SRC_CHAIN_ID=

DEST_VOICE_CODE_ID=
DEST_PROXY_CODE_ID=
DEST_ADDRESS=
DEST_GAS_PRICES=
DEST_CHAIN_ID=

# Source chain
echo "\n$SRC_CHAIN_ID\n"
SRC_BLOCK_MAX_GAS=$(SRC_BINARY query params subspace baseapp BlockParams --output json | jq -r '.value' | jq -r '.max_gas')

## Note
NOTE_TX=$(SRC_BINARY tx wasm init $SRC_NOTE_CODE_ID "{\"block_max_gas\":\"$SRC_BLOCK_MAX_GAS\"}" --label "polytone_note_to_$DEST_CHAIN_ID" --no-admin --from $SRC_ADDRESS --gas-prices $SRC_GAS_PRICES --gas auto --gas-adjustment 2 --yes --output json | jq -r '.txhash')
echo "note: $NOTE_TX"
sleep 12
NOTE_CONTRACT=$(SRC_BINARY query tx $NOTE_TX --output json | jq -r '.logs[0].events[0].attributes[0].value')
echo "note: $NOTE_CONTRACT"

## Listener
LISTENER_TX=$(SRC_BINARY tx wasm init $SRC_LISTENER_CODE_ID "{\"note\":\"$NOTE_CONTRACT\"}" --label "polytone_listener_from_$DEST_CHAIN_ID" --no-admin --from $SRC_ADDRESS --gas-prices $SRC_GAS_PRICES --gas auto --gas-adjustment 2 --yes --output json | jq -r '.txhash')
echo "listener: $LISTENER_TX"
sleep 12
LISTENER_CONTRACT=$(SRC_BINARY query tx $LISTENER_TX --output json | jq -r '.logs[0].events[0].attributes[0].value')
echo "listener: $LISTENER_CONTRACT"

# Destination chain
echo "\n$DEST_CHAIN_ID\n"
DEST_BLOCK_MAX_GAS=$(DEST_BINARY query params subspace baseapp BlockParams --output json | jq -r '.value' | jq -r '.max_gas')

## Voice
VOICE_TX=$(DEST_BINARY tx wasm init $DEST_VOICE_CODE_ID "{\"proxy_code_id\":"$DEST_PROXY_CODE_ID", \"block_max_gas\":\"$DEST_BLOCK_MAX_GAS\"}" --label "polytone_voice_from_$SRC_CHAIN_ID" --no-admin --from $DEST_ADDRESS --gas-prices $DEST_GAS_PRICES --gas auto --gas-adjustment 2 --yes --output json | jq -r '.txhash')
echo "voice: $VOICE_TX"
sleep 12
VOICE_CONTRACT=$(DEST_BINARY query tx $VOICE_TX --output json | jq -r '.logs[0].events[0].attributes[0].value')
echo "voice: $VOICE_CONTRACT"
```

6. Create channel between contracts

Ideally, find an existing highly-used connection between the chains. For
example, between Juno and Osmosis, there is a primary transfer channel used for
exchanging tokens. Because these channels are very active, their clients are
unlikely to expire, and if they expire, many people will be motivated to
reactivate them via governance. Thus, we can use the same connection these
channels use for our new channel pair.

```bash
CONNECTION=

SRC_CHAIN_ID=
SRC_NOTE_CONTRACT=

DEST_CHAIN_ID=
DEST_VOICE_CONTRACT=

hermes create channel --a-chain $SRC_CHAIN_ID --a-connection $CONNECTION --a-port wasm.$SRC_NOTE_CONTRACT --b-port wasm.$DEST_VOICE_CONTRACT --channel-version polytone-1
```

OR in the event that we have to create a new connection:

```bash
SRC_CHAIN_ID=
SRC_NOTE_CONTRACT=

DEST_CHAIN_ID=
DEST_VOICE_CONTRACT=

hermes create channel --a-chain $SRC_CHAIN_ID --b-chain $DEST_CHAIN_ID --a-port wasm.$SRC_NOTE_CONTRACT --b-port wasm.$DEST_VOICE_CONTRACT --new-client-connection --channel-version polytone-1
```

6a. and then add it to the keepalive script config to prevent it from expiring:

```toml
[[chains]]
name = "<CHAIN A NAME>"
rpc = "<CHAIN A RPC>"
notify_balance_threshold = 1000000

[[chains]]
name = "<CHAIN B NAME>"
rpc = "<CHAIN B RPC>"
notify_balance_threshold = 1000000

[[connections]]
chain_a = "<CHAIN A NAME>"
client_a = "<CHAIN A IBC CLIENT>"

chain_b = "<CHAIN B NAME>"
client_b = "<CHAIN B IBC CLIENT>"
```

This is optional, but highly recommended for inactive channels to prevent light
client expiration. Using existing connections is preferred for this reason and
likely does not require the use of the keepalive script.
