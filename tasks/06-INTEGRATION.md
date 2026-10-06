# 06 — LEAD : squelette, contrats, intégration

**Tu possèdes** : fichiers racine, `packages/shared`, `docs/`.
**Tu lis** : tout.

Tu es la session qui démarre avant les autres et qui assemble à la fin.

## Phase 0 — avant de lancer les agents (environ 1 h)

- [ ] Monorepo : pnpm workspaces, Turborepo, TypeScript strict partagé (`tsconfig.base.json`), ESLint + Prettier, vitest, `.gitignore` (`.env*`, `.state/`, `node_modules`).
- [ ] Dossiers vides avec `package.json` minimal : `packages/shared`, `packages/core`, `apps/web`, `apps/launchpad-template`, `apps/builder`, `apps/signer`, `scripts/devnet-tests`, `supabase`.
- [ ] `packages/shared` : traduire `docs/INTERFACES.md` en code (constantes §1, `LaunchpadSpec` §2, `forge.config.json` §3, statuts §4, types des routes §6 et §7, types du client navigateur de `docs/frontend/CONTRACT.md` dans `web-client.ts`). Tests de validation zod.
- [ ] Scripts racine : `pnpm typecheck`, `pnpm test`, `pnpm build` (Turborepo).
- [ ] `docs/CHANGE_REQUESTS.md` vide avec un modèle d'entrée.
- [ ] Commit sur `main`, puis création des worktrees (voir `KICKOFF.md`).

## Pendant le build

- [ ] Au moins deux fois par jour : lire `docs/CHANGE_REQUESTS.md`, trancher, mettre à jour `packages/shared` et `docs/`, prévenir les agents concernés.
- [ ] Fusionner les branches des agents dans `main` quand leurs tests passent ; résoudre les conflits.
- [ ] Reporter les résultats des tests devnet dans `docs/DECISIONS.md`.

## Phase d'intégration (devnet)

- [ ] Brancher les vraies briques à la place des mocks : web ↔ Supabase ↔ builder ↔ signer ↔ core.
- [ ] Parcours complet sur devnet, avec le faux $FORGE :
  1. un wallet "Hugo" détient le faux $FORGE, se connecte, discute, confirme la spec ;
  2. paie (devis en SOL devnet) ;
  3. le builder crée le repo, l'agent code, le scan passe, l'aperçu s'affiche ;
  4. Hugo valide, le signer crée les configs, prépare le lancement ;
  5. Hugo signe, $MOON est créé, Hugo reçoit ses tokens ;
  6. des trades via `@forge/core` (scripts, car l'interface Jupiter n'existe pas sur devnet) ;
  7. la référence et le frais plateforme arrivent sur les comptes de test ; le signer réclame la part créateur vers le vault de test ;
  8. Hugo réclame ses frais partenaire depuis le tableau de bord ;
  9. un job forcé en échec deux fois est remboursé.
- [ ] Tester les coupe-circuits (`deploys_paused`, `buyback_paused`, `signups_paused`, `disabled`).
- [ ] Tester le scan avec une demande de modif malveillante dans le chat.
- [ ] Rédiger `docs/INTEGRATION_REPORT.md` : ce qui marche, ce qui casse, ce qu'il faut corriger avant le mainnet.

## Rapport

_À remplir en fin de phase._
