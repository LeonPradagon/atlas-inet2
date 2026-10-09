export function PageHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) {
  return <div className="content-heading d-flex flex-wrap align-items-center justify-content-between gap-3 mb-4">
    <div><h1>{title}</h1><p className="text-secondary mb-0">{subtitle}</p></div>{action}
  </div>
}
