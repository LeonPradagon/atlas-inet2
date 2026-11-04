export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="content-heading d-flex align-items-center justify-content-between mb-4 flex-wrap gap-3">
      <div>
        <h1>{title}</h1>
        <p className="text-secondary mb-0">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
