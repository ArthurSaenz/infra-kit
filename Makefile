help:
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)


##@ Setup (install and bootstrap)

setup:	## Install node, all dependencies and built the artifacts
	pnpm run setup

reinstall:	## Clear cache and reinstall all dependencies and rebuild artifacts
	pnpm run reinstall

packages-build:	## Build all packages
	pnpm run packages-build

clean-artifacts:	## Clean dist (artifacts) in all packages
	pnpm run clean-artifacts

clean-cache:	## Clean all caches and into the root
	pnpm run clean-cache-root

dedupe-deps:	## Dedupe deps in workspace
	pnpm run dedupe-deps

upgrade-deps:	##  Upgrade deps in workspace
	pnpm run upgrade-deps

upgrade-pnpm:	## Upgrade pnpm to last version
	pnpm run upgrade-pnpm

print-env-node:	## Print remotely available Node.js versions
	pnpm run print-env-node

install-pnpm:	## Install pnpm to last version
	pnpm run install-pnpm


##@ General

info:	## This command will output all the versions of packages that are installed
	pnpm list

dx-help:	## List all commands of infra-kit
	pnpm run dx-help

dx-doctor:	## Run infra-kit doctor diagnostics
	pnpm run dx-doctor

dx-init:	## Initialize infra-kit configuration
	pnpm run dx-init

dx-env-load:	## Load environment variables
	pnpm run dx-env-load

dx-env-clear:	## Clear environment variables
	pnpm run dx-env-clear

dx-env-status:	## Show current environment status
	pnpm run dx-env-status

dx-env-list:	## List available environments
	pnpm run dx-env-list

dx-merge-dev:	## Merge dev branch into every release branch
	pnpm run dx-merge-dev

dx-release-list:	## List all releases
	pnpm run dx-release-list

dx-release-create:	## Create release branch with pull request in github
	pnpm run dx-release-create

dx-release-create-batch:	## Create multiple release branches (batch operation) with pull request in github
	pnpm run dx-release-create-batch

dx-release-deliver:	## Deliver release to production
	pnpm run dx-release-deliver

dx-release-deploy-all:	## Deploy release to any environment
	pnpm run dx-release-deploy-all

dx-release-deploy-selected:	## Deploy selected services in release to any environment
	pnpm run dx-release-deploy-selected

dx-worktrees-list:	## List all worktrees
	pnpm run dx-worktrees-list

dx-worktrees-sync:	## Sync worktrees
	pnpm run dx-worktrees-sync

dx-worktrees-add:	## Add worktree
	pnpm run dx-worktrees-add

dx-worktrees-remove:	## Remove worktree
	pnpm run dx-worktrees-remove


##@ Code quality

prettier-fix:	## Launch prettier with format all files
	pnpm run prettier-fix

prettier-check:	## Launch prettier only check files. Without formatting files
	pnpm run prettier-check

eslint-fix:	## Launch combine script for all fixing. That script must be contain the eslint --fix
	pnpm run eslint-fix

eslint-check:	## Launch eslint linting (with cache .eslintcache)
	pnpm run eslint-check

ts-check:	## Launch Typescript compiler with --check flag
	pnpm run ts-check

test:	## Launch all tests
	pnpm run test

test-watch:	## Launch all unit tests in watch mode
	pnpm run test-watch

test-report:	## Launch test-report script with vitest run --coverage
	pnpm run test-report

test-ui:	## Launch UI vitest dashboard
	pnpm run test-ui

qa:	## Launch combine script with all testing scripts: from eslint to vitest
	pnpm run qa

fix:	## Launch all possible fixes to pass qa command
	pnpm run fix
