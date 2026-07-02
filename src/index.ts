/**
 * WhatsApp Bridge — Serveur Express + Socket.io
 *
 * Expose :
 *   POST /send-message  → envoyer un message WhatsApp (protégé par clé API)
 *   GET  /status        → état de la connexion (protégé par clé API)
 *   DELETE /logout      → déconnecter et réinitialiser la session (protégé par clé API)
 *
 * Socket.io :
 *   qr            → image base64 du QR code (client doit la scanner)
 *   ready         → connexion établie
 *   logged_out    → session expirée
 *   status_update → état courant de la connexion
 *   new_message   → message WhatsApp entrant reçu
 *
 * Variables d'environnement (.env) :
 *   PORT             Port d'écoute (défaut : 3005)
 *   NODE_ENV         local | production
 *   CORS_ORIGIN      Origines autorisées (* en local, URL exacte en prod)
 *   BRIDGE_API_KEY   Clé secrète partagée avec le backend (OBLIGATOIRE en prod)
 *   ENABLE_DASHBOARD true pour servir public/ (dashboard QR) — false par défaut en prod
 */

import express           from 'express'
import { createServer }  from 'http'
import { Server }        from 'socket.io'
import cors              from 'cors'
import dotenv            from 'dotenv'
import qrcode            from 'qrcode'
import { WhatsAppManager } from './whatsapp.js'

dotenv.config()

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT            = Number(process.env['PORT'] ?? 3005)
const CORS_ORIGIN     = process.env['CORS_ORIGIN'] ?? '*'
const IS_PROD         = process.env['NODE_ENV'] === 'production'
const BRIDGE_API_KEY  = (process.env['BRIDGE_API_KEY'] ?? '').trim()
const ENABLE_DASHBOARD = process.env['ENABLE_DASHBOARD'] === 'true'

// ─── Validation de la configuration au démarrage ─────────────────────────────

if (IS_PROD && !BRIDGE_API_KEY) {
    console.error('[Security] ❌ BRIDGE_API_KEY est obligatoire en production. Arrêt.')
    process.exit(1)
}

if (!IS_PROD && !BRIDGE_API_KEY) {
    console.warn('[Security] ⚠️  BRIDGE_API_KEY non définie — API non protégée (mode local uniquement)')
}

if (IS_PROD && CORS_ORIGIN === '*') {
    console.warn('[Security] ⚠️  CORS_ORIGIN=* en production — vous devriez restreindre à votre domaine')
}

// ─── Serveur Express + Socket.io ─────────────────────────────────────────────

const app        = express()
const httpServer = createServer(app)
const io         = new Server(httpServer, {
    cors: { origin: CORS_ORIGIN },
    // Limite la taille des messages Socket.io (protection DoS basique)
    maxHttpBufferSize: 1e5, // 100 KB
})

// ─── Middlewares globaux ──────────────────────────────────────────────────────

app.use(cors({ origin: CORS_ORIGIN }))

// Limite la taille des corps JSON (protection contre les payloads surdimensionnés)
app.use(express.json({ limit: '10kb' }))

// Supprime le header X-Powered-By pour ne pas révéler Express
app.disable('x-powered-by')

// Dashboard HTML — désactivé en production sauf si explicitement activé
if (!IS_PROD || ENABLE_DASHBOARD) {
    app.use(express.static('public'))
    console.log('[Dashboard] Interface disponible sur http://127.0.0.1:' + PORT)
}

// ─── Middleware : authentification par clé API ────────────────────────────────

const requireApiKey: express.RequestHandler = (_req, res, next) => {
    // Mode local sans clé définie → on laisse passer avec avertissement
    if (!BRIDGE_API_KEY) {
        next()
        return
    }

    const provided = (_req.headers['x-api-key'] as string | undefined)?.trim()

    if (!provided) {
        res.status(401).json({ success: false, error: 'Header X-Api-Key manquant' })
        return
    }

    // Comparaison à temps constant pour éviter les timing attacks
    if (!timingSafeEqual(provided, BRIDGE_API_KEY)) {
        res.status(401).json({ success: false, error: 'Clé API invalide' })
        return
    }

    next()
}

