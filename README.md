# polytone-keepalive

This is a script to keep [Polytone](https://github.com/DA0-DA0/polytone)'s IBC
light clients alive using the open-source IBC relayer
[Hermes](https://hermes.informal.systems).

See the IBC-Go docs on [light client
pauses](https://ibc.cosmos.network/main/ibc/proposals.html). Essentially, if a
client is not used for a period of time (its "trust period"), it will be paused,
requiring a governance proposal to restart it. This script will check the light
clients specified and use Hermes to update recently inactive clients, keeping
them alive to prevent needing to restart them via governance proposals. If it
fails to do so for any reason, it will send a notification to a Discord channel
for troubleshooting.

[SETUP.md](./SETUP.md) contains instructions for setting up a Polytone
connection between two chains.

## Usage

1. Install [Hermes](https://hermes.informal.systems) and configure it.

2. Install the dependencies:

   ```sh
   npm install
   ```

3. Create `config.toml` from `config.toml.example` and fill in the values,
   configuring the same chains as in your Hermes config as well as the polytone
   client connections to keep alive. Chain names must match known chain names
   from the [Chain Registry](https://github.com/cosmology-tech/chain-registry)'s
   list of chains in
   [chains.ts](https://github.com/cosmology-tech/chain-registry/blob/main/packages/chain-registry/src/chains.ts).

4. Create a Discord webhook by following this guide:

   https://discordjs.guide/popular-topics/webhooks.html#creating-webhooks

   Then, add the webhook URL to `config.toml`.

5. Run the script:

   ```sh
   npm run keepalive
   ```
