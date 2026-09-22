import type * as vscode from 'vscode'
import type { ConnectionConfig } from '@shared/types'

type StoredConnection = Omit<ConnectionConfig, 'password'>

const KEY = 'connections'
const secretKey = (id: string) => `password:${id}`

/** Stores connections in VS Code's globalState. Passwords go to SecretStorage (the OS keychain). */
export class ConnectionStore {
  private constructor(
    private context: vscode.ExtensionContext,
    private items: ConnectionConfig[]
  ) {}

  static async load(context: vscode.ExtensionContext): Promise<ConnectionStore> {
    const stored = context.globalState.get<StoredConnection[]>(KEY, [])
    const items = await Promise.all(
      stored.map(async (c) => {
        const password = await Promise.resolve(context.secrets.get(secretKey(c.id))).catch(() => undefined)
        return password ? { ...c, password } : c
      })
    )
    return new ConnectionStore(context, items)
  }

  list(): ConnectionConfig[] {
    return this.items
  }

  get(id: string): ConnectionConfig | undefined {
    return this.items.find((c) => c.id === id)
  }

  async save(config: ConnectionConfig): Promise<ConnectionConfig> {
    if (config.password) await this.context.secrets.store(secretKey(config.id), config.password)
    else await this.context.secrets.delete(secretKey(config.id))
    const i = this.items.findIndex((c) => c.id === config.id)
    if (i >= 0) this.items[i] = config
    else this.items.push(config)
    await this.flush()
    return config
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((c) => c.id !== id)
    await this.flush()
    await this.context.secrets.delete(secretKey(id))
  }

  private async flush(): Promise<void> {
    const stored: StoredConnection[] = this.items.map(({ password: _, ...rest }) => rest)
    await this.context.globalState.update(KEY, stored)
  }
}
