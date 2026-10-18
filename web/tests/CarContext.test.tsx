import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { CarProvider, useCar } from '@/contexts/CarContext'
import { server } from './msw'
import { mockCars } from './msw'

beforeAll(() => server.listen())
afterEach(() => {
  server.resetHandlers()
  localStorage.clear()
})
afterAll(() => server.close())

function Probe() {
  const { cars, currentCarId, isMultiCar, displayName, setCurrentCarId } = useCar()
  return (
    <div>
      <span data-testid="probe-count">{cars.length}</span>
      <span data-testid="probe-current">{currentCarId ?? 'none'}</span>
      <span data-testid="probe-multi">{String(isMultiCar)}</span>
      <span data-testid="probe-name">{displayName(currentCarId)}</span>
      <button data-testid="probe-switch" onClick={() => setCurrentCarId(2)}>switch</button>
      <button data-testid="probe-clear" onClick={() => setCurrentCarId(null)}>clear</button>
    </div>
  )
}

function renderCar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CarProvider>
        <Probe />
      </CarProvider>
    </QueryClientProvider>,
  )
}

describe('CarContext(m4e 多车)', () => {
  it('默认回落主车(isPrimary),displayName 别名优先', async () => {
    renderCar()
    // cars 查询异步:等清单到位(而非等元素出现——首帧即为 0)
    await waitFor(() => expect(screen.getByTestId('probe-count')).toHaveTextContent('2'))
    await waitFor(() => expect(screen.getByTestId('probe-current')).toHaveTextContent('1'))
    expect(screen.getByTestId('probe-multi')).toHaveTextContent('true')
    expect(screen.getByTestId('probe-name')).toHaveTextContent('Model 3 长续航')
  })

  it('切车持久化 localStorage,清除后回落主车', async () => {
    const user = userEvent.setup()
    renderCar()
    await screen.findByTestId('probe-count')
    await waitFor(() => expect(screen.getByTestId('probe-current')).toHaveTextContent('1'))
    await user.click(screen.getByTestId('probe-switch'))
    await waitFor(() => expect(screen.getByTestId('probe-current')).toHaveTextContent('2'))
    expect(localStorage.getItem('ahatesla_car')).toBe('2')
    await user.click(screen.getByTestId('probe-clear'))
    await waitFor(() => expect(screen.getByTestId('probe-current')).toHaveTextContent('1'))
    expect(localStorage.getItem('ahatesla_car')).toBeNull()
  })

  it('持久化的车已不存在(换库)→ 静默回落主车并清理存储', async () => {
    localStorage.setItem('ahatesla_car', '99')
    renderCar()
    await waitFor(() => expect(screen.getByTestId('probe-current')).toHaveTextContent('1'))
    expect(localStorage.getItem('ahatesla_car')).toBeNull()
  })

  it('单车实例:isMultiCar=false,切换器不应渲染(AppLayout 侧隐藏)', async () => {
    server.use(http.get('/api/cars', () => HttpResponse.json([mockCars[0]])))
    renderCar()
    await waitFor(() => expect(screen.getByTestId('probe-count')).toHaveTextContent('1'))
    await waitFor(() => expect(screen.getByTestId('probe-multi')).toHaveTextContent('false'))
    await waitFor(() => expect(screen.getByTestId('probe-current')).toHaveTextContent('1'))
  })
})
