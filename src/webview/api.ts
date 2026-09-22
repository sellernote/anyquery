import type { Api } from '@shared/types'
import { decode, encode, type Reply, type Request, type Response } from '@shared/rpc'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

const vscode = acquireVsCodeApi()
const pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>()
let seq = 0

window.addEventListener('message', (event: MessageEvent<Response>) => {
  const { id, body } = event.data
  const call = pending.get(id)
  if (!call) return
  pending.delete(id)
  const reply = decode(body) as Reply
  if (reply.ok) call.resolve(reply.value)
  else call.reject(new Error(reply.error))
})

function invoke(method: keyof Api, args: unknown[]): Promise<unknown> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const request: Request = { id, method, args: encode(args) }
    vscode.postMessage(request)
  })
}

/** Calls the extension. Each method runs the function of the same name in extension/index.ts. */
export const api = new Proxy({} as Api, {
  get: (_target, method) => (...args: unknown[]) => invoke(method as keyof Api, args)
})
