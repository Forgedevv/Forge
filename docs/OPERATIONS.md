# OPERATIONS — faire tourner FORGE au quotidien

## Alertes (Telegram, groupe de l'équipe)

Envoyées par `apps/signer` et `apps/builder` via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

| Alerte | Source | Urgence |
|---|---|---|
| Transfert du rôle créateur sur un de nos pools | signer (surveillance on-chain) | immédiate |
| Sortie inattendue du multisig ou de la caisse | signer | immédiate |
| Solde du wallet payeur ou de la caisse trop bas | signer | haute |
| Job en échec deux fois, remboursement déclenché | signer | normale |
| Déploiement bloqué par le scan | builder | normale (peut être une tentative d'abus) |
| Budget API journalier dépassé à 80 % | builder (passerelle) | haute |
| Frais créateur non réclamés depuis plus de 48 h | signer | normale |
| Erreurs RPC répétées | signer, builder | haute |

## Coupe-circuits (table `flags` dans Supabase)

| Flag | Effet |
|---|---|
| `signups_paused` | `apps/web` refuse les nouvelles créations (les clients existants continuent) |
| `deploys_paused` | le builder ne prend plus de job |
| `buyback_paused` | le bot de buyback s'arrête |
| `launchpads.status = 'disabled'` | le site du launchpad affiche une page de maintenance |

Chaque service relit les flags au moins toutes les minutes.

## Tâches automatiques

| Tâche | Fréquence | Service |
|---|---|---|
| Réclamer la part créateur de chaque pool vers le multisig | toutes les 24 h | signer |
| Transférer l'excédent de la caisse vers le multisig | toutes les 24 h | signer |
| Buyback de $FORGE | plusieurs petits achats par jour, moments aléatoires | signer |
| Convertir en SOL les frais Jupiter reçus dans d'autres monnaies | toutes les 24 h | signer |
| Mettre en veille les launchpads sans trade depuis 30 jours | toutes les 24 h | builder |
| Rejouer les tests devnet (référence, part créateur) | chaque semaine | CI ou VPS 1 |

## Mise en veille

Un launchpad sans trade depuis 30 jours passe en `sleeping` : le builder remplace le déploiement par une page statique légère (pas de RPC, pas de données Jupiter). Le coin reste tradable sur Meteora et Jupiter. Le client peut le réactiver depuis son tableau de bord.

## Support

- Conditions d'utilisation : FORGE fournit l'outil, le client opère son launchpad. FORGE peut désactiver un site signalé.
- Un seul canal pour les incidents (à définir par l'équipe).
- FAQ : comment réclamer ses frais, pourquoi le coin n'apparaît pas encore, que faire si la création échoue.

## Coûts à surveiller chaque semaine

API Anthropic (console), Helius (crédits), Vercel (minutes de build, bande passante), Supabase (taille de base), Jupiter (limites de requêtes).
