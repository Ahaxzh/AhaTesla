import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// node ≥26 兼容：node 内置实验性 localStorage/sessionStorage（未配 --localstorage-file 时
// 是恒返回 undefined 的 getter/setter），vitest 4.1 的 jsdom 环境向 globalThis 拷贝 window
// 属性时赋值被该 setter 吞掉，globalThis 与 window 两层的 storage 同时丢失（独立 jsdom 正常）。
// 这里自足 polyfill 一个内存版 Storage，两层统一对齐；afterEach 里既有 clear() 不受影响。
function makeStorage(): Storage {
  const map = new Map<string, string>()
  const n = (i: number) => [...map.keys()][i] ?? null
  return {
    get length() { return map.size },
    key: n,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(String(k), String(v)) },
    removeItem: (k) => { map.delete(k) },
    clear: () => { map.clear() },
  } as Storage
}
for (const key of ['localStorage', 'sessionStorage'] as const) {
  for (const target of [globalThis, window as unknown as object] as const) {
    const existing = Reflect.get(target, key)
    if (!existing || typeof existing.getItem !== 'function') {
      Reflect.set(target, key, makeStorage())
    }
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
