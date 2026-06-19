-# whatsapp-service

Micro-service bridge WhatsApp pour le projet CAP-EPAC.

Expose une API REST + Socket.io utilisée par `backend-modules` via `WhatsAppBridgeClient`.

---

## Architecture

```
backend-modules (Laravel)
    └── WhatsAppBridgeClient
            └── POST http://127.0.0.1:3005/send-message
                        ↓
                whatsapp-service (Node.js / Express)
                        └── @whiskeysockets/baileys  ←── LOCAL (../Baileys)
                                    └── WhatsApp Web (WebSocket)
```

## Première installation

> Prérequis : Node.js ≥ 20, yarn installé globalement (`npm install -g yarn`)

```bash
# 1. Builder Baileys local et installer les dépendances
npm run setup
```

Cette commande :
1. Se déplace dans `../Baileys`, installe ses dépendances yarn, puis le build TypeScript
2. Revient dans ce dossier et installe les dépendances (dont `@whiskeysockets/baileys` pointé sur `file:../Baileys`)

## Démarrage

```bash
# Développement (avec hot-reload tsx)
npm run dev

# Production (après npm run build)
npm run build
npm start
```

## Endpoints

| Méthode | Route | Description |
|---------|-------|-------------|
| `POST` | `/send-message` | Envoyer un message WhatsApp |
| `GET` | `/status` | État de la connexion |
| `DELETE` | `/logout` | Déconnecter et supprimer la session |

### POST /send-message

```json
{
  "to": "22997123456",
  "text": "Votre message ici"
}
```

Réponse succès :
```json
{ "success": true, "message": "Message envoyé" }
```

Formats de numéros acceptés (normalisation béninoise gérée côté backend) :
- `22997123456` (ancien format 229)
- `22901XXXXXXXX` (nouveau format 22901)
- `97123456` (8 chiffres — le backend ajoute +229 avant)

### GET /status

```json
{ "status": "connected", "user": { "id": "229...", "name": "CAP-EPAC" } }
```
ou
```json
{ "status": "disconnected" }
```

## Socket.io

Connexion : `http://127.0.0.1:3005`

| Événement | Direction | Données |
|-----------|-----------|---------|
| `qr` | serveur → client | `string` (base64 PNG du QR) |
| `ready` | serveur → client | objet statut connexion |
| `logged_out` | serveur → client | `{}` |
| `status_update` | serveur → client | objet statut connexion |
| `new_message` | serveur → client | message Baileys |

## Configuration (.env)

```env
PORT=3005          # Doit correspondre à WHATSAPP_BRIDGE_URL dans backend-modules/.env
NODE_ENV=local     # local | production
CORS_ORIGIN=*      # * pour local, votre domaine en production
```

## Lien avec le backend

Dans `backend-modules/.env` :
```env
WHATSAPP_BRIDGE_URL=http://127.0.0.1:3005
WHATSAPP_BRIDGE_TIMEOUT=30
```

Le `WhatsAppBridgeClient` PHP utilise `cURL` avec `CURL_IPRESOLVE_V4` pour forcer IPv4
et éviter les problèmes loopback Windows.

## Remarques

- La session WhatsApp est persistée dans `./auth/primary-session/`
- Supprimer ce dossier force un nouveau scan QR
- Un échec d'envoi WhatsApp ne bloque **jamais** le workflow Laravel — erreur silencieuse
- Baileys utilise `../Baileys` (dossier local) — aucune dépendance réseau au démarrage
