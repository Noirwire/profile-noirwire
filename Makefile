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
#   make devnet-setup   make the gate key, set up, fund and delegate the sponsor
#   make devnet-status  show the sponsor on Solana and on the rollup
#   make devnet-smoke   prove create, read, write and close on the live rollup
#   make devnet-canary  check the profile the smoke run left open is still there
#
# The local network is a Solana validator, a private rollup and its query
# filter:  client -> query filter (6699) -> rollup (7799) -> Solana (8899).
# Everything it writes lives under .localnet, which git ignores.

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

# The Anchor version this program is built with, the same as the anchor-lang
# crate. Where avm has it installed it is used directly, whatever version avm
# currently points at. Any other version is refused, not quietly used.
ANCHOR_VERSION := 1.2.1
AVM_ANCHOR := $(HOME)/.avm/bin/anchor-$(ANCHOR_VERSION)
ANCHOR ?= $(if $(wildcard $(AVM_ANCHOR)),$(AVM_ANCHOR),anchor)
SBPF_ARCH := v0
SOLANA_VERIFY_VERSION := 0.5.2
# The build image the reproducible build runs in. The image for the Solana
# version the tests use carries a Cargo too old for this program.
VERIFY_IMAGE := solanafoundation/solana-verifiable-build:3.1.14

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

.PHONY: help install build pinned-anchor fresh stack test check format audit verify-build clean \
	devnet-setup devnet-status devnet-smoke devnet-canary

help:
	@grep -E '^#( |$$)' Makefile | sed -E 's/^# ?//' | sed '/^The Anchor version/,$$d'

install:
	npm ci

# The program's address is the one it declares. Its keypair is needed only
# to deploy and is not in this repository, so the build does not look for it.
#
# Anchor $(ANCHOR_VERSION) builds for the newest program format (v3) unless
# told otherwise. The local validators do not load it ("Program is not
# deployed"), so the format every validator loads is asked for by name.
build: pinned-anchor
	$(ANCHOR) build --ignore-keys --arch $(SBPF_ARCH)

pinned-anchor:
	@[ "$$($(ANCHOR) --version 2>/dev/null)" = "anchor-cli $(ANCHOR_VERSION)" ] || { \
		echo "This program builds with Anchor $(ANCHOR_VERSION) only: run 'avm install $(ANCHOR_VERSION)'." >&2; exit 1; }

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

# Needs Docker and solana-verify at the pinned version
# (cargo install solana-verify --locked --version 0.5.2).
# The hash it prints is the one to compare with the deployed program.
verify-build:
	@[ "$$(solana-verify --version 2>/dev/null)" = "solana-verify $(SOLANA_VERIFY_VERSION)" ] || { \
		echo "This build is verified with solana-verify $(SOLANA_VERIFY_VERSION) only: run 'cargo install solana-verify --locked --version $(SOLANA_VERIFY_VERSION)'." >&2; exit 1; }
	solana-verify build --library-name noirwire_profile --arch $(SBPF_ARCH) --base-image $(VERIFY_IMAGE)
	solana-verify get-executable-hash $(PROGRAM_SO)

# A deployment on a public network is operated by ops/network.ts, which is
# told the network through these variables and checks the genesis hash and
# the rollup's identity before it sends anything. Keys live under .keys,
# which git ignores: <network>-admin.json is put there by hand, the gate and
# the canary keys are made on first use. Only devnet is wired up.
OPS := node_modules/.bin/ts-node -P tsconfig.json ops/network.ts
IDL := target/idl/noirwire_profile.json
DEVNET := NETWORK=devnet KEYS_DIR=.keys \
	SOLANA_URL=https://api.devnet.solana.com \
	GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG \
	ROLLUP_URL=https://devnet-tee.magicblock.app \
	VALIDATOR=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo \
	SPONSOR_FLOAT_LAMPORTS=50000000 MAX_DATA_LEN=2048

$(IDL):
	$(MAKE) build

devnet-setup devnet-status devnet-smoke devnet-canary: devnet-%: $(IDL)
	@$(DEVNET) $(OPS) $*

clean:
	rm -rf $(LOCALNET) target/debug target/release target/sbpf-solana-solana
