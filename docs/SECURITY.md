# SECURITY — menaces et protections

Chaque protection ci-dessous est **obligatoire** dans le MVP. Les agents qui touchent à une de ces zones doivent l'implémenter et la tester.

## 1. Site client piégé par l'agent

**Menace** : un client demande à l'agent d'ajouter une demande d'approbation de tokens, de remplacer nos adresses de frais, ou d'injecter un script externe. Le site devient un site de phishing hébergé par nous.

**Protections** (agent 4, avec agent 2 pour la structure du template) :
- `@forge/core` installé depuis le registre privé à version épinglée. Le scan refuse tout changement de `package.json` sur cette dépendance, tout `patch-package`, tout fichier dans `node_modules`.
- Le template sépare clairement `src/forge/` (intouchable, branché sur `@forge/core`) du reste (design, pages, contenus).
- **Scan bloquant avant chaque push** :
  - aucune modification sous `src/forge/`, `forge.config.json#onchain`, `next.config.*` (headers de sécurité), `package.json#dependencies['@forge/core']` ;
  - aucune chaîne base58 de 32 à 44 caractères ajoutée (adresse Solana) ;
  - aucun `<script src=` externe, aucun `fetch`/`import` vers un domaine hors liste blanche ;
  - aucun usage de `approve`, `setAuthority`, `createApproveInstruction`, `signAllTransactions` hors `src/forge/` ;
  - aucun `eval`, `new Function`, `dangerouslySetInnerHTML` avec contenu dynamique.
- Content-Security-Policy stricte dans le template (domaines Jupiter, Helius via relais, R2, Vercel).
- Aperçu validé par le client avant toute mise en production.

## 2. Clé API Anthropic exposée

**Protections** (agent 4) : la vraie clé reste sur la machine hôte, dans la passerelle. Le conteneur reçoit `ANTHROPIC_BASE_URL` (passerelle) + `ANTHROPIC_AUTH_TOKEN` (jeton temporaire, budget `OPS.agentBudgetUsdPerJob`, expire à la fin du job). Limite de dépense mensuelle aussi fixée dans la console Anthropic.

## 3. Accès GitHub de l'agent

**Protections** (agent 4) : GitHub App de l'organisation ; jeton d'installation temporaire, limité au seul repo du client, permissions `contents:write` uniquement. Aucun accès au monorepo FORGE.

## 4. Sortie réseau de la sandbox

**Protections** (agent 4) : réseau Docker avec liste blanche de sortie : passerelle IA, `github.com`, `registry.npmjs.org`, `npm.pkg.github.com`. Tout le reste est refusé. Pas de montage de dossier de l'hôte hors du dossier de travail du job.

## 5. Vol d'une clé de wallet créateur

**Menace** : le rôle créateur d'un pool est **transférable** (`transferPoolCreator`). Une clé volée = toute la part créateur détournée pour toujours.

**Protections** (agent 5) :
- Un wallet créateur par launchpad, clés chiffrées au repos (`SIGNER_KEYSTORE_PASSPHRASE`), uniquement sur le VPS 2.
- Le signer ne fait jamais `transferPoolCreator`. Une surveillance on-chain alerte immédiatement (Telegram) si un transfert de créateur apparaît sur un de nos pools.
- Les wallets créateurs ne gardent que de quoi payer les frais de transaction ; tout ce qui est réclamé part direct au multisig.

## 6. Signer appelé par n'importe qui

**Protections** (agent 5) : API accessible uniquement depuis l'IP du VPS 1 (pare-feu), requêtes signées HMAC avec horodatage, et le signer **relit tout dans Supabase** (job, spec, paiement confirmé) au lieu de faire confiance au corps de la requête.

## 7. Trésorerie vidée

**Protections** : multisig Squads, au moins 2 signatures sur 3 (à confirmer avec l'équipe). Le bot de buyback n'a qu'une limite de dépense quotidienne vers son propre wallet.

## 8. Buyback devancé par les bots (MEV)

**Protections** (agent 5) : petits montants, moments aléatoires, slippage plafonné (1 %), jamais de montant prévisible.

## 9. Abus de l'agent et des coûts

**Protections** : quota de modifs, paiement avant chaque job, budget et timeout par job (`OPS`), limite de débit sur le chat de conception.

## 10. Paiement truqué

**Protections** (agent 3) : `POST /api/payments/confirm` vérifie on-chain la transaction : signataire = wallet de la session, destinataire = caisse, montant ≥ devis, devis non expiré, signature jamais utilisée.

## 11. Relais RPC abusé

**Protections** (agent 3) : liste blanche de méthodes JSON-RPC, limite de débit par IP, taille de requête bornée.

## 12. Launchpads d'arnaque

**Protections** : conditions d'utilisation ; drapeau `disabled` par launchpad qui coupe le site (on l'héberge) ; le coin reste on-chain mais le site disparaît.
