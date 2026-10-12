/**
 * LOCKED FILE (owned by FORGE, refused by the builder scan). Route `/creator-fees` of every live
 * site: the creator fee claim page, which lives in the locked zone (`@/forge/pages/CreatorFeesPage`).
 * Free-zone pages may link to this route. When the site is sleeping or disabled, the mode gate in
 * `_app` renders the mode page instead, as for every route.
 */
export { default } from '@/forge/pages/CreatorFeesPage';
