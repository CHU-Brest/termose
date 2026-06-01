# Termose

Termose est un moteur de recherche dans l'**arborescence des terminologies
médicales** issues du [Serveur Multi-Terminologique (SMT)](https://smt.esante.gouv.fr/)
de l'Agence du Numérique en Santé : **CIM-10**, **CCAM**, **ADICAP** et **ATC**.

On y navigue dans la hiérarchie des concepts et on les recherche en plein texte
(par libellé, synonyme ou code), le tout entièrement dans le navigateur, sans
serveur.

## Fonctionnement

Pour des raisons de licence, les terminologies ne sont pas redistribuées : elles
sont **téléchargées depuis [data.gouv.fr](https://www.data.gouv.fr/datasets/terminologie-medicale-au-format-parquet)
au format Parquet**, et une **base DuckDB est construite côté client**,
directement dans le navigateur.

La base est ensuite conservée localement (OPFS), si bien que la génération n'a
lieu qu'une seule fois ; les visites suivantes rouvrent la base existante.
