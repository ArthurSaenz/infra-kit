import { baseOptions } from '@/lib/layout-shared'
import { appName } from '@/lib/shared'
import { Link, createFileRoute } from '@tanstack/react-router'
import { HomeLayout } from 'fumadocs-ui/layouts/home'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <HomeLayout {...baseOptions(appName)}>
      <div className="flex flex-1 flex-col justify-center px-4 py-8 text-center">
        <h1 className="mb-2 text-2xl font-medium">{appName}</h1>
        <p className="text-fd-muted-foreground mb-6">Aggregated documentation from across the monorepo.</p>
        <Link
          to="/docs/$"
          params={{ _splat: '' }}
          className="bg-fd-primary text-fd-primary-foreground mx-auto rounded-lg px-3 py-2 text-sm font-medium"
        >
          Open Docs
        </Link>
      </div>
    </HomeLayout>
  )
}
