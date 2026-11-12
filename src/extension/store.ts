import type * as vscode from 'vscode'
import type { ConnectionConfig } from '@shared/types'

/** Fields kept in SecretStorage instead of globalState. A MongoDB URI can hold a password. */
const SECRET_FIELDS = ['password', 'uri'] as const

type SecretField = (typeof SECRET_FIELDS)[number]
type StoredConnection = Omit<ConnectionConfig, SecretField>

const KEY = 'connections'
const secretKey = (field: SecretField, id: string) => `${field}:${id}`

/** Stores connections in VS Code's globalState. Passwords and URIs go to SecretStorage (the OS keychain). */
export class ConnectionStore {
  private constructor(
    private context: vscode.ExtensionContext,
    private items: ConnectionConfig[]
  ) {}

  static async load(context: vscode.ExtensionContext): Promise<ConnectionStore> {
    // Versions up to 0.2.1 kept the URI in globalState
    const stored = context.globalState.get<(StoredConnection & { uri?: string })[]>(KEY, [])
    const items = await Promise.all(
      stored.map(async (c) => {
        const secrets: Partial<Record<SecretField, string>> = {}
        for (const field of SECRET_FIELDS) {
          const value = await Promise.resolve(context.secrets.get(secretKey(field, c.id))).catch(() => undefined)
          if (value) secrets[field] = value
        }
        return { ...c, ...secrets }
      })
    )
    const store = new ConnectionStore(context, items)
    await store.moveUrisToSecrets(stored.filter((c) => c.uri).map((c) => c.id))
    return store
  }

  list(): ConnectionConfig[] {
    return this.items
  }

  get(id: string): ConnectionConfig | undefined {
    return this.items.find((c) => c.id === id)
  }

  async save(config: ConnectionConfig): Promise<ConnectionConfig> {
    for (const field of SECRET_FIELDS) await this.storeSecret(field, config.id, config[field])
    const i = this.items.findIndex((c) => c.id === config.id)
    if (i >= 0) this.items[i] = config
    else this.items.push(config)
    await this.flush()
    return config
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((c) => c.id !== id)
    await this.flush()
    for (const field of SECRET_FIELDS) await this.context.secrets.delete(secretKey(field, id))
  }

  /** Moves URIs saved by older versions out of globalState. If the keychain fails, they stay where they are. */
  private async moveUrisToSecrets(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    try {
      for (const id of ids) await this.storeSecret('uri', id, this.get(id)?.uri)
      await this.flush()
    } catch {
      // Try again on the next start
    }
  }

  private async storeSecret(field: SecretField, id: string, value: string | undefined): Promise<void> {
    if (value) await this.context.secrets.store(secretKey(field, id), value)
    else await this.context.secrets.delete(secretKey(field, id))
  }

  private async flush(): Promise<void> {
    const stored: StoredConnection[] = this.items.map(({ password: _password, uri: _uri, ...rest }) => rest)
    await this.context.globalState.update(KEY, stored)
  }
}
