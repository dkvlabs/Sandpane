# Sandpane — development tasks
#
# `make check` runs everything verifiable on the current host. Client targets
# light up as their directories land (see docs/CHANGELOG.md); until then the
# aggregate target only includes what exists and is verified.

CARGO ?= cargo
NPM ?= npm

.PHONY: check core-check core-fmt core-clippy core-test vscode-check desktop-check jetbrains-check schema-lint schema-drift clean

## Everything currently verifiable on this host.
check: core-check schema-lint schema-drift
	@echo "make check: OK (core + schemas). vscode/desktop/jetbrains targets exist but are not yet part of 'check' until their phases land — run them explicitly."

core-check: core-fmt core-clippy core-test

core-fmt:
	cd core && $(CARGO) fmt --check

core-clippy:
	cd core && $(CARGO) clippy --all-targets -- -D warnings

core-test:
	cd core && $(CARGO) test

vscode-check:
	@test -d clients/vscode || { echo "clients/vscode: phase not landed"; exit 1; }
	cd clients/vscode && $(NPM) run typecheck && $(NPM) test

desktop-check:
	@test -d apps/desktop || { echo "apps/desktop: phase not landed"; exit 1; }
	cd apps/desktop && $(NPM) run typecheck && $(NPM) test

jetbrains-check:
	@test -d clients/jetbrains || { echo "clients/jetbrains: phase not landed"; exit 1; }
	cd clients/jetbrains && ./gradlew build --console=plain

## JSON syntax check for the protocol schemas.
schema-lint:
	@for f in schemas/*.schema.json; do python3 -m json.tool "$$f" >/dev/null || exit 1; done
	@echo "schemas: JSON syntax OK"

## Value-set drift gate (the enforceable half of specs/08 §6 "schema/codegen
## drift"): Rust protocol crate is source of truth; schemas/ must match its
## exact wire value sets. Generated TS/Kotlin bindings remain P1/P7.
schema-drift:
	python3 scripts/schema_drift.py

clean:
	cd core && $(CARGO) clean
