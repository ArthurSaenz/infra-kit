#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Validate required E2E_DOMAIN variable
if [ -z "$E2E_DOMAIN" ]; then
    echo -e "${RED}Error: E2E_DOMAIN environment variable is required (e.g., google.com)${NC}"
    exit 1
fi

# Setup tools for E2E testing
setup_e2e_tools() {
    echo -e "${GREEN}Setting up E2E tools...${NC}"
    pnpm install --frozen-lockfile
}

# Install Playwright browsers for a specific project
install_playwright_browsers() {
    local project=$1
    echo -e "${GREEN}Installing Playwright browsers for e2e-${project}...${NC}"
    pnpm --filter=e2e-${project} playwright-install
}

# Get BASE_URL based on environment and project
get_base_url() {
    local env=$1
    local project=$2

    local subdomain=""
    if [ "$project" != "client" ]; then
        subdomain="${project}."
    fi

    if [ "$env" = "prod" ]; then
        echo "https://${subdomain}${E2E_DOMAIN}"
    else
        echo "https://${subdomain}${env}.${E2E_DOMAIN}"
    fi
}

# Run E2E tests for a project
run_e2e_tests() {
    local project=$1
    local environment=$2

    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Running E2E tests for: ${project}${NC}"
    echo -e "${GREEN}Environment: ${environment}${NC}"
    echo -e "${GREEN}========================================${NC}"

    # Get the base URL
    local base_url=$(get_base_url "$environment" "$project")
    echo -e "${YELLOW}BASE_URL: ${base_url}${NC}"

    # Install Playwright browsers
    install_playwright_browsers "$project"

    echo -e "${GREEN}Running Playwright tests...${NC}"
    pnpm --filter=e2e-${project} e2e-test

    echo -e "${GREEN}E2E tests completed for ${project}!${NC}"
}
