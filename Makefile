# Start here: `make dev` installs, builds every package, and runs the playground.
.PHONY: dev build install test clean

dev: build
	bun run --cwd apps/playground dev

# The playground imports each package from its dist/, so always rebuild first;
# tsc -b only rebuilds what changed; if a dist/ was deleted by hand, its stale
# .tsbuildinfo would make tsc skip it, so drop those first. highlight also bundles
# its worker and grammars.
build: install
	@for d in packages/*/; do [ -d "$$d/dist" ] || rm -f "$$d"*.tsbuildinfo; done
	bunx tsc -b
	bun run --cwd packages/highlight build

install: node_modules/.make-stamp

node_modules/.make-stamp: bun.lock package.json $(wildcard packages/*/package.json apps/*/package.json)
	bun install
	@touch $@

test: build
	bun test

clean:
	rm -rf packages/*/dist apps/*/dist packages/*/*.tsbuildinfo apps/*/*.tsbuildinfo
