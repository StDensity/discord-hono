import type { APIInteraction, APIInteractionResponsePong } from 'discord-api-types/v10'
import { AutocompleteContext, CommandContext, ComponentContext, CronContext, ModalContext } from './context'
import { type RegExpMap, StringMap } from './handler-map'
import type {
  AnyHandler,
  CronEvent,
  DiscordEnv,
  Env,
  ExecutionContext,
  HandlerNumber,
  InitOptions,
  Verify,
} from './types'
import { CUSTOM_ID_SEPARATOR, ResponseObject, errorDev } from './utils'
import { verify } from './verify'

type DiscordEnvBindings = {
  DISCORD_TOKEN?: string
  DISCORD_PUBLIC_KEY?: string
  DISCORD_APPLICATION_ID?: string
}

export class DiscordHono<E extends Env = Env, K extends string | RegExp = string> {
  #verify: Verify = verify
  #discord: (env: DiscordEnvBindings | undefined) => DiscordEnv
  #map: StringMap<E> | RegExpMap<E>
  #set<N extends HandlerNumber>(num: N, key: string | K, value: AnyHandler<E, N>) {
    // @ts-expect-error
    this.#map.s(num, key, value)
    return this
  }
  /**
   * [Documentation](https://discord-hono.luis.fun/interactions/discord-hono/)
   * @param {InitOptions} options
   */
  constructor(options?: InitOptions<E>) {
    if (options?.verify) this.#verify = options.verify
    this.#discord = env => {
      const discordEnv = options?.discordEnv ? options.discordEnv(env) : {}
      return {
        APPLICATION_ID: env?.DISCORD_APPLICATION_ID,
        TOKEN: env?.DISCORD_TOKEN,
        PUBLIC_KEY: env?.DISCORD_PUBLIC_KEY,
        ...discordEnv,
      }
    }
    // @ts-expect-error
    this.#map = new (options?.HandlerMap ?? StringMap)()
  }

  /**
   * @param {string | RegExp} command Match the first argument of `Command`
   * @param handler
   * @returns {this}
   */
  command = (command: string | K, handler: AnyHandler<E, 2>) => this.#set(2, command, handler)
  /**
   * @param {string | RegExp} component_id Match the first argument of `Button` or `Select`
   * @param handler
   * @returns {this}
   */
  component = (component_id: string | K, handler: AnyHandler<E, 3>) => this.#set(3, component_id, handler)
  /**
   * @param {string | RegExp} command Match the first argument of `Command`
   * @param handler
   * @returns {this}
   */
  autocomplete = (command: string | K, handler: AnyHandler<E, 4>, commandHandler?: AnyHandler<E, 2>) =>
    (commandHandler ? this.#set(2, command, commandHandler) : this).#set(4, command, handler)
  /**
   * @param {string | RegExp} modal_id Match the first argument of `Modal`
   * @param handler
   * @returns {this}
   */
  modal = (modal_id: string | K, handler: AnyHandler<E, 5>) => this.#set(5, modal_id, handler)
  /**
   * @param cron Match the crons in the toml file
   * @param handler
   * @returns {this}
   */
  cron = (cron: string | K, handler: AnyHandler<E, 0>) => this.#set(0, cron, handler)

  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @param executionCtx
   * @returns {Promise<Response>}
   */
  fetch = async (request: Request, env?: E['Bindings'], executionCtx?: ExecutionContext) => {
    switch (request.method) {
      case 'GET':
        return new Response('Operational🔥')
      case 'POST': {
        const discord = this.#discord(env)
        if (!discord.PUBLIC_KEY) throw errorDev('DISCORD_PUBLIC_KEY')
        const body = await request.text()
        if (
          !(await this.#verify(
            body,
            request.headers.get('x-signature-ed25519'),
            request.headers.get('x-signature-timestamp'),
            discord.PUBLIC_KEY,
          ))
        )
          return new Response('Bad Request', { status: 401 })
        const interaction: APIInteraction = JSON.parse(body)
        const key = (() => {
          switch (interaction.type) {
            case 2:
            case 4:
              return interaction.data.name
            case 3:
            case 5: {
              const id = interaction.data.custom_id
              const key = id.split(CUSTOM_ID_SEPARATOR)[0]
              interaction.data.custom_id = id.slice(key.length + 1)
              return key
            }
          }
          return ''
        })()
        // biome-ignore format: text width
        switch (interaction.type) {
          case 1:
            return new ResponseObject({ type: 1 } satisfies APIInteractionResponsePong)
          case 2:
            return await this.#map.g(2, key)(new CommandContext(request, env, executionCtx, discord, interaction, key))
          case 3:
            return await this.#map.g(3, key)(new ComponentContext(request, env, executionCtx, discord, interaction, key))
          case 4:
            return await this.#map.g(4, key)(new AutocompleteContext(request, env, executionCtx, discord, interaction, key))
          case 5:
            return await this.#map.g(5, key)(new ModalContext(request, env, executionCtx, discord, interaction, key))
        }
        return new ResponseObject({ error: 'Unknown Type' }, 400)
      }
    }
    return new Response('Not Found', { status: 404 })
  }

  /**
   * Method triggered by cloudflare workers' crons
   * @param event
   * @param {Record<string, unknown>} env
   * @param executionCtx
   */
  scheduled = async (event: CronEvent, env: E['Bindings'], executionCtx?: ExecutionContext) => {
    const handler = this.#map.g(0, event.cron)
    const c = new CronContext(event, env, executionCtx, this.#discord(env), event.cron)
    if (executionCtx?.waitUntil) executionCtx.waitUntil(handler(c))
    else await handler(c)
  }
}
