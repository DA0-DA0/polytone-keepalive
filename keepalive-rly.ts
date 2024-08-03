import { Command } from 'commander'
import { spawn } from 'child_process'
import toml from 'toml'
import fs from 'fs'
import { GasPrice } from '@cosmjs/stargate'
import { EmbedBuilder, WebhookClient } from 'discord.js'

type Config = {
  discord: {
    webhook_url: string
    notify_user_ids: string[]
  }
}

const spawnPromise = (cmd: string, args: string[]) =>
  new Promise<[number, string]>((resolve, reject) => {
    try {
      const runCommand = spawn(cmd, args)

      let output = ''
      runCommand.stdout.on('data', (data) => (output += data.toString()))
      runCommand.stderr.on('data', (data) => (output += data.toString()))

      runCommand.on('error', (err) => {
        reject(new Error(err.message))
      })

      runCommand.on('exit', (code) => {
        resolve([code ?? -1, output])
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
        type === 'error' && config.discord.notify_user_ids.length > 0
          ? `<@!${config.discord.notify_user_ids.join('>, <@!')}>`
          : undefined,
      embeds: [embed],
    })
  }

  const chains = Object.entries(
    JSON.parse((await spawnPromise('rly', ['chains', 'list', '--json']))[1])
  ).map(([chainName, chain]: [string, any]) => {
    const gasPrice = GasPrice.fromString(chain.value['gas-prices'])
    return {
      chainName,
      gasPrice,
    }
  })

  const paths = Object.keys(
    JSON.parse((await spawnPromise('rly', ['paths', 'list', '--json']))[1])
  )

  // check low balances

  for (const { chainName, gasPrice } of chains) {
    try {
      const denom = gasPrice.denom

      const [code, res] = await spawnPromise('rly', [
        'query',
        'balance',
        chainName,
        '--output',
        'json',
      ])
      if (code !== 0) {
        throw new Error(res)
      }

      const { address, balance: balances } = JSON.parse(res) as {
        address: string
        balance: string
      }

      const microBalance = balances
        .split(',')
        .find((b) => b.endsWith(gasPrice.denom))
        ?.replace(denom, '')
      if (!microBalance) {
        throw new Error(
          `native balance not found for ${address} on ${chainName}`
        )
      }

      // ensure balance is at least 100 million times larger than gas price
      const ratio =
        Number(microBalance) / gasPrice.amount.toFloatApproximation()
      if (ratio < 100_000_000) {
        console.log(
          `--- WARNING: low balance of ${microBalance}${denom} in ${address} on ${chainName}`
        )

        // Notify via Discord
        await sendDiscordNotification(
          'error',
          'Low Balance',
          `Chain: \`${chainName}\`\nAddress: \`${address}\`\nBalance: \`${microBalance.toLocaleString()}${denom}\``
        )
      } else {
        console.log(
          `--- GOOD: balance of ${microBalance}${denom} in ${address} on ${chainName}`
        )
      }
    } catch (err) {
      console.error(err)

      // Notify via Discord
      await sendDiscordNotification(
        'error',
        'Balance Check Failure',
        `Chain: \`${chainName}\`\n\n\`${
          err instanceof Error ? err.message : err
        }\``
      )
    }
  }

  // update paths

  for (const path of paths) {
    try {
      const output: (
        | {
            lvl: string
            ts: string
            msg: string
          }
        | string
      )[] = (
        await spawnPromise('rly', [
          'tx',
          'update-clients',
          path,
          '--log-format',
          'json',
        ])
      )[1]
        .split('\n')
        .flatMap((line) => {
          if (!line) {
            return []
          }

          try {
            return JSON.parse(line)
          } catch {
            return line
          }
        })
      const lastLine = output[output.length - 1]

      // if last line is success, successful. otherwise, notify on error
      if (
        lastLine &&
        typeof lastLine === 'object' &&
        lastLine.msg === 'Clients updated'
      ) {
        console.log(`--- GOOD: updated clients for ${path}`)
      } else {
        console.log(`--- ERROR: failed to update clients for path ${path}`)

        // sometimes the last line contains a concise error. if so use it.
        // otherwise, dump the whole output
        throw new Error(
          typeof lastLine === 'string' && lastLine.startsWith('Error')
            ? lastLine
            : JSON.stringify(output, null, 2)
        )
      }
    } catch (err) {
      console.error(err)

      const error = err instanceof Error ? err.message : `${err}`

      // Notify via Discord
      await sendDiscordNotification(
        'error',
        'Update Clients Failure',
        `Path: \`${path}\`\n\n${
          error.length > 1024 ? 'Error too long. Check logs.' : error
        }`
      )
    }
  }
}

main().catch(console.error)
