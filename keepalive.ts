import { Command } from 'commander'
import { spawn } from 'child_process'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import toml from 'toml'
import fs from 'fs'
import chainRegistry from 'chain-registry'
import { StargateClient } from '@cosmjs/stargate'
import { EmbedBuilder, WebhookClient } from 'discord.js'

type Config = {
  mnemonic: string
  discord: {
    webhook_url: string
    notify_user_ids: string[]
  }
  chains?: {
    // Name in chain-registry
    name: string
    // Notify if balance drops below this threshold
    notify_balance_threshold: number
    // Override chain-registry RPC
    rpc?: string
  }[]
  // Polytone connections to keep alive
  connections: {
    // Name in chain-registry
    chain_a: string
    // IBC client id
    client_a: string
    // Name in chain-registry
    chain_b: string
    // IBC client id
    client_b: string
  }[]
}

const spawnPromise = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    try {
      const runCommand = spawn(cmd, args)

      let output = ''
      runCommand.stdout.on('data', (data) => (output += data.toString()))
      runCommand.stderr.on('data', (data) => (output += data.toString()))

      runCommand.on('error', (err) => {
        reject(new Error(err.message))
      })

      runCommand.on('exit', (code) => {
        if (code === 0) {
          resolve(output)
        } else {
          reject(new Error(`[${code}] ${output}`))
        }
      })
    } catch (e) {
      reject(e)
    }
  })

