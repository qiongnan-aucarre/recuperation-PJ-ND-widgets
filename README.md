# Widgets Grist – PJ Démarche Numérique

Widgets personnalisés Grist (fichiers statiques publiés avec GitHub Pages) pour le projet d’import des pièces jointes de Démarche Numérique vers Grist.

Le script d’import et son workflow GitHub Actions se trouvent dans un **dépôt privé** distinct. Ce dépôt public ne contient **aucun secret** : ni jeton, ni clé API, ni fichier `.env`.

## Widgets

| Widget | Dossier | Rôle | Accès Grist |
|---|---|---|---|
| Importer PJ | [`recuperer-pj/`](./recuperer-pj/) | Bouton qui déclenche le workflow `import.yml` du dépôt privé (`workflow_dispatch`), suit le run et affiche les compteurs et la durée. | Aucun accès aux données requis |
| Prévisualiser les PJ | [`visualiser-pj/`](./visualiser-pj/) | Affiche les images et PDF de la cellule `PJ` de la ligne sélectionnée. | Lecture de la table |

Le dépôt et le workflow ciblés sont définis dans `SETTINGS` en haut de [`recuperer-pj/widget.js`](./recuperer-pj/widget.js) (`owner`, `repository`, `workflow`, `ref`). Mettez-les à jour si le dépôt privé ou le fichier de workflow est renommé.

## Publication (GitHub Pages)

1. **Settings › Pages** : *Source* = *Deploy from a branch*, branche `main`, dossier `/ (root)`.
2. Les widgets sont alors disponibles à :
   - `https://<compte>.github.io/<ce-depot>/recuperer-pj/`
   - `https://<compte>.github.io/<ce-depot>/visualiser-pj/`

## Installation dans Grist

1. Ajouter un widget : **Personnalisé** › **URL personnalisée**, puis coller l’URL ci-dessus.
2. **Importer PJ** : ouvrir les **Options du widget** (menu du widget), saisir le jeton GitHub, enregistrer.
3. **Prévisualiser les PJ** : connecter le widget à la table `PJ_Dossiers`, autoriser la lecture de la table et activer le suivi de la ligne sélectionnée.

## Jeton GitHub

- Créer un jeton **fine-grained** limité au **seul dépôt privé** du script, avec la permission **Actions : Read and write** uniquement et une **date d’expiration**.
- Le jeton est conservé dans les options du widget Grist, **pas dans un coffre-fort de secrets** : toute personne pouvant modifier le document peut potentiellement le lire. Réservez ce document aux personnes de confiance.
- Ne jamais écrire de jeton dans ce dépôt (code, exemples, issues, commits).

## Tests

```bash
node --test recuperer-pj/widget.test.cjs visualiser-pj/widget.test.cjs
```

Les tests utilisent des réponses simulées et n’appellent jamais GitHub ni Grist. Ils sont aussi lancés par [`.github/workflows/tests.yml`](./.github/workflows/tests.yml).
