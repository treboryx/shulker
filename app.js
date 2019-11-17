'use strict'

const Discord = require('discord.js')
const Rcon = require('./lib/rcon.js')
const express = require('express')
const axios = require('axios')
const emojiStrip = require('emoji-strip')
const { Tail } = require('tail')
const fs = require('fs')

const configFile = (process.argv.length > 2) ? process.argv[2] : './config.json'

console.log('[INFO] Using configuration file:', configFile)

const c = require(configFile)

let app = null
let tail = null

function fixUsername(username) {
  return username.replace(/(§[A-Z-a-z0-9])/g, '')
}

// replace mentions with discriminator with the actual mention
function replaceDiscordMentions(message) {
  if (c.ALLOW_USER_MENTIONS) {
    const possibleMentions = message.match(/@(\S+)/gim)
    if (possibleMentions) {
      for (let mention of possibleMentions) {
        const mentionParts = mention.split('#')
        let username = mentionParts[0].replace('@', '')
        if (mentionParts.length > 1) {
          const user = shulker.users.find(user => user.username === username && user.discriminator === mentionParts[1])
          if (user) {
            message = message.replace(mention, '<@' + user.id + '>')
          }
        }
      }
    }
  }
  return message
}

function makeDiscordMessage(username, message) {
  // make a discord message string by formatting the configured template with the given parameters
  message = replaceDiscordMentions(message)

  return c.DISCORD_MESSAGE_TEMPLATE
    .replace('%username%', username)
    .replace('%message%', message)
}

function makeDiscordWebhook(username, message) {
  message = replaceDiscordMentions(message)

  return {
    username: username,
    content: message,
    'avatar_url': `https://minotar.net/helm/${username}/256.png`
  }
}

function makeMinecraftTellraw(message) {
  // same as the discord side but with discord message parameters
  const username = emojiStrip(message.author.username)
  const discriminator = message.author.discriminator
  const text = emojiStrip(message.cleanContent)
  // hastily use JSON to encode the strings
  const variables = JSON.parse(JSON.stringify({ username, discriminator, text }))

  return c.MINECRAFT_TELLRAW_TEMPLATE
    .replace('%username%', variables.username)
    .replace('%discriminator%', variables.discriminator)
    .replace('%message%', variables.text)
}

const debug = c.DEBUG
const shulker = new Discord.Client()

function initApp() {
  // run a server if not local
  if (!c.IS_LOCAL_FILE) {
    app = express()
    const http = require('http').Server(app)

    app.use(function (request, response, next) {
      request.rawBody = ''
      request.setEncoding('utf8')

      request.on('data', function (chunk) {
        request.rawBody += chunk
      })

      request.on('end', function () {
        next()
      })
    })

    const serverport = process.env.PORT || c.PORT

    http.listen(serverport, function () {
      console.log('[INFO] Bot listening on *:' + serverport)
    })
  } else {
    if (fs.existsSync(c.LOCAL_FILE_PATH)) {
      console.log('[INFO] Using configuration for local file at "' + c.LOCAL_FILE_PATH + '"')
      tail = new Tail(c.LOCAL_FILE_PATH)
    } else {
      throw new Error('[ERROR] Local file not found at "' + c.LOCAL_FILE_PATH + '"')
    }
  }
}

function watch(callback) {
  if (c.IS_LOCAL_FILE) {
    tail.on('line', function (data) {
      // ensure that this is a message
      if (data.indexOf(': <') !== -1) {
        callback(data)
      }
    })
  } else {
    app.post(c.WEBHOOK, function (request, response) {
      callback(request.rawBody)
      response.send('')
    })
  }
}

shulker.on('ready', function () {
  watch(function (body) {
    console.log('[INFO] Recieved ' + body)
    const re = new RegExp(c.REGEX_MATCH_CHAT_MC)
    const ignored = new RegExp(c.REGEX_IGNORED_CHAT)
    const esc = new RegExp(c.REGEX_ASNI_CODE)
    if (!ignored.test(body)) {
      const bodymatch = body.match(re)
      const username = fixUsername(bodymatch[1])
      let message = bodymatch[2]
      const asni = message.match(esc)
      if (asni.length) message = message.replace(asni, "")
      if (debug) {
        console.log('[DEBUG] Username: ' + bodymatch[1])
        console.log('[DEBUG] Text: ' + bodymatch[2])
      }
      if (c.USE_WEBHOOKS) {
        const webhook = makeDiscordWebhook(username, message)
        axios.post(c.WEBHOOK_URL, {
          ...webhook
        }, {
          headers: {
            'Content-Type': 'application/json'
          }
        })
      } else {
        // find the channel
        const channel = shulker.channels.find((ch) => ch.id === c.DISCORD_CHANNEL_ID && ch.type === 'text')
        channel.send(makeDiscordMessage(username, message))
      }
    }
  })
})

shulker.on('message', function (message) {
  if (message.channel.id === c.DISCORD_CHANNEL_ID && message.channel.type === 'text') {
    if (c.USE_WEBHOOKS && message.webhookID) {
      return // ignore webhooks if using a webhook
    }
    if (message.author.id !== shulker.user.id) {
      if (message.attachments.length) { // skip images/attachments
        return
      }
      const client = new Rcon(c.MINECRAFT_SERVER_RCON_IP, c.MINECRAFT_SERVER_RCON_PORT) // create rcon client
      client.auth(c.MINECRAFT_SERVER_RCON_PASSWORD, function () { // only authenticate when needed
        if (c.ADMINS.includes(message.author.id) && message.content.startsWith(c.PREFIX)) {
          client.command(message.content.replace(c.PREFIX, ""), function (err) {
            if (err) {
              console.log('[ERROR]', err)
            }
            client.close() // close the rcon connection
          })
        } else {
          client.command('tellraw @a ' + makeMinecraftTellraw(message), function (err) {
            if (err) {
              console.log('[ERROR]', err)
            }
            client.close() // close the rcon connection
          })
        }
      })
    }
  }
})

initApp()
shulker.login(c.DISCORD_TOKEN)
