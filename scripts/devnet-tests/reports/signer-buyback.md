# Signer buyback — live loop on devnet (Squads spending limit + DBC route)

_Generated 2026-10-16T11:40:22.656Z — devnet only._

## Setup

- Stand-in coin: mint [jBWbmpt8…](https://solscan.io/account/jBWbmpt8nvq9kp3ZVEYq4vKHC2BqQ9RVvdAX22G4qJy?cluster=devnet), pool [E3JWfTTk…](https://solscan.io/account/E3JWfTTku9NiX3jk5NPUHp2DzKqKYe96khhyJh9m129a?cluster=devnet), config [3inbkHpW…](https://solscan.io/account/3inbkHpWBhy6at6oN8SFNbTxEVvSdqbSRaxLdELc9sL5?cluster=devnet) ([createConfig t52nVEpA…](https://solscan.io/tx/t52nVEpA3KumAL4QYGmaEQ2uKcvuVcdY5hmmgBUfxTuLZ1uCX7D1ycYe6WKDzuHKKUaKH3JP4qGNdhtn2ZGDYPg?cluster=devnet), [createPool Fr5dZEfe…](https://solscan.io/tx/Fr5dZEfe3TYHWm7G7DGuU1zma1deeaoH5cE2sRxczw9TuyyqSdqcJXcGWVCBLusxzfJiAuzbrBfBb1CX4g5dvt2?cluster=devnet))
- Squads multisig [F3ENR9fJ…](https://solscan.io/account/F3ENR9fJJX8nQanvvMWzAmTXR8c3a3ZsnRQSbWauuWrE?cluster=devnet), vault 0 [4moRxAEG…](https://solscan.io/account/4moRxAEGQeakShDmtQVhGnP3WUxspNespz4ULwLznsG9?cluster=devnet) ([multisigCreateV2 42tM4ziL…](https://solscan.io/tx/42tM4ziLjxGoS3YeLj59snJgzcvAAeHdtMGenk2rUUfs7QguuxviHDHmKcjbQ8oS82Ro58nZ9xCmFgJWmx9cRUj9?cluster=devnet)); members: squadsCreator (all permissions, threshold 1), bot [HWAPCJTX…](https://solscan.io/account/HWAPCJTXipHh1EjcHc8R5bJVJxYhABqZdVLhrre5Njej?cluster=devnet) (no permission)
- Spending limit [Cxy9b51e…](https://solscan.io/account/Cxy9b51eZD5BMGht5GvBSHrrkhUqV3jv9RyzbSZFjcHq?cluster=devnet): SOL, Day, 50000000 lamports (0.05 SOL), members = [bot], destinations = [bot]; config transaction #1: [configTransactionCreate 34KXZNn7…](https://solscan.io/tx/34KXZNn7N9TfNZVQV8WgniBWi4dknruZmrRkB6miLekiZBF5JPZzbne1dm7WFFpopewFXjAHr122T5aGQBVteRvp?cluster=devnet), [proposalCreate 5YGpZ8Mt…](https://solscan.io/tx/5YGpZ8Mts7SEWHZmHU34HysikcjYhwvSehWojyrvrYtSpKVY7i7yqvsPJNUG7ccjSgGa7ggqJfUQu1WJyPVPQGTA?cluster=devnet), [proposalApprove TpKPH9op…](https://solscan.io/tx/TpKPH9opVjRk97uVpmkmSHkhqSs1SYEyxvr6PJAT87Royhwpvs2EnariYqn1eyrPsCYetUdjAkRYD5ZwXWB8Paa?cluster=devnet), [configTransactionExecute 1Jvw6ix5…](https://solscan.io/tx/1Jvw6ix52eX3gpfCVdYt4soFXvw69U1NTBVLBiMx4VbgH7VQX8WsyS16ApxuDTaAPBU8y3xSWbbGfLEFetEz2qg?cluster=devnet)
- Vault funded with 100000000 lamports (0.1 SOL) ([tx 3UvgCpAM…](https://solscan.io/tx/3UvgCpAM1mP6bzvM5XQtZnt9E8GT9UKdZWrE8P2nABsvVfBEJNe1FFoHNa6JwqX2p4i6GCAin79NVSsHdzdi1hAC?cluster=devnet)); coin token accounts of the bot and the vault created ([tx Tm7E32Lz…](https://solscan.io/tx/Tm7E32LzwfpbjCTMPwk6jL4VQE59AzXoHHG6gH7Wa48sK33etdDg5sf2iv6NTdkzXNZaCQzuB33hApesfZX9k77?cluster=devnet))
- Job settings: cap 40000000 lamports (0.04 SOL), 2 slices of 10000000 lamports (0.01 SOL) to 30000000 lamports (0.03 SOL), slippage 100 bps, price impact cap 100 bps, fee reserve 10000000 lamports (0.01 SOL), order fee allowance 100000 lamports (0.0001 SOL); mode live (FORGE_BUYBACK_DEVNET_TEST=true, BUYBACK_ROUTE=dbc-devnet)
## Run

| Step | Result | Transaction |
| --- | --- | --- |
| Spending-limit withdrawal (vault -> bot) | confirmed 5000 lamports (0.000005 SOL) | [tx YaywsFGA…](https://solscan.io/tx/YaywsFGAed2qQaCgxSQ5BnzLDA3axjb5QgxdEq2RM8vxVhvimGuVK9Diy61tUoHeTjq8JkdAK7ByKVBLrYcEonA?cluster=devnet) |
| Slice 1 buy (DBC pool, core buildBuyTx) | swapped 20000000 lamports (0.02 SOL) | [tx 66ik5sCt…](https://solscan.io/tx/66ik5sCtvxg7ikNJYZqEcsMQZVjaRBcDMT9hSxZ9tFMy1HfU1JKBeY3WwoycHsn7Sq2yBTyMEX6wPTgbMGKuoWoK?cluster=devnet) |
| Return 1 (bot -> vault token account) | returned 6298585880372 raw units | [tx 677JJt9v…](https://solscan.io/tx/677JJt9v6qVHFFNVqeGvyGNdYVNCdbE1GoimhbwbzSZquk6VdY3V5g5GZiyhpDRsyQ7EiivstpNhHUBogNL6updu?cluster=devnet) |
| Slice 2 buy | swapped 20000000 lamports (0.02 SOL) | [tx 5oGpKrzG…](https://solscan.io/tx/5oGpKrzGSQAoPkcHc5upvSZHeWH9PKWamme8XZdV8iRqMt2jtTaTkRTcDosZdQjUmDiwreDqFdnP23xid3hPDBSu?cluster=devnet) |
| Return 2 | returned 6224637194559 raw units | [tx 65espg48…](https://solscan.io/tx/65espg48GjGNwfR3FGH7iVd4mCajBREqXABMGtm2ABgusMdqB3oe7ACwwV7DnMcZQbjDVKARuiaK4HbEKFsikyAQ?cluster=devnet) |
| Next run | idle | - |

## Balances

| Account | Before | After |
| --- | --- | --- |
| Vault SOL | 79795000 lamports (0.079795 SOL) | 79790000 lamports (0.07979 SOL) |
| Vault coin account | 0 | 12523223074931 |
| Bot SOL | 50195000 lamports (0.050195 SOL) | 10055000 lamports (0.010055 SOL) |
| Bot coin account | 0 | 0 |

## Checks

- PASS — funding confirmed through the spending limit
- PASS — first slice bought
- PASS — first return landed
- PASS — second slice bought
- PASS — second return landed
- PASS — no third order
- PASS — vault SOL dropped by exactly the withdrawal
- PASS — vault received every bought coin
- PASS — bot keeps no coin
- PASS — bot keeps its fee reserve
- PASS — every signature announced to the watcher first
- PASS — no alert
**Result: PASS** — the vault funded the bot through its spending limit, the bot bought in two slices and every coin landed in the vault