/**
 * Compare deux chaînes en temps constant.
 * Évite qu'un attaquant déduise la clé par mesure de temps de réponse.
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    return diff === 0
}

// ─── Rate limiting simple (protection contre le spam) ────────────────────────
// Compteur en mémoire — suffit pour un usage mono-instance

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX      = 30   // requêtes max
const RATE_LIMIT_WINDOW   = 60_000 // par fenêtre de 60 secondes

const rateLimit: express.RequestHandler = (req, res, next) => {
    const ip  = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
              ?? req.socket.remoteAddress
              ?? 'unknown'
    const now = Date.now()

    const entry = rateLimitMap.get(ip)

    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
        next()
        return
    }

    if (entry.count >= RATE_LIMIT_MAX) {
        res.status(429).json({ success: false, error: 'Trop de requêtes — réessayez dans un moment' })
        return
    }

    entry.count++
    next()
}

// Nettoyage périodique du Map pour éviter les fuites mémoire
setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetAt) rateLimitMap.delete(ip)
    }
}, 5 * 60_000)

// ─── WhatsApp Manager ─────────────────────────────────────────────────────────

const waManager = new WhatsAppManager()

// ─── REST : POST /send-message ────────────────────────────────────────────────

app.post('/send-message', rateLimit, requireApiKey, async (req, res) => {
    const { to, text } = req.body as { to?: unknown; text?: unknown }

    // Validation stricte des types
    if (typeof to !== 'string' || typeof text !== 'string') {
        res.status(400).json({ success: false, error: 'Paramètres invalides : to et text doivent être des chaînes' })
        return
    }

    const toTrimmed   = to.trim()
    const textTrimmed = text.trim()

    if (!toTrimmed || !textTrimmed) {
        res.status(400).json({ success: false, error: 'Paramètres manquants : to et text sont requis' })
        return
    }

    // Limite la longueur du message pour éviter les abus
    if (textTrimmed.length > 4096) {
        res.status(400).json({ success: false, error: 'Message trop long (max 4096 caractères)' })
        return
    }

    // Validation basique du format numéro (que des chiffres, +, espaces)
    if (!/^[+\d\s]+$/.test(toTrimmed)) {
        res.status(400).json({ success: false, error: 'Format de numéro invalide' })
        return
    }

    console.log(`[Bridge] Demande d'envoi vers : ${toTrimmed.substring(0, 8)}...`)

    try {
        // Nettoyage du numéro : supprime +, espaces, tirets
        const cleanTo = toTrimmed.replace(/[+\s\-]/g, '')
        const jid     = cleanTo.includes('@s.whatsapp.net')
            ? cleanTo
            : `${cleanTo}@s.whatsapp.net`

        const sock = waManager.getSocket()
        if (!sock) {
            res.status(503).json({ success: false, error: 'Service WhatsApp non initialisé' })
            return
        }

        // Vérifier si le numéro est sur WhatsApp
        const waResults = await sock.onWhatsApp(jid)
        const result    = waResults?.[0]

        // ── Fallback numéros béninois ────────────────────────────────────────
        if (!result?.exists) {
            // Nouveau format béninois (22901XXXXXXXX) → ancien (229XXXXXXXX)
            if (cleanTo.startsWith('22901') && cleanTo.length === 13) {
                const fallbackJid = `229${cleanTo.substring(5)}@s.whatsapp.net`
                const fbResults1  = await sock.onWhatsApp(fallbackJid)
                const fb1         = fbResults1?.[0]
                if (fb1?.exists) {
                    await waManager.sendMessage(fb1.jid, textTrimmed)
                    res.json({ success: true })
                    return
                }
            }

            // Ancien format béninois (229XXXXXXXX) → nouveau (22901XXXXXXXX)
            if (cleanTo.startsWith('229') && !cleanTo.startsWith('22901') && cleanTo.length === 11) {
                const fallbackJid = `22901${cleanTo.substring(3)}@s.whatsapp.net`
                const fbResults2  = await sock.onWhatsApp(fallbackJid)
                const fb2         = fbResults2?.[0]
                if (fb2?.exists) {
                    await waManager.sendMessage(fb2.jid, textTrimmed)
                    res.json({ success: true })
                    return
                }
            }

            res.status(404).json({ success: false, error: 'Numéro non enregistré sur WhatsApp' })
            return
        }

        await waManager.sendMessage(result.jid, textTrimmed)
        res.json({ success: true })

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Erreur interne'
        // Ne pas exposer les détails internes en production
        console.error('[Bridge] Erreur envoi :', error)
        res.status(500).json({
            success: false,
            error: IS_PROD ? 'Erreur lors de l\'envoi du message' : message,
        })
    }
})

// ─── REST : GET /status ───────────────────────────────────────────────────────

app.get('/status', requireApiKey, (_req, res) => {
    res.json(waManager.getStatus())
})

// ─── REST : DELETE /logout ────────────────────────────────────────────────────

app.delete('/logout', requireApiKey, async (_req, res) => {
    try {
        await waManager.logout()
        res.json({ success: true, message: 'Session supprimée — QR code requis au prochain démarrage' })
    } catch (error: unknown) {
        console.error('[Bridge] Erreur logout :', error)
        res.status(500).json({ success: false, error: 'Erreur lors de la déconnexion' })
    }
})

// ─── Route fallback — 404 propre ──────────────────────────────────────────────

app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'Route introuvable' })
})

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log(`[Socket.io] Client connecté : ${socket.id}`)

    // Envoyer l'état immédiatement à la connexion
    socket.emit('status_update', waManager.getStatus())

    // ── Gestionnaires d'événements WhatsApp → ce client Socket.io ─────────────
    // IMPORTANT : on stocke les références pour pouvoir les retirer à la déconnexion
    // (évite la fuite d'écouteurs EventEmitter identifiée précédemment)

    const onQr = async (qr: string) => {
        try {
            const qrImage = await qrcode.toDataURL(qr)
            socket.emit('qr', qrImage)
        } catch (e) {
            console.error('[Socket.io] Erreur génération QR :', e)
        }
    }

    const onReady = () => {
        const status = waManager.getStatus()
        socket.emit('ready', status)
        io.emit('status_update', status)
    }

    const onLoggedOut = () => {
        const status = waManager.getStatus()
        io.emit('status_update', status)
        io.emit('logged_out', {})
    }

    const onMessage = (m: unknown) => {
        socket.emit('new_message', m)
    }

    waManager.on('qr',         onQr)
    waManager.on('ready',      onReady)
    waManager.on('logged_out', onLoggedOut)
    waManager.on('message',    onMessage)

    // Nettoyage à la déconnexion du client — CORRIGE la fuite d'écouteurs
    socket.on('disconnect', () => {
        console.log(`[Socket.io] Client déconnecté : ${socket.id}`)
        waManager.off('qr',         onQr)
        waManager.off('ready',      onReady)
        waManager.off('logged_out', onLoggedOut)
        waManager.off('message',    onMessage)
    })
})

// ─── Gestion des erreurs non catchées ─────────────────────────────────────────

process.on('uncaughtException', (err) => {
    console.error('[Process] Exception non catchée :', err)
    // Ne pas quitter — le service doit rester opérationnel
})

process.on('unhandledRejection', (reason) => {
    console.error('[Process] Promise rejetée non gérée :', reason)
})

// ─── Démarrage ────────────────────────────────────────────────────────────────

httpServer.listen(PORT, '127.0.0.1', async () => {
    console.log('')
    console.log('╔══════════════════════════════════════════════════╗')
    console.log(`║  WhatsApp Bridge   http://127.0.0.1:${PORT}         ║`)
    console.log(`║  Environnement : ${IS_PROD ? 'production  ' : 'local       '}              ║`)
    console.log(`║  API Key        : ${BRIDGE_API_KEY ? '✅ configurée  ' : '⚠️  non définie'}           ║`)
    console.log(`║  Dashboard      : ${(!IS_PROD || ENABLE_DASHBOARD) ? '✅ activé      ' : '🔒 désactivé   '}           ║`)
    console.log('╚══════════════════════════════════════════════════╝')
    console.log('')
    await waManager.init()
})