const main = async () => {
  const program = new Command()
  program.option('-c, --config <config>', 'config file', 'config.toml')
  program.parse()
  const { config: configFile } = program.opts()

  const config: Config = toml.parse(fs.readFileSync(configFile, 'utf-8'))

  const webhookClient = new WebhookClient({
    url: config.discord.webhook_url,
  })
  const sendDiscordNotification = async (
    type: 'success' | 'error',
    title: string,
    description: string | null = null
  ) => {
    const embed = new EmbedBuilder()
      .setColor(type === 'success' ? '#00ff00' : '#ff0000')
      .setTitle(title)
      .setDescription(description)
      .setTimestamp()

    await webhookClient.send({
      content:
        config.discord.notify_user_ids.length > 0
          ? `<@!${config.discord.notify_user_ids.join('>, <@!')}>`
          : undefined,
      embeds: [embed],
    })
  }

  const connections = await Promise.all(
    config.connections.map(async ({ chain_a, client_a, chain_b, client_b }) => {
      //! CHAIN A
      const chainA = chainRegistry.chains.find((c) => c.chain_name === chain_a)
      if (!chainA) {
        throw new Error(`chain A ${chain_a} not found`)
      }

      const chainAConfig = config.chains?.find((c) => c.name === chain_a)
      // Get chain A RPC
      const rpcA = chainAConfig?.rpc || chainA.apis?.rpc?.[0]?.address
      if (!rpcA) {
        throw new Error(`rpc not found for chain A ${chain_a}`)
      }

      const notifyBalanceThresholdA =
        chainAConfig?.notify_balance_threshold ?? 0

      // Get chain A wallet
      const walletA = await DirectSecp256k1HdWallet.fromMnemonic(
        config.mnemonic,
        {
          prefix: chainA.bech32_prefix,
        }
      )
      const [{ address: addressA }] = await walletA.getAccounts()
      const stargateA = await StargateClient.connect(rpcA)

      //! CHAIN B

      const chainB = chainRegistry.chains.find((c) => c.chain_name === chain_b)
      if (!chainB) {
        throw new Error(`chain B ${chain_b} not found`)
      }

      const chainBConfig = config.chains?.find((c) => c.name === chain_b)
      // Get chain B RPC
      const rpcB =
        config.chains?.find((c) => c.name === chain_b)?.rpc ||
        chainB.apis?.rpc?.[0]?.address
      if (!rpcB) {
        throw new Error(`rpc not found for chain B ${chain_b}`)
      }

      const notifyBalanceThresholdB =
        chainBConfig?.notify_balance_threshold ?? 0

      // Get chain B wallet
      const walletB = await DirectSecp256k1HdWallet.fromMnemonic(
        config.mnemonic,
        {
          prefix: chainB.bech32_prefix,
        }
      )
      const [{ address: addressB }] = await walletB.getAccounts()
      const stargateB = await StargateClient.connect(rpcB)

      return {
        a: {
          chain: chainA,
          denom: chainA.fees?.fee_tokens?.[0]?.denom ?? '',
          wallet: walletA,
          address: addressA,
          client: client_a,
          stargate: stargateA,
          notifyBalanceThreshold: notifyBalanceThresholdA,
        },
        b: {
          chain: chainB,
          denom: chainB.fees?.fee_tokens?.[0]?.denom ?? '',
          wallet: walletB,
          address: addressB,
          client: client_b,
          stargate: stargateB,
          notifyBalanceThreshold: notifyBalanceThresholdB,
        },
      }
    })
  )

  const uniqueChains = Object.values(
    connections.reduce(
      (prev, { a, b }) => ({
        ...prev,
        [a.chain.chain_name]: a,
        [b.chain.chain_name]: b,
      }),
      {} as Record<string, (typeof connections)[number]['a']>
    )
  )

  // Check balances...
  await uniqueChains.reduce(
    async (
      prev,
      { chain, stargate, address, denom, notifyBalanceThreshold }
    ) => {
      await prev

      const balance = Number((await stargate.getBalance(address, denom)).amount)

      console.log(`----- ${chain.chain_name} (${address})\n${balance}${denom}`)
      if (balance < notifyBalanceThreshold) {
        console.log(
          `--- WARNING: balance is below ${notifyBalanceThreshold}${denom}`
        )

        // Notify via Discord
        await sendDiscordNotification(
          'error',
          'Low Balance',
          `Chain: \`${
            chain.pretty_name
          }\`\nAddress: \`${address}\`\nBalance: \`${balance.toLocaleString()}${denom}\``
        )
      }
      console.log()
    },
    Promise.resolve()
  )

  // Update clients...
  let updatedSuccessfully = 0
  await connections.reduce(async (prev, { a, b }) => {
    await prev

    // Update client A
    try {
      console.log(
        `----- updating ${a.chain.chain_name}=>${b.chain.chain_name} client ${a.client}...`
      )
      const outputA = await spawnPromise('hermes', [
        'update',
        'client',
        '--host-chain',
        a.chain.chain_id,
        '--client',
        a.client,
      ])

      // If unsuccessful, throw output as error.
      if (!outputA.includes('SUCCESS')) {
        throw new Error(outputA)
      }

      console.log(outputA)
      updatedSuccessfully++
    } catch (err) {
      console.error('ERROR:', err instanceof Error ? err.message : err)

      // Notify via Discord
      await sendDiscordNotification(
        'error',
        `${a.chain.pretty_name} :arrow_right: ${b.chain.pretty_name} update failure`,
        `Chain ID: \`${a.chain.chain_id}\`\nIBC Client ID: \`${
          a.client
        }\`\n\`\`\`${err instanceof Error ? err.message : err}\`\`\``
      )
    }

    // Update client B
    try {
      console.log(
        `----- updating ${b.chain.chain_name} => ${a.chain.chain_name} client ${b.client}...`
      )
      const outputB = await spawnPromise('hermes', [
        'update',
        'client',
        '--host-chain',
        b.chain.chain_id,
        '--client',
        b.client,
      ])

      // If unsuccessful, throw output as error.
      if (!outputB.includes('SUCCESS')) {
        throw new Error(outputB)
      }

      console.log(outputB)
      updatedSuccessfully++
    } catch (err) {
      console.error('ERROR:', err instanceof Error ? err.message : err)

      // Notify via Discord
      await sendDiscordNotification(
        'error',
        `${b.chain.pretty_name} :arrow_right: ${a.chain.pretty_name} update failure`,
        `Chain ID: \`${b.chain.chain_id}\`\nIBC Client ID: \`${
          b.client
        }\`\n\`\`\`${err instanceof Error ? err.message : err}\`\`\``
      )
    }
  }, Promise.resolve())

  // Notify via Discord
  if (updatedSuccessfully > 0) {
    await sendDiscordNotification(
      'success',
      `${updatedSuccessfully}/${
        connections.length * 2
      } clients updated successfully`
    )
  }
}

main().catch(console.error)
