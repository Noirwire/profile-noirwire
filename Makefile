# Everything this repository does goes through here.
#
#   make install        install the test dependencies
#   make build          compile the program and its interface file
#   make test           build, then run the tests against a fresh local network
#   make stack          start the local network and leave it running
#   make check          format, lint and type checks, as CI runs them
#   make format         fix formatting
#   make audit          check the Rust dependencies against known advisories
#   make verify-build   build the program reproducibly, in a container
#   make clean          remove the local network and build leftovers
#
# The local network is a Solana validator, a private rollup and its query
# filter:  client -> query filter (6699) -> rollup (7799) -> Solana (8899).
# Everything it writes lives under .localnet, which git ignores.

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

# The Anchor version this program is built with. Where avm has it installed
# it is used directly, whatever version avm currently points at.
ANCHOR_VERSION := 1.0.2
AVM_ANCHOR := $(HOME)/.avm/bin/anchor-$(ANCHOR_VERSION)
ANCHOR ?= $(if $(wildcard $(AVM_ANCHOR)),$(AVM_ANCHOR),anchor)

LOCALNET := .localnet
PROGRAM_ID := $(shell sed -n 's/^noirwire_profile = "\(.*\)"/\1/p' Anchor.toml)
PROGRAM_SO := target/deploy/noirwire_profile.so
ADMIN_KEY := $(LOCALNET)/admin.json
STACK_LOG := $(LOCALNET)/stack.log
STACK_READY := MagicBlock stack is ready
LOCAL_VALIDATOR := mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev
TESTS := tests/profile.test.ts

# The stack runs from inside .localnet, so its paths are relative to there.
# The program is loaded at its declared address with a throwaway key as its
# upgrade authority, so no real key is ever needed to test.
STACK = cd $(LOCALNET) && exec npx mb-stack --reset --ledger ledger \
	--account $(LOCAL_VALIDATOR) ../tests/fixtures/local-validator-identity.json \
	--upgradeable-program $(PROGRAM_ID) ../$(PROGRAM_SO) \
		$$(solana-keygen pubkey admin.json)

.PHONY: help install build fresh stack test check format audit verify-build clean

help:
	@grep -E '^#( |$$)' Makefile | sed -E 's/^# ?//' | sed '/^The Anchor version/,$$d'

install:
	npm ci

# The program's address is the one it declares. Its keypair is needed only
# to deploy and is not in this repository, so the build does not look for it.
build:
	$(ANCHOR) build --ignore-keys

$(ADMIN_KEY):
	mkdir -p $(LOCALNET)
	solana-keygen new --no-bip39-passphrase --silent --outfile $@

# A fresh network every time: state left in the rollup by an earlier run
# would disagree with a Solana ledger that was just reset.
fresh: build $(ADMIN_KEY)
	rm -rf $(LOCALNET)/ledger $(LOCALNET)/magicblock-test-storage

stack: fresh
	$(STACK)

test: fresh
	( $(STACK) ) > $(STACK_LOG) 2>&1 & stack=$$!; \
	trap 'kill $$stack 2>/dev/null || true; wait $$stack 2>/dev/null || true' EXIT; \
	for _ in $$(seq 1 180); do \
		grep -q "$(STACK_READY)" $(STACK_LOG) && break; \
		kill -0 $$stack 2>/dev/null || { cat $(STACK_LOG) >&2; exit 1; }; \
		sleep 1; \
	done; \
	grep -q "$(STACK_READY)" $(STACK_LOG) || { cat $(STACK_LOG) >&2; exit 1; }; \
	npx ts-mocha -p ./tsconfig.json -t 120000 $(TESTS)

check:
	cargo fmt --all -- --check
	cargo clippy --locked --all-targets -- -D warnings
	npx prettier --check .
	npx tsc --noEmit -p tsconfig.json

format:
	cargo fmt --all
	npx prettier --write .

# Needs cargo-audit (cargo install cargo-audit --locked).
audit:
	cargo audit

# Needs Docker and solana-verify (cargo install solana-verify --locked).
# The hash it prints is the one to compare with the deployed program.
verify-build:
	solana-verify build --library-name noirwire_profile
	solana-verify get-executable-hash $(PROGRAM_SO)

clean:
	rm -rf $(LOCALNET) target/debug target/release target/sbpf-solana-solana
