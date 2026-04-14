import { exec } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import util from 'node:util'

const execFn = util.promisify(exec)

const PROJECT_ROOT = join(process.env.HOME, 'projects')
const WORKSPACE_ROOT = join(PROJECT_ROOT, 'starter-workspace')

const TARGET_REPOS = ['travelist-monorepo', 'hulyo-monorepo', 'sandbox-workspace', 'infra-kit', 'nomadream-monorepo']

const EXCLUDED_PATTERNS = ['node_modules', 'dist', '*.tsbuildinfo', '.turbo', '.eslintcache']

// Configuration for files and folders to copy
const COPY_CONFIG = [
  {
    name: 'Claude code configs',
    source: '.claude',
    target: '.claude',
    type: 'directory',
  },
  {
    name: 'MCPs for Cursor',
    source: '.cursor/mcp.json',
    target: '.cursor/mcp.json',
    type: 'file',
  },
  {
    name: 'MCPs for Claude',
    source: '.mcp.json',
    target: '.mcp.json',
    type: 'file',
  },
  {
    name: 'Cursor rules',
    source: '.cursor/rules',
    target: '.cursor/rules',
    type: 'directory',
  },
  {
    name: 'Make scripts',
    source: 'Makefile',
    target: 'Makefile',
    type: 'file',
  },
  {
    name: 'Web-toolkit',
    source: 'packages/web-toolkit',
    target: 'packages/web-toolkit',
    type: 'directory',
  },
  {
    name: 'VsCode extensions',
    source: '.vscode/extensions.json',
    target: '.vscode/extensions.json',
    type: 'file',
  },
  {
    name: 'VsCode snippets',
    source: '.vscode/global.code-snippets',
    target: '.vscode/global.code-snippets',
    type: 'file',
  },
  {
    name: 'VsCode settings',
    source: '.vscode/settings.json',
    target: '.vscode/settings.json',
    type: 'file',
  },
  {
    name: 'Prettier config',
    source: '.prettierrc.mjs',
    target: '.prettierrc.mjs',
    type: 'file',
  },
  {
    name: 'Prettier ignore',
    source: '.prettierignore',
    target: '.prettierignore',
    type: 'file',
  },
  {
    name: 'NPM config',
    source: '.npmrc',
    target: '.npmrc',
    type: 'file',
  },
  {
    name: 'Node version',
    source: '.node-version',
    target: '.node-version',
    type: 'file',
  },
  {
    name: 'Git ignore',
    source: '.gitignore',
    target: '.gitignore',
    type: 'file',
  },
  {
    name: 'Editor config',
    source: '.editorconfig',
    target: '.editorconfig',
    type: 'file',
  },
  {
    name: 'Infra Kit config',
    source: 'infra-kit.yml',
    target: 'infra-kit.yml',
    type: 'file',
  },
  {
    name: 'Vitest config',
    source: 'vitest.config.ts',
    target: 'vitest.config.ts',
    type: 'file',
  },
  {
    name: 'Skills lock',
    source: 'skills-lock.json',
    target: 'skills-lock.json',
    type: 'file',
  },
  {
    name: 'Agents',
    source: '.agents',
    target: '.agents',
    type: 'directory',
  },
  {
    name: 'Turbo config',
    source: 'turbo.json',
    target: 'turbo.json',
    type: 'file',
  },
  {
    name: 'Configs',
    source: 'configs',
    target: 'configs',
    type: 'directory',
  },
  {
    name: 'Deploy and E2E scripts lib',
    source: 'devops/scripts/lib',
    target: 'devops/scripts/lib',
    type: 'directory',
  },
  {
    name: 'Lib BE Dev',
    source: 'packages/lib-be-dev',
    target: 'packages/lib-be-dev',
    type: 'directory',
  },
  {
    name: 'GH Workflow: Cache Node Modules',
    source: '.github/workflows/_cache-nodemodules-jobs.yml',
    target: '.github/workflows/_cache-nodemodules-jobs.yml',
    type: 'file',
  },
  {
    name: 'GH Workflow: Code Quality Jobs',
    source: '.github/workflows/_code-quality-jobs.yml',
    target: '.github/workflows/_code-quality-jobs.yml',
    type: 'file',
  },
  {
    name: 'GH Workflow: Deploy Media Jobs',
    source: '.github/workflows/_deploy-media-jobs.yml',
    target: '.github/workflows/_deploy-media-jobs.yml',
    type: 'file',
  },
  {
    name: 'GH Workflow: Notify Success Jobs',
    source: '.github/workflows/_notify-success-jobs.yml',
    target: '.github/workflows/_notify-success-jobs.yml',
    type: 'file',
  },
  {
    name: 'GH Workflow: Playwright Jobs',
    source: '.github/workflows/_playwright-jobs.yml',
    target: '.github/workflows/_playwright-jobs.yml',
    type: 'file',
  },
  {
    name: 'GH Workflow: Terraform Apply Infrastructure',
    source: '.github/workflows/_terraform-apply-infrastructure-jobs.yml',
    target: '.github/workflows/_terraform-apply-infrastructure-jobs.yml',
    type: 'file',
  },
  {
    name: 'GH Workflow: Code Quality',
    source: '.github/workflows/code-quality.yml',
    target: '.github/workflows/code-quality.yml',
    type: 'file',
  },
]

