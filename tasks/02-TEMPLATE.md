# 02 — TEMPLATE (agent 2)

**Tu possèdes** : `apps/launchpad-template`.
**Tu lis** : `PLANEXECUTE.md`, `docs/METEORA.md` (sections template, Jupiter, frais plateforme), `docs/INTERFACES.md` (section 3, forge.config.json), `docs/SECURITY.md` (section 1), `docs/PRODUCT.md`.

Tu construis le site que chaque client reçoit. L'agent builder modifiera ensuite le design de chaque copie : ta structure doit rendre **impossible** de toucher à l'argent sans casser le scan.

## Point de départ

Copier `scaffolds/fun-launch` de https://github.com/MeteoraAg/meteora-invent dans `apps/launchpad-template` (garder la licence et l'attribution).

## Structure obligatoire

```
apps/launchpad-template/
├── forge.config.json            # généré par le builder (voir INTERFACES.md §3)
├── src/forge/                   # ZONE VERROUILLÉE : l'agent builder n'y touche jamais
│   ├── BuyButton.tsx            # achat/vente avant graduation via @forge/core
│   ├── JupiterTrade.tsx         # plugin Jupiter après graduation, avec frais intégrateur
│   ├── TradePanel.tsx           # choisit BuyButton ou JupiterTrade selon isGraduated
│   ├── ClaimCreatorFees.tsx     # réclamation des frais pour les créateurs de coins
│   ├── CreateCoin.tsx           # création de coin (reprend la logique fun-launch, config du launchpad)
│   ├── config.ts                # lit forge.config.json#onchain, valide avec zod
│   └── security-headers.ts      # CSP, utilisée par next.config
├── src/theme/                   # ZONE LIBRE : couleurs, polices, composants visuels
├── src/content/                 # ZONE LIBRE : textes, pages "à propos", FAQ
└── src/pages, src/components    # existant fun-launch, branché sur src/forge pour tout ce qui est argent
```

## À faire

- [ ] Remplacer le plugin Jupiter "toujours affiché" par `TradePanel` : `BuyButton` (`@forge/core`, référence + 30 bps) tant que le coin n'est pas gradué, `JupiterTrade` (plugin avec `referralAccount` = `FORGE_JUPITER_REFERRAL_ACCOUNT`, `referralFee` = 30) après.
- [ ] Afficher clairement le frais plateforme (0,3 %) et le total avant signature.
- [ ] `ClaimCreatorFees` : un créateur de coin connecté voit ses coins et réclame sa part créateur (`buildCreatorClaimTx` de core, receiver = son propre wallet). La réclamation des frais partenaire du client se fait sur le tableau de bord de `apps/web`, pas ici.
- [ ] `CreateCoin` : formulaire de création de coin sur la config du launchpad ; image et métadonnées via `/api/upload` (R2) existant ; premier achat avec `enableFirstSwapWithMinFee`.
- [ ] Données : garder les API Jupiter de fun-launch ; ajouter un plan B qui lit les coins on-chain (`listCoinsOfConfig` de core) si l'API Jupiter échoue.
- [ ] Thème : tout le visuel passe par `src/theme` (variables CSS depuis `forge.config.json#theme`). L'agent builder doit pouvoir changer le look sans toucher `src/forge`.
- [ ] `next.config` : headers de sécurité depuis `src/forge/security-headers.ts` (CSP avec liste blanche : Jupiter, R2, notre relais RPC, Vercel).
- [ ] Mode veille : si `forge.config.json` contient `"sleeping": true`, afficher une page statique légère.
- [ ] `@forge/core` en dépendance **épinglée exactement**, installé depuis le registre privé.
- [ ] `.env.example` complet.
- [ ] Script `pnpm template:publish` qui pousse le contenu vers le repo GitHub template `launchpad-template`.

## Tests

- [ ] Build OK avec un `forge.config.json` d'exemple.
- [ ] Tests de composants pour `TradePanel` (bascule avant/après graduation, avec mocks de core).
- [ ] Les tests d'interface réels se font sur mainnet en petits montants (étape 07) : Jupiter n'indexe pas devnet.

## Dépendances

`@forge/core` (agent 1) : en attendant sa publication, utiliser le paquet du workspace (`workspace:*`) et des mocks pour les fonctions pas encore prêtes.

## Rapport

_À remplir en fin de tâche._
