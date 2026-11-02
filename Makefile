# Start here: `make dev` installs, builds every package, and runs the playground.
.PHONY: dev web build install test clean

# The playground's predev runs build:packages, so dev only needs the install.
dev: install
	bun run --cwd apps/playground dev

# The zeta web client on http://localhost:5180 (start zeta with --ws-origin http://localhost:5180).
web: install
	bun run --cwd apps/web dev

# The playground imports each package from its dist/. The shared script drops stale
# build info when output is missing and also bundles highlight's worker and grammars.
build: install
	bun run build:packages

install: node_modules/.make-stamp

node_modules/.make-stamp: bun.lock package.json $(wildcard packages/*/package.json apps/*/package.json)
	bun install
	@touch $@

test: build
	bun test

clean:
	rm -rf packages/*/dist apps/*/dist packages/*/*.tsbuildinfo apps/*/*.tsbuildinfo
