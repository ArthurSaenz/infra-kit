#!/bin/bash

# Shared deployment utilities for monorepo
# This library provides reusable functions for backend and frontend deployments

set -e

# Disable AWS CLI pager to prevent hanging
export AWS_PAGER=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Run a command with logging and error checking
# Usage: run_command "description" "command to run"
run_command() {
    local description="$1"
    local command="$2"

    echo "COMMAND: $command"
    eval "$command"
    if [ $? -ne 0 ]; then
        echo "${RED}Error: $description failed${NC}"
        exit 1
    fi
}

# Retry a command with exponential backoff and jitter
# Usage: retry_with_backoff "description" "command" [max_retries] [initial_delay_seconds]
retry_with_backoff() {
    local description="$1"
    local command="$2"
    local max_retries="${3:-5}"
    local delay="${4:-2}"

    echo "COMMAND: $command"
    for attempt in $(seq 1 "$max_retries"); do
        if eval "$command"; then
            return 0
        fi

        if [ "$attempt" -eq "$max_retries" ]; then
            echo "${RED}Error: $description failed after $max_retries attempts${NC}"
            exit 1
        fi

        # Exponential backoff with jitter: delay * 2^(attempt-1) + random 0-3s
        local backoff=$(( delay * (1 << (attempt - 1)) + ${RANDOM:-0} % 4 ))
        echo "${YELLOW}Attempt $attempt/$max_retries failed. Retrying in ${backoff}s...${NC}"
        sleep "$backoff"
    done
}

# Install required tools (turbo and optionally serverless)
# Usage: setup_tools [include_serverless]
setup_tools() {
    local include_serverless="${1:-true}"

    if [ "$include_serverless" = "true" ]; then
        run_command "Install turbo and serverless" "pnpm add -g turbo@2.9.5 serverless@3.39.0"
    else
        run_command "Install turbo" "pnpm add -g turbo@2.9.5"
    fi
}

# Prune monorepo to specific app and build it
# Usage: prune_and_build "app-name" "true|false"
# Args:
#   app-name: The turbo workspace name (e.g., backend-api, backoffice-api)
#   install_prod: Whether to install production dependencies with hoisted linker
prune_and_build() {
    local app_name="$1"
    local install_prod="${2:-false}"

    # Clean output directory
    run_command "Clean output directory" "rm -rf ./out && mkdir ./out"

    # Prune to specific app
    run_command "Prune to $app_name" "turbo prune $app_name"

    # Navigate to output directory
    echo "COMMAND: cd ./out"
    cd ./out

    # Install dependencies
    run_command "Install dependencies" "pnpm install"

    # Build the app
    run_command "Build $app_name" "pnpm exec turbo build --filter=$app_name --env-mode=loose"

    # Install production dependencies if requested
    if [ "$install_prod" = "true" ]; then
        run_command "Clean node_modules" "rm -rf ./node_modules"
        run_command "Install production dependencies" "pnpm install --frozen-lockfile --node-linker=hoisted --prod"
        run_command "Show node_modules size" "du -sm ./node_modules/ | awk '{print \$1 \" MB\"}'"
    fi
}

