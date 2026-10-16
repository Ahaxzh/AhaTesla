import { Tag } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { PricingSection } from '@/components/settings/PricingSection'

/** 电价页 — v2.2 起为设置页「电价」分区的独立入口（侧栏导航已并入设置） */
export default function PricingPage() {
  return (
    <div>
      <PageHeader icon={Tag} title="电价" subtitle="默认价与充电地点单价（来源 TeslaMate geofences）" />
      <PricingSection />
    </div>
  )
}
