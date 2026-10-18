import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { CarInfo } from '@/types'

/**
 * m4e 多车上下文:车辆清单 + 当前车切换。
 * - currentCarId 持久化 localStorage(ahatesla_car),缺省回落主车(isPrimary)
 * - 单车实例 isMultiCar=false,切换器由 UI 侧自行隐藏(context 照常工作,carId 照常下发)
 * - resolvedCarId 为 undefined 时(清单未加载/无车)所有请求不带 carId → 后端回落主车
 */
interface CarState {
  cars: CarInfo[]
  /** 实际生效车 id(用户选择或主车;清单未就绪为 undefined) */
  currentCarId: number | undefined
  /** 用户显式选择的原始值(null=未选,回落主车) */
  selectedCarId: number | null
  setCurrentCarId: (id: number | null) => void
  isMultiCar: boolean
  /** 展示名:别名 > TeslaMate 车名 */
  displayName: (id?: number | null) => string
}

const STORAGE_KEY = 'ahatesla_car'
const CarContext = createContext<CarState | null>(null)

function readStoredCar(): number | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    const n = v == null ? NaN : Number(v)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function CarProvider({ children }: { children: ReactNode }) {
  const { data: cars } = useQuery({
    queryKey: ['cars'],
    queryFn: api.cars,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const [selectedCarId, setSelectedCarId] = useState<number | null>(readStoredCar)

  const list = cars ?? []
  // 选中的车已不存在(换库/删车)→ 静默回落主车
  useEffect(() => {
    if (list.length > 0 && selectedCarId != null && !list.some((c) => c.id === selectedCarId)) {
      setSelectedCarId(null)
      try { localStorage.removeItem(STORAGE_KEY) } catch { /* 忽略 */ }
    }
  }, [list, selectedCarId])

  const primaryId = list.find((c) => c.isPrimary)?.id ?? list[0]?.id
  const currentCarId = selectedCarId != null && list.some((c) => c.id === selectedCarId)
    ? selectedCarId
    : primaryId

  const setCurrentCarId = useCallback((id: number | null) => {
    setSelectedCarId(id)
    try {
      if (id == null) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, String(id))
    } catch { /* 存不进去则仅本会话生效 */ }
  }, [])

  const displayName = useCallback(
    (id?: number | null) => {
      const c = id == null ? list.find((x) => x.id === currentCarId) : list.find((x) => x.id === id)
      return c?.alias?.trim() || c?.name || ''
    },
    [list, currentCarId],
  )

  const value = useMemo<CarState>(
    () => ({ cars: list, currentCarId, selectedCarId, setCurrentCarId, isMultiCar: list.length > 1, displayName }),
    [list, currentCarId, selectedCarId, setCurrentCarId, displayName],
  )

  return <CarContext.Provider value={value}>{children}</CarContext.Provider>
}

export function useCar(): CarState {
  const ctx = useContext(CarContext)
  if (!ctx) throw new Error('useCar 必须在 CarProvider 内使用')
  return ctx
}
