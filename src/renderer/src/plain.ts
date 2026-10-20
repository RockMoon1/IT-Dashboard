import { toRaw } from 'vue'

/**
 * A deep copy with no Vue proxies in it. Everything sent to the main process crosses
 * contextBridge, which copies plain objects and arrays only: a reactive object or array (a field
 * of the store, a form) makes the call fail with "An object could not be cloned".
 */
export function plain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(toRaw(value))) as T)
}
