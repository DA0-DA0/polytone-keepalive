# polytone-keepalive

This is a script to help keep IBC light clients alive using the open-source IBC
relayer [Hermes](https://hermes.informal.systems) or
[rly](https://github.com/cosmos/relayer). It was made for
[Polytone](https://github.com/DA0-DA0/polytone) but works with any IBC clients.

See the IBC-Go docs on [light client
pauses](https://ibc.cosmos.network/main/ibc/proposals.html). Essentially, if a
client is not used for a period of time (its "trust period"), it will be paused,
requiring a governance proposal to restart it. This script will check the light
clients specified and use Hermes to update recently inactive clients, keeping
them alive to prevent needing to restart them via governance proposals. If it
fails to do so for any reason, it will send a notification to a Discord channel
for troubleshooting.

There are two scripts. The more manual one is `keepalive` which depends on
Hermes. The other one is `keepalive-rly` which uses rly and automatically
detects configured addresses and paths to use.

## Usage

This expects Polytone connections to already exist. Follow [this
guide](https://github.com/DA0-DA0/polytone/wiki/How-to-set-up-a-new-polytone-connection)
to open a new one.

1. Install [Hermes](https://hermes.informal.systems) or
   [rly](https://github.com/cosmos/relayer) and configure it.

2. Install the dependencies:

   ```sh
   npm install
   ```

3. Create `config.toml` from `config.toml.example` and fill in the necessary
   values.

   For Hermes, configure the mnemonic, and the same chains as in your relayer
   config as well as the polytone client connections to keep alive. Chain names
   must match known chain names from the [Chain
   Registry](https://github.com/cosmology-tech/chain-registry)'s list of chains
   in
   [chains.ts](https://github.com/cosmology-tech/chain-registry/blob/main/packages/chain-registry/src/chains.ts).

   ```toml
   mnemonic = ""

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

   For rly, you only need to configure the discord notification webhook.

4. Create a Discord webhook by following this guide:

   https://discordjs.guide/popular-topics/webhooks.html#creating-webhooks

   Then, add the webhook URL to `config.toml`.

5. Run the script:

   ```sh
   npm run keepalive:hermes
   # OR
   npm run keepalive:rly
   ```

   Set up a cron job to run this script periodically. For example, to run the
   rly script every 3 days:

   ```sh
   0 0 */3 * * cd /path/to/polytone-keepalive && npm run keepalive:rly
   ```
