#!/bin/sh

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    printf "${BLUE}[INFO]${NC} %s\n" "$1"
}

log_success() {
    printf "${GREEN}[SUCCESS]${NC} %s\n" "$1"
}

# Main execution flow
main() {
    log_info "=== Set up relayer ==="

    NO_START=true ./docker-entrypoint.sh

    log_success "=== Relayer setup complete ==="

    log_info "=== Starting Polytone Keepalive ==="

    node node_modules/.bin/vite-node keepalive-rly.ts
}

# Handle signals gracefully
trap 'log_info "Shutting down polytone-keepalive..."; exit 0' SIGTERM SIGINT

# Run main function
main "$@"
