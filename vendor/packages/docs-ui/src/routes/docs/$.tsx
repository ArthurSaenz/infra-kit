import { useMDXComponents } from '@/components/mdx'
import { baseOptions } from '@/lib/layout-shared'
import { appName } from '@/lib/shared'
import { source } from '@/lib/source'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { staticFunctionMiddleware } from '@tanstack/start-static-server-functions'
import browserCollections from 'collections/browser'
import { useFumadocsLoader } from 'fumadocs-core/source/client'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page'
import { Suspense } from 'react'

export const Route = createFileRoute('/docs/$')({
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat?.split('/').filter(Boolean) ?? []
    const data = await serverLoader({ data: slugs })

    await clientLoader.preload(data.path)

    return data
  },
})

// Static server function: result is baked to a JSON asset at build time, so client-side
// navigation on the static (S3) site reads the cached file instead of calling a live server.
const serverLoader = createServerFn({ method: 'GET' })
  .middleware([staticFunctionMiddleware])
  .inputValidator((slugs: string[]) => {
    return slugs
  })
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs)

    if (!page) throw notFound()

    return {
      path: page.path,
      pageTree: await source.serializePageTree(source.getPageTree()),
    }
  })

const clientLoader = browserCollections.docs.createClientLoader({
  component({ toc, frontmatter, default: MDX }) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <DocsBody>
          <MDX components={useMDXComponents()} />
        </DocsBody>
      </DocsPage>
    )
  },
})

function Page() {
  const { path, pageTree } = useFumadocsLoader(Route.useLoaderData())

  return (
    <DocsLayout {...baseOptions(appName)} tree={pageTree}>
      <Suspense>{clientLoader.useContent(path)}</Suspense>
    </DocsLayout>
  )
}
