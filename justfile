default:
    @just --list

# Install locked dependencies and Git hooks.
install:
    pnpm install --frozen-lockfile

# Compile the extension with TypeScript 7.
build:
    pnpm build

# Recompile on source changes.
watch:
    pnpm watch

lint:
    pnpm lint

fix:
    pnpm lint:fix
    pnpm format

format:
    pnpm format

typecheck:
    pnpm typecheck

# Run the same quality checks as CI.
check:
    pnpm check

# Produce a local VSIX.
package:
    pnpm package

hooks:
    pnpm hooks

clean:
    node -e 'require("node:fs").rmSync("dist", { recursive: true, force: true })'

# Run Git integration tests against temporary repositories.
test:
    pnpm test
