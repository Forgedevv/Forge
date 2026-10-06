# METEORA — ce qui est vérifié

Tout ce qui suit a été vérifié en lisant le code du SDK `@meteora-ag/dynamic-bonding-curve-sdk` **1.5.13**, le scaffold fun-launch de [Meteora Invent](https://github.com/MeteoraAg/meteora-invent), et les docs officielles. **Épingle la version 1.5.13** ; toute montée de version passe par les tests de `DEVNET_TESTS.md`.

## Fonctions du SDK à utiliser

| Besoin | Fonction | Notes |
|---|---|---|
| Créer une config | `createConfig(params)` | `feeClaimer` n'a **pas** besoin de signer ; seuls `config` (nouveau keypair) et `payer` signent |
| Construire la courbe | `buildCurveWithMarketCap`, `buildCurve`, `buildCurveWithTwoSegments`… | retournent un `ConfigParameters` complet |
| Créer un pool + premier achat | `createPoolWithFirstBuy({ createPoolParam, firstBuyParam })` | `createPoolParam.poolCreator` = wallet créateur FORGE ; `firstBuyParam.buyer` et `receiver` = wallet du client |
| Swap | `swap(params)` / `swap2(params)` | `referralTokenAccount` = notre compte de référence |
| Réclamer la part créateur | `claimCreatorTradingFeeToReceiver` / `claimCreatorTradingFee2` | `receiver` = multisig |
| Réclamer la part partenaire | `claimPartnerTradingFeeToReceiver` / `claimPartnerTradingFee2` | signée par le client |
| Lister les coins d'une config | `getPoolsByConfig(config)` | plan B si les données Jupiter tombent |
| Métriques de frais | `getPoolFeeMetrics`, `getPoolFeeBreakdown`, `getPoolsFeesByConfig` | pour le tableau de bord |
| Avancement de la courbe | `getPoolQuoteTokenCurveProgress` | pour savoir si un coin est gradué |
| Transférer le rôle créateur | `transferPoolCreator` | **danger** : voir SECURITY.md, alerte obligatoire |

Il n'existe **aucune instruction pour modifier une config** : une config est définitive.

## Champs de `ConfigParameters`

`poolFees`, `collectFeeMode`, `migrationOption`, `activationType`, `tokenType`, `tokenDecimal`, `partnerLiquidityPercentage`, `partnerPermanentLockedLiquidityPercentage`, `creatorLiquidityPercentage`, `creatorPermanentLockedLiquidityPercentage`, `migrationQuoteThreshold`, `sqrtStartPrice`, `lockedVesting`, `migrationFeeOption`, `tokenSupply`, `creatorTradingFeePercentage`, `tokenUpdateAuthority`, `migrationFee`, `migratedPoolFee`, `poolCreationFee`, `partnerLiquidityVestingInfo`, `creatorLiquidityVestingInfo`, `migratedPoolBaseFeeMode`, `migratedPoolMarketCapFeeSchedulerParams`, `enableFirstSwapWithMinFee`, `compoundingFeeBps`, `curve`.

## Bornes (constantes du SDK)

| Constante | Valeur | Sens |
|---|---|---|
| `MIN_FEE_BPS` / `MAX_FEE_BPS` | 25 / 9900 | frais de trading entre 0,25 % et 99 % (le haut sert à l'anti-sniper) |
| `MIN_MIGRATED_POOL_FEE_BPS` / `MAX_…` | 10 / 1000 | frais du pool après graduation entre 0,1 % et 10 % |
| `MIN_LOCKED_LIQUIDITY_BPS` | 1000 | au moins 10 % de liquidité bloquée après migration |
| `MIN_POOL_CREATION_FEE` / `MAX_…` | 1 000 000 / 100 000 000 000 lamports | frais de création d'un coin entre 0,001 et 100 SOL |
| `PROTOCOL_FEE_PERCENT` | 20 | part de Meteora |
| `HOST_FEE_PERCENT` | 20 | part de la référence, prise sur la part de Meteora |
| `MAX_PRICE_CHANGE_BPS_DEFAULT` | 1500 | |

Nos bornes à nous (plus strictes) sont dans `INTERFACES.md`, section 1.

## Réglages des deux configs

### Config du launchpad (tous les coins du client)
- `feeClaimer` = wallet du client ; `leftoverReceiver` = wallet du client.
- `creatorTradingFeePercentage` = `spec.coinCreatorSharePct`.
- Frais de trading = `spec.tradingFeeBps`, avec anti-sniper (frais dégressifs au lancement) si `spec.antiSniper`.
- `poolCreationFee` = `spec.poolCreationFeeSol` (versé au client).
- `migrationQuoteThreshold` = 10 SOL.
- `enableFirstSwapWithMinFee` = `true`, pour que le premier achat du créateur d'un coin ne paie pas le frais anti-sniper.
- `tokenUpdateAuthority` : métadonnées non modifiables (vérifier la valeur exacte de l'enum dans le SDK).

### Config du coin du launchpad (ex. $MOON)
- Mêmes réglages, sauf :
- `creatorTradingFeePercentage` = 25 (FORGE est créateur).
- `creatorLiquidityPercentage` / `creatorPermanentLockedLiquidityPercentage` : une part de la liquidité après graduation attribuée au créateur, **bloquée de façon permanente**, pour que FORGE continue de toucher des frais après graduation. Le partage exact est à valider au test 2.
- `enableFirstSwapWithMinFee` = `true` (premier achat d'Hugo).

## La référence Meteora

- Le swap accepte un `referralTokenAccount`. Le frais de référence = 20 % de la part du protocole, soustrait de la part de Meteora. La part partenaire et la part créateur ne bougent pas.
- Le compte de référence est un compte token de la monnaie de cotation (WSOL pour un pool en SOL), détenu par le multisig.
- **Uniquement quand le swap passe par notre propre code** (`@forge/core`). Quand le trade passe par Jupiter, c'est Jupiter qui touche la référence.

## Le frais plateforme (0,3 %)

- **Avant graduation** : instruction de transfert SOL de 0,3 % du montant ajoutée dans la transaction de swap construite par `@forge/core`, vers `FORGE_PLATFORM_FEE_WALLET`. À l'achat : 0,3 % du SOL dépensé. À la vente : 0,3 % du SOL attendu (calculé depuis le devis, avec la même tolérance que le slippage).
- **Après graduation** : impossible de modifier une transaction Jupiter. On utilise le **frais intégrateur Jupiter** (`referralAccount` + `referralFee` = 30 bps). Jupiter garde 20 % de ce frais. Il faut créer un compte de référence Jupiter et les comptes token pour chaque monnaie dans laquelle Jupiter peut prélever (au minimum SOL et USDC).

## Migration (graduation)

- Les robots de migration de Meteora sur mainnet n'acceptent que certains seuils : 10 SOL, 750 USDC, 1 500 JUP, ou au moins 750 $ de monnaie de cotation. On impose **10 SOL**.
- **Pas de robot sur devnet** : utiliser l'outil de migration manuelle de Meteora (Meteora Invent / Studio) pour tester la graduation.

## Le template fun-launch (constaté dans le code)

- Trading : **plugin Jupiter** (`plugin.jup.ag`), avec `referralAccount` / `referralFee` disponibles dans ses types.
- Données (liste des coins, prix, transactions, holders) : `https://datapi.jup.ag` et le flux `wss://trench-stream.jup.ag/ws`, filtrés par `NEXT_PUBLIC_POOL_CONFIG_KEY`. **API non documentée publiquement** : prévoir un plan B on-chain avec `getPoolsByConfig`.
- Création de coin : routes serveur `/api/upload` (image + métadonnées sur Cloudflare R2) et `/api/send-transaction`. La clé RPC reste côté serveur.
- Variables : `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `RPC_URL`, `POOL_CONFIG_KEY`.
- **Jupiter n'indexe pas devnet** : l'interface ne se teste que sur mainnet.

## Jupiter

- Clé API obligatoire (portail développeur Jupiter). Offre gratuite limitée à 1 requête par seconde.
- L'API Ultra est remplacée par Swap V2 : utiliser la version actuelle.
- Les transactions Jupiter ne peuvent pas être modifiées.
- Frais intégrateur : Jupiter en garde 20 %, et choisit la monnaie dans laquelle il prélève.

## Sources

- SDK : `npm pack @meteora-ag/dynamic-bonding-curve-sdk@1.5.13`, fichier `dist/index.d.ts`
- https://docs.meteora.ag/overview/products/dbc/what-is-dbc.md
- https://github.com/MeteoraAg/meteora-invent (scaffolds/fun-launch)
- https://developers.jup.ag/docs/ultra/add-fees-to-ultra
- https://developers.jup.ag/docs/ultra/get-started