# Deploy backend API using Serverless Framework
# Usage: deploy_backend_api "deploy-stage" "app-name" "app-path" "api-gateway-id" [post_deploy_function]
# Args:
#   deploy-stage: The deployment stage (e.g., dev, staging, production)
#   app-name: The turbo workspace name (e.g., backend-api, backoffice-api)
#   app-path: Path to the API app relative to ./out (e.g., apps/client/api)
#   api-gateway-id: The API Gateway ID variable value
#   post-deploy-function: Optional callback function to run after deployment
deploy_backend_api() {
    local deploy_stage="$1"
    local app_name="$2"
    local app_path="$3"
    local api_gateway_id="$4"
    local post_deploy_function="${5:-}"

    # Setup tools
    setup_tools "true"

    # Prune and build with production dependencies
    prune_and_build "$app_name" "true"

    # Navigate to app directory
    run_command "Navigate to $app_path" "cd ./$app_path"

    # Deploy with serverless
    run_command "Deploy with Serverless" "serverless deploy --stage $deploy_stage --force"

    # Create API Gateway deployment ONLY if api_gateway_id is provided
    if [ -n "$api_gateway_id" ]; then
        retry_with_backoff "Create API Gateway deployment" "aws apigateway create-deployment --rest-api-id $api_gateway_id --stage-name api" 5 2
    else
        echo "${YELLOW}Skipping API Gateway deployment for $app_name as no api_gateway_id was provided.${NC}"
    fi

    # Run post-deployment hooks if provided
    if [ -n "$post_deploy_function" ]; then
        echo "${YELLOW}Checking for post-deployment function: $post_deploy_function${NC}"

        # Check if function exists (POSIX-compatible)
        if type "$post_deploy_function" >/dev/null 2>&1; then
            echo "${GREEN}Running post-deployment hooks...${NC}"
            export DEPLOY_STAGE="$deploy_stage"

            # Call the post-deploy function and check for errors
            if $post_deploy_function; then
                echo "${GREEN}Post-deployment hooks completed successfully${NC}"
            else
                echo "${RED}Error: Post-deployment hooks failed${NC}"
                exit 1
            fi
        else
            echo "${RED}Error: Post-deployment function '$post_deploy_function' not found${NC}"
            echo "${YELLOW}Function check output:${NC}"
            type "$post_deploy_function" 2>&1 || echo "Function not found"
            exit 1
        fi
    fi
}

# Deploy frontend UI to S3 and invalidate CloudFront
# Usage: deploy_frontend_ui "app-name" "app-path" "s3-bucket" "cloudfront-id" "s3-source-path" "s3-sync-flags" "s3-dest-path" "cf-invalidation-path" [post_deploy_function]
# Args:
#   app-name: The turbo workspace name (e.g., website-ui, backoffice-ui)
#   app-path: Path to the UI app relative to ./out (e.g., apps/client/ui)
#   s3-bucket: The S3 bucket variable value
#   cloudfront-id: The CloudFront distribution ID variable value
#   s3-source-path: Source path for S3 sync (e.g., ./dist or ./dist/client)
#   s3-sync-flags: Additional flags for S3 sync (e.g., "--delete", "--cache-control max-age=3600")
#   s3-dest-path: Optional S3 destination subfolder (e.g., "/mfe" - default: "" for root)
#   cf-invalidation-path: Optional CloudFront invalidation path (default: "/*")
#   post-deploy-function: Optional callback function to run after deployment
deploy_frontend_ui() {
    local app_name="$1"
    local app_path="$2"
    local s3_bucket="$3"
    local cloudfront_id="$4"
    local s3_source_path="${5:-./dist}"
    local s3_sync_flags="${6:-}"
    local s3_dest_path="${7:-}"
    local cf_invalidation_path="${8:-/*}"
    local post_deploy_function="${9:-}"

    # Setup tools (turbo only, no serverless needed)
    setup_tools "false"

    # Prune and build without production dependencies
    prune_and_build "$app_name" "false"

    # Navigate to app directory
    run_command "Navigate to $app_path" "cd ./$app_path"

    # Sync to S3 (with optional destination path)
    local s3_destination="s3://$s3_bucket$s3_dest_path"
    run_command "Sync to S3" "aws s3 sync $s3_source_path $s3_destination $s3_sync_flags --only-show-errors"

    # Invalidate CloudFront
    run_command "Invalidate CloudFront" "aws cloudfront create-invalidation --distribution-id $cloudfront_id --paths \"$cf_invalidation_path\""

    # Run post-deployment hooks if provided
    if [ -n "$post_deploy_function" ]; then
        echo "${YELLOW}Checking for post-deployment function: $post_deploy_function${NC}"

        # Check if function exists (POSIX-compatible)
        if type "$post_deploy_function" >/dev/null 2>&1; then
            echo "${GREEN}Running post-deployment hooks...${NC}"
            # export DEPLOY_STAGE="$deploy_stage"

            # Call the post-deploy function and check for errors
            if $post_deploy_function; then
                echo "${GREEN}Post-deployment hooks completed successfully${NC}"
            else
                echo "${RED}Error: Post-deployment hooks failed${NC}"
                exit 1
            fi
        else
            echo "${RED}Error: Post-deployment function '$post_deploy_function' not found${NC}"
            echo "${YELLOW}Function check output:${NC}"
            type "$post_deploy_function" 2>&1 || echo "Function not found"
            exit 1
        fi
    fi
}
