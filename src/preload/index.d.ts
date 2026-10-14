import type { ArhApi } from '../shared/api.ts'

declare global {
  interface Window {
    arh: ArhApi
  }
}

export {}
