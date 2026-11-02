# Start here: `make dev` installs, builds every package, and runs the playground.
.PHONY: dev build install test clean

dev: build
	bun run --cwd apps/playground dev

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
