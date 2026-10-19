import { Component, type ErrorInfo, type ReactNode } from 'react'

/** 单页渲染异常兜底：任何一条脏数据（如 null.toFixed）只熄灭当前页，
 *  TabBar/导航保持可用，可一键重试 —— 不再整站白屏（CLAUDE.md 禁白屏）。
 *  注意：resetKey 变化只清除错误态（子树不强制 remount），恢复依赖新路由
 *  自行拉取新数据；"重试"按钮同样只清错误态。 */
interface Props {
  children: ReactNode
  /** 错误态复位键（路由 path 变化时清除错误） */
  resetKey?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 控制台留痕便于排查；不上报到任何外部服务（隐私红线）
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    // 路由切换时自动复位（新页面不应继承上一页的错误态）
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-8 text-center" data-testid="page-error">
        <div className="text-4xl">⚠️</div>
        <div className="text-sm text-slate-300">页面渲染出了点问题</div>
        <div className="max-w-md break-all text-[11px] text-slate-500">{String(this.state.error?.message || '')}</div>
        <button
          className="rounded-lg bg-white/10 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/20"
          onClick={() => this.setState({ error: null })}
        >
          重试
        </button>
      </div>
    )
  }
}
