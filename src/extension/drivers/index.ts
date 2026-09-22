import type { ConnectionConfig } from '@shared/types'
import type { Driver } from './types'
import { MysqlDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { MongoDriver } from './mongodb'
import { RedisDriver } from './redis'
import { OpenSearchDriver } from './opensearch'

export function createDriver(config: ConnectionConfig): Driver {
  switch (config.type) {
    case 'mysql':
      return new MysqlDriver(config)
    case 'postgres':
      return new PostgresDriver(config)
    case 'mongodb':
      return new MongoDriver(config)
    case 'redis':
      return new RedisDriver(config)
    case 'opensearch':
      return new OpenSearchDriver(config)
    default:
      throw new Error(`Unsupported database type: ${(config as ConnectionConfig).type}`)
  }
}

/** Keeps one driver per connection ID */
export class DriverManager {
  private drivers = new Map<string, Promise<Driver>>()

  constructor(private lookup: (id: string) => ConnectionConfig | undefined) {}

  get(id: string): Promise<Driver> {
    let pending = this.drivers.get(id)
    if (!pending) {
      const config = this.lookup(id)
      if (!config) return Promise.reject(new Error('Connection not found'))
      const driver = createDriver(config)
      pending = driver.connect().then(() => driver)
      // Remove it on failure so the next call can retry
      pending.catch(() => {
        if (this.drivers.get(id) === pending) this.drivers.delete(id)
        driver.close().catch(() => {})
      })
      this.drivers.set(id, pending)
    }
    return pending
  }

  async close(id: string): Promise<void> {
    const pending = this.drivers.get(id)
    this.drivers.delete(id)
    if (!pending) return
    const driver = await pending.catch(() => null)
    await driver?.close()
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.drivers.keys()].map((id) => this.close(id)))
  }
}

/** Tests a connection with unsaved settings */
export async function testConnection(config: ConnectionConfig): Promise<string> {
  const driver = createDriver(config)
  try {
    await driver.connect()
    return await driver.ping()
  } finally {
    await driver.close().catch(() => {})
  }
}
