import { Activity } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { SystemSection } from '@/components/settings/SystemSection'

/** 系统页 — v2.2 起为设置页「系统」分区的独立入口（侧栏导航已并入设置） */
export default function SystemPage() {
  return (
    <div>
      <PageHeader icon={Activity} title="系统" subtitle="运行状态与事件日志" />
      <SystemSection />
    </div>
  )
}
