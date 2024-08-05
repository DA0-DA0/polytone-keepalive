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

enum EntryType {
  LowBalance = 'low_balance',
  LowBalanceFailure = 'low_balance_failure',
  Expiration = 'expiration',
  ExpirationFailure = 'expiration_failure',
  Update = 'update',
  UpdateFailure = 'update_failure',
}

const entryTitles: Record<EntryType, string> = {
  [EntryType.LowBalance]: 'Low Balance',
  [EntryType.Expiration]: 'Clients Expired',
  [EntryType.Update]: 'Clients Updated',
  [EntryType.LowBalanceFailure]: 'Balance Check Failure',
  [EntryType.ExpirationFailure]: 'Client Expiration Check Failure',
  [EntryType.UpdateFailure]: 'Update Clients Failure',
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

  const start = new Date()
  const initialMessage = `### Running at ${start.toISOString()}...`
  const webhookMessages = [
    await webhookClient.send({
      content: initialMessage,
    }),
  ]

  const entries: Partial<Record<EntryType, string[]>> = {}
  const sendDiscordNotification = async (type: EntryType, entry: string) => {
    let content = initialMessage

    // Make sure users are tagged.
    if (config.discord.notify_user_ids.length > 0 && !content.includes('<@!')) {
      content += `\n<@!${config.discord.notify_user_ids.join('>, <@!')}>`
    }

    entries[type] ||= []
    entries[type].push(entry.trim())

    // match order of titles
    const sections = Object.entries(entryTitles).flatMap(([type, title]) =>
      entries[type as EntryType]?.length
        ? `### ${title}:\n${entries[type as EntryType]!.map(
            (line) => `- ${line}`
          ).join('\n')}`
        : []
    )

    content += `\n${sections.join('\n')}`

    // Split content into parts of up to 2000 characters each (max content in
    // one Discord message), split at the newline before the limit is hit.
    const parts = content.split('\n').reduce((parts, part) => {
      if (parts.length === 0) {
        return [part]
      } else if (parts[parts.length - 1].length + part.length > 2000) {
        // start a new part if this part added to the previous part would
        // surpass the 2000 character limit
        parts.push(part)
      } else {
        // if it would not surpass the limit, add the part to the most recent
        // part, inserting the newline back
        parts[parts.length - 1] += `\n${part}`
      }

      return parts
    }, [] as string[])

    // edit existing messages with parts or create new ones as needed
    for (let i = 0; i < parts.length; i++) {
      if (i < webhookMessages.length) {
        webhookMessages[i] = await webhookClient.editMessage(
          webhookMessages[i].id,
          {
            content: parts[i],
          }
        )
      } else {
        webhookMessages.push(
          await webhookClient.send({
            content: parts[i],
          })
        )
      }
    }
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
      const minMicroBalance =
        gasPrice.amount.toFloatApproximation() * 100_000_000
      if (Number(microBalance) < minMicroBalance) {
        console.log(
          `--- ERROR: low balance of ${microBalance}${denom} in ${address} on ${chainName}`
        )

        // Notify via Discord
        await sendDiscordNotification(
          EntryType.LowBalance,
          `${Number(
            microBalance
          ).toLocaleString()}${denom} < ${minMicroBalance.toLocaleString()}${denom} @ \`${address}\` (${chainName})`
        )
      } else {
        console.log(
          `--- GOOD: balance of ${microBalance}${denom} in ${address} on ${chainName}`
        )
      }
    } catch (err) {
      console.error(chainName, err)

      const error = err instanceof Error ? err.message : `${err}`

      // Notify via Discord
      await sendDiscordNotification(
        EntryType.LowBalanceFailure,
        `[${chainName}] ${
          error.length > 1024
            ? 'Error too long. Check logs.'
            : `\`${error.replace(/\n+/g, ' ').trim()}\``
        }`
      )
    }
  }

  // update paths
  for (const path of paths) {
    // check expiration
    let needsUpdate = false

    try {
      const [code, res] = await spawnPromise('rly', [
        'query',
        'clients-expiration',
        path,
        '--output',
        'json',
      ])

      if (code !== 0) {
        throw new Error(res)
      }

      const [src, dst]: {
        HEALTH: 'GOOD' | string
        'LAST UPDATE HEIGHT': string
        TIME: string
        'TRUSTING PERIOD': string
        'UNBONDING PERIOD': string
        client: string
      }[] = res
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return line
          }
        })

      if (!src || typeof src !== 'object' || !dst || typeof dst !== 'object') {
        throw new Error('failed to parse clients expiration')
      }

      if (src.HEALTH === 'GOOD' && dst.HEALTH === 'GOOD') {
        // update if either client is within 5 days of expiry
        const srcExpiration = new Date(src['TIME'].split(' (')[0])
        const dstExpiration = new Date(dst['TIME'].split(' (')[0])
        needsUpdate =
          // use whichever expiration is sooner
          Math.min(srcExpiration.getTime(), dstExpiration.getTime()) -
            Date.now() <
          5 * 24 * 60 * 60 * 1000

        console.log(
          `--- GOOD: clients for ${path} are not expired ${
            needsUpdate
              ? "but expire in < 5 days, so let's try to update them"
              : 'and do not need to be updated'
          }`
        )
      } else {
        const expiredClients = [
          ...(src.HEALTH === 'GOOD' ? [] : [src.client]),
          ...(dst.HEALTH === 'GOOD' ? [] : [dst.client]),
        ]
        console.log(
          `--- ERROR: client(s) for ${path} are expired:\n${expiredClients
            .map((s) => `----- ${s}`)
            .join('\n')}`
        )

        // Notify via Discord
        await Promise.all(
          expiredClients.map((client) =>
            sendDiscordNotification(EntryType.Expiration, `[${path}] ${client}`)
          )
        )
      }
    } catch (err) {
      console.error(path, err)

      const error = err instanceof Error ? err.message : `${err}`

      // Notify via Discord
      await sendDiscordNotification(
        EntryType.ExpirationFailure,
        `[${path}] ${
          error.length > 1024
            ? 'Error too long. Check logs.'
            : `\`${error.replace(/\n+/g, ' ').trim()}\``
        }`
      )
    }

    if (!needsUpdate) {
      continue
    }

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
        .filter(Boolean)
        .map((line) => {
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

        // Notify via Discord
        await sendDiscordNotification(EntryType.Update, path)
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
      console.error(path, err)

      const error = err instanceof Error ? err.message : `${err}`

      // Notify via Discord
      await sendDiscordNotification(
        EntryType.UpdateFailure,
        `[${path}] ${
          error.length > 1024
            ? 'Error too long. Check logs.'
            : `\`${error.replace(/\n+/g, ' ').trim()}\``
        }`
      )
    }
  }

  await webhookClient.editMessage(webhookMessages[0].id, {
    content: webhookMessages[0].content.replace(
      initialMessage,
      `### Ran at ${start.toISOString()}`
    ),
  })

  await webhookClient.send({
    content: `_Finished in ${Number(
      ((Date.now() - start.getTime()) / 1000 / 60).toFixed(2)
    ).toLocaleString()} minutes._`,
  })
}

main().catch(console.error)
