// config.js — configuration de déploiement.
//
// Pour distribuer une base DuckDB déjà construite (ex. déploiement sur un GitLab
// local), déposez le fichier `termose.duckdb` à côté de `index.html` — l'URL
// relative par défaut le récupère sans configuration ni souci CORS (même origine).
// Sinon, pointez DEFAULT_DB_URL vers l'URL où la base est hébergée. L'utilisateur
// peut de toute façon éditer cette URL dans le dialogue de génération.
export const DEFAULT_DB_URL = "./termose.duckdb";
