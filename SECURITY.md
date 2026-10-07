# Security

This program keeps one encrypted record per NoirWire wallet on a private rollup, and one account that pays the rent for all of them. It holds no user funds. If you find a way to read, change or delete a record that is not yours, or to spend the rent account, please tell us privately before telling anyone else.

## Reporting a vulnerability

Email **ph1l1ph@proton.me**.

Include what you found, how to reproduce it, and what an attacker gains. A proof of concept helps. Please do not open a public issue, and do not test against records or accounts that are not yours.

You will get an acknowledgement, and we will keep you informed while we work on a fix. We will credit you when the fix ships unless you would rather we did not.

## What matters most

- Anything that lets a key other than the owner's write, replace or close a profile.
- Anything that lets a key other than the owner's read a profile through the private endpoint.
- Anything that spends or drains the sponsor without the gate's signature, or pays it out to anyone but its admin.
- Anything that lets someone other than the upgrade authority set up the sponsor, or someone other than the admin change its settings.

The same contact is embedded in the deployed program as a `security.txt` section, readable with [query-security-txt](https://github.com/neodyme-labs/solana-security-txt).