const copyDirectory = async (source, target, displayTarget) => {
  if (!existsSync(source)) {
    console.log(`⚠️  Source directory does not exist: ${source}`)
    return false
  }

  try {
    // Remove target directory if it exists to avoid nested copying
    if (existsSync(target)) {
      await execFn(`rm -rf "${target}"`)
    }

    const excludeFlags = EXCLUDED_PATTERNS.map((p) => `--exclude='${p}'`).join(' ')
    await execFn(`rsync -a ${excludeFlags} "${source}/" "${target}/"`)

    console.log(`✅ Copied: ${displayTarget}`)

    return true
  } catch (error) {
    console.log(`❌ Failed to copy: ${displayTarget}`)
    console.error(error.message)
    return false
  }
}

const copyFile = async (source, target, displayTarget) => {
  if (!existsSync(source)) {
    console.log(`⚠️  Source file does not exist: ${source}`)

    return false
  }

  try {
    const targetDir = dirname(target)

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true })
    }

    await execFn(`cp "${source}" "${target}"`)
    console.log(`✅ Copied: ${displayTarget}`)

    return true
  } catch (error) {
    console.log(`❌ Failed to copy: ${displayTarget}`)
    console.error(error.message)
    return false
  }
}

const main = async () => {
  console.log('🚀 Starting AI Rules and Settings Copy Process...\n')

  let successCount = 0
  let totalCount = 0

  for (const repo of TARGET_REPOS) {
    const targetRoot = `${PROJECT_ROOT}/${repo}`

    console.log(`📦 Processing repository: ${repo}`)

    // Check if target repository exists
    if (!existsSync(targetRoot)) {
      console.log(`⚠️  Target repository does not exist: ${targetRoot}`)
      continue
    }

    // Process each item in the copy configuration
    for (const item of COPY_CONFIG) {
      const sourcePath = join(WORKSPACE_ROOT, item.source)
      const targetPath = join(targetRoot, item.target)

      totalCount++
      let success = false

      if (item.type === 'directory') {
        success = await copyDirectory(sourcePath, targetPath, item.target)
      }

      if (item.type === 'file') {
        success = await copyFile(sourcePath, targetPath, item.target)
      }

      if (success) {
        successCount++
      }
    }

    console.log('') // Empty line for readability
  }

  console.log('📊 Copy Process Summary:')
  console.log(`✅ Successful copies: ${successCount}/${totalCount}`)
  if (successCount < totalCount) {
    console.log(`❌ Failed copies: ${totalCount - successCount}/${totalCount}`)
  }

  if (successCount === totalCount) {
    console.log('🎉 All files copied successfully!')
  } else {
    console.log('⚠️  Some files failed to copy. Check the output above for details.')
  }
}

// Run the main function
main().catch((error) => {
  console.error('💥 Script failed with error:', error)
  process.exit(1)
})
