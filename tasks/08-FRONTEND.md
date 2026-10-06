# 08 — FRONTEND (agent 6)

**Tu possèdes** : dans `apps/web` : `app/**` hors `app/api/**`, `src/ui/**`, `public/**`, styles globaux et config Tailwind. Dans `apps/launchpad-template` : `src/theme/**`, `src/content/**`, `src/components/**`, mise en page de `src/pages/**`.
**Tu lis** : tout le dossier `docs/frontend/` (il se suffit à lui-même), puis `PLANEXECUTE.md`.

Tu fais toute l'interface du site FORGE et le design de base des sites clients, sans aucune logique d'argent. Le détail (périmètre, écrans, contrat avec le backend, mocks, définition de terminé) est dans `docs/frontend/README.md`.

## Étapes

- [ ] Système de design `apps/web/src/ui/` (tokens en variables CSS, composants de base, mode sombre/clair).
- [ ] Mocks de `docs/frontend/CONTRACT.md` dans `src/ui/mocks/` + page `/dev/states`.
- [ ] Écrans A1 à A11 de `docs/frontend/SCREENS.md`, dans tous leurs états.
- [ ] Design de base du template (B1 à B7), entièrement piloté par les variables du thème ; `src/theme/README.md`.
- [ ] Bascule des mocks vers le vrai `src/client/` quand l'agent 3 l'a livré (changement d'import uniquement).
- [ ] Tests de composants listés dans `docs/frontend/README.md`.

## Dépendances

Agent 3 (`src/client/`), agent 2 (composants de `src/forge/` et `SiteConfig`). En attendant : mocks aux mêmes signatures.

## Rapport

_À remplir en fin de tâche._
