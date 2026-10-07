# profile-noirwire

The on-chain program that keeps a NoirWire wallet's own labels (portfolio names, icons, colours, watchlist) so they come back when the recovery phrase is restored on another device.

NoirWire is a non-custodial Solana wallet. One recovery phrase derives a funding wallet and separate portfolios, and the keys never leave the device.

- The record is encrypted on the device before it is written. This program only ever stores ciphertext.
- Each record belongs to a key derived from the recovery phrase for this purpose only. It is not the funding wallet and not a portfolio.
- The program runs on MagicBlock's Private Ephemeral Rollup, where only the owner's key may read the record.
- It holds no money and is not part of any payment or trade.

## Status

Empty. The program has not been written yet.

## Licence

Published so anyone can read what runs. See [LICENSE](LICENSE) for what you may do with it.
