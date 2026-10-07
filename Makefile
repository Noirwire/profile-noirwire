# Everything this repository does goes through here.
#
#   make build     compile the program
#   make test      run the tests against a fresh local network
#   make stack     start the local network and leave it running
#   make check     format, lint and type checks, as CI runs them
#
# The local network is a Solana validator, a private rollup and its query
# filter:  client -> query filter (6699) -> rollup (7799) -> Solana (8899).
# Everything it writes lives under .localnet, which git ignores.

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

ANCHOR ?= anchor
LOCALNET := .localnet
PROGRAM_SO := target/deploy/noirwire_profile.so
PROGRAM_KEY := target/deploy/noirwire_profile-keypair.json
ADMIN_KEY := $(LOCALNET)/admin.json
STACK_LOG := $(LOCALNET)/stack.log
LOCAL_VALIDATOR := mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev
TESTS := tests/profile.test.ts

# The stack runs from inside .localnet, so its paths are relative to there.
STACK = cd $(LOCALNET) && exec npx mb-stack --reset --ledger ledger \
	--account $(LOCAL_VALIDATOR) ../tests/fixtures/local-validator-identity.json \
	--upgradeable-program \
		$$(solana-keygen pubkey ../$(PROGRAM_KEY)) \
		../$(PROGRAM_SO) \
		$$(solana-keygen pubkey admin.json)

.PHONY: help install build stack test check format clean

help:
	@grep -E '^#( |$$)' Makefile | sed -E 's/^# ?//'

install:
	npm ci

build:
	$(ANCHOR) build

$(PROGRAM_SO):
	$(ANCHOR) build

$(ADMIN_KEY):
	mkdir -p $(LOCALNET)
	solana-keygen new --no-bip39-passphrase --silent --outfile $@

# A fresh network every time: state left in the rollup by an earlier run
# would disagree with a Solana ledger that was just reset.
fresh: $(PROGRAM_SO) $(ADMIN_KEY)
	rm -rf $(LOCALNET)/ledger $(LOCALNET)/magicblock-test-storage
.PHONY: fresh

stack: fresh
	$(STACK)

test: fresh
	( $(STACK) ) > $(STACK_LOG) 2>&1 & stack=$$!; \
	trap 'kill $$stack 2>/dev/null || true; wait $$stack 2>/dev/null || true' EXIT; \
	for _ in $$(seq 1 180); do \
		grep -q "MagicBlock stack is ready" $(STACK_LOG) && break; \
		kill -0 $$stack 2>/dev/null || { cat $(STACK_LOG) >&2; exit 1; }; \
		sleep 1; \
	done; \
	grep -q "MagicBlock stack is ready" $(STACK_LOG) || { cat $(STACK_LOG) >&2; exit 1; }; \
	npx ts-mocha -p ./tsconfig.json -t 120000 $(TESTS)

check:
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings
	npx prettier --check .
	npx tsc --noEmit -p tsconfig.json

format:
	cargo fmt --all
	npx prettier --write .

clean:
	rm -rf $(LOCALNET) target/debug target/release target/sbpf-solana-solana
