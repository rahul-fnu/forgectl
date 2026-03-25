#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FAILED=0

build_and_test() {
    local dockerfile="$1"
    local tag="$2"
    shift 2
    local checks=("$@")

    echo "=== Building $dockerfile ==="
    if ! docker build -f "$SCRIPT_DIR/$dockerfile" -t "$tag" "$SCRIPT_DIR"; then
        echo "FAIL: $dockerfile build failed"
        FAILED=1
        return
    fi

    for cmd in "${checks[@]}"; do
        echo "  Checking: $cmd"
        if ! docker run --rm "$tag" sh -c "$cmd"; then
            echo "  FAIL: $cmd"
            FAILED=1
        fi
    done
    echo "=== $dockerfile OK ==="
    echo
}

build_and_test Dockerfile.code-python312 forgectl-test-python312 \
    "python --version" \
    "node --version" \
    "claude --version" \
    "rg --version" \
    "fdfind --version || fd --version" \
    "poetry --version" \
    "pytest --version" \
    "ruff --version" \
    "mypy --version"

build_and_test Dockerfile.code-go122 forgectl-test-go122 \
    "go version" \
    "node --version" \
    "claude --version" \
    "rg --version" \
    "fdfind --version || fd --version" \
    "golangci-lint --version" \
    "gopls version" \
    "dlv version"

build_and_test Dockerfile.code-rust forgectl-test-rust \
    "rustc --version" \
    "cargo --version" \
    "node --version" \
    "claude --version" \
    "rg --version" \
    "fdfind --version || fd --version" \
    "cargo clippy --version" \
    "cargo nextest --version"

if [ "$FAILED" -ne 0 ]; then
    echo "Some tests FAILED"
    exit 1
fi

echo "All Dockerfile tests passed"
